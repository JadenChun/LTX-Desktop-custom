"""REST endpoints for browsing MCP-created projects from the frontend."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Body, HTTPException, Request
from starlette.responses import StreamingResponse

router = APIRouter(prefix="/api/mcp", tags=["mcp-projects"])

# SSE client queues — each connected EventSource gets one
_sse_queues: set[asyncio.Queue[str]] = set()


if TYPE_CHECKING:
    from mcp_server.project_state import ProjectStore


def _get_store() -> ProjectStore:
    """Return the active ProjectStore (set by create_mcp_server at startup)."""
    from mcp_server.server import get_store
    return get_store()


@router.get("/projects")
async def list_mcp_projects() -> list[dict[str, Any]]:
    """List all MCP-created projects (summaries).

    Returns id, name, createdAt, updatedAt, assetCount, clipCount for each project.
    Used by the frontend to discover available MCP projects.
    """
    try:
        return _get_store().list_projects()
    except RuntimeError:
        # MCP server not initialised yet (e.g. during testing)
        return []


@router.get("/projects/{project_id}")
async def get_mcp_project(project_id: str) -> dict[str, Any]:
    """Return the full project JSON in frontend-compatible format.

    The returned JSON matches the Project TypeScript interface exactly, so the
    frontend can import it directly into localStorage without any transformation.
    """
    try:
        return _get_store().open_project(project_id).model_dump()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"MCP project not found: {project_id}")
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.delete("/projects/{project_id}")
async def delete_mcp_project(project_id: str) -> dict[str, str]:
    """Delete an MCP project."""
    try:
        _get_store().delete_project(project_id)
        return {"status": "deleted"}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"MCP project not found: {project_id}")
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.put("/projects/{project_id}")
async def put_mcp_project(
    project_id: str,
    request: Request,
    project_payload: dict[str, Any] = Body(...),
) -> Any:
    """Replace an MCP project's JSON with the provided state.

    This allows the frontend editor to persist its edits back into the MCP store,
    keeping the UI and MCP tools in sync.

    Supports optimistic concurrency via ``If-Match`` header. If the header is
    present, its value is compared against the stored project's ``updatedAt``.
    If the stored project is newer, returns 409 Conflict with the current state.
    """
    try:
        store = _get_store()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    from mcp_server.project_state import Project

    try:
        project = Project.model_validate(project_payload)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    if project.id != project_id:
        raise HTTPException(status_code=400, detail="Project id mismatch")

    # Optimistic concurrency check
    if_match = request.headers.get("if-match")
    if if_match:
        try:
            client_updated_at = int(if_match)
            current = store.peek_project(project_id)
            if current and current.updatedAt > client_updated_at:
                from starlette.responses import JSONResponse
                return JSONResponse(
                    status_code=409,
                    content=current.model_dump(),
                )
        except ValueError:
            pass  # Bad header — proceed with upsert

    # notify=False: frontend already has the latest state; no need to echo
    # the change back via SSE (which would cause an unnecessary re-fetch).
    saved = store.upsert_project(project, notify=False)
    return saved.model_dump()


# ── SSE (Server-Sent Events) ─────────────────────────────────────────────────

_sse_loop: asyncio.AbstractEventLoop | None = None


def _on_project_changed(project_id: str, updated_at: int) -> None:
    """ProjectStore listener callback — pushes events to all SSE clients.

    Called from a sync thread context, so we use call_soon_threadsafe.
    """
    if _sse_loop is None or _sse_loop.is_closed():
        return
    msg = json.dumps({"type": "project_updated", "projectId": project_id, "updatedAt": updated_at})
    for q in list(_sse_queues):
        try:
            _sse_loop.call_soon_threadsafe(q.put_nowait, msg)
        except Exception:
            pass


def register_sse_listener() -> None:
    """Register the SSE notification listener on the ProjectStore.

    Called once at startup after the MCP server is created.
    """
    global _sse_loop  # noqa: PLW0603
    _sse_loop = asyncio.get_event_loop()
    try:
        store = _get_store()
        store.add_listener(_on_project_changed)
    except RuntimeError:
        pass


@router.get("/events")
async def sse_events(request: Request) -> StreamingResponse:
    """Server-Sent Events stream for real-time project change notifications.

    The frontend connects via EventSource and receives lightweight JSON
    events whenever any project is mutated by MCP tools or the PUT endpoint.
    """
    queue: asyncio.Queue[str] = asyncio.Queue()
    _sse_queues.add(queue)

    async def event_generator():
        try:
            while True:
                # Send keepalive comment every 20 seconds to prevent proxy/OS timeouts
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=20.0)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                # Check if client disconnected
                if await request.is_disconnected():
                    break
        finally:
            _sse_queues.discard(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
