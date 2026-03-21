"""REST endpoints for browsing MCP-created projects from the frontend."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Body, HTTPException

router = APIRouter(prefix="/api/mcp", tags=["mcp-projects"])


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


@router.put("/projects/{project_id}")
async def put_mcp_project(project_id: str, project_payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """Replace an MCP project's JSON with the provided state.

    This allows the frontend editor to persist its edits back into the MCP store,
    keeping the UI and MCP tools in sync.
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

    saved = store.upsert_project(project)
    return saved.model_dump()
