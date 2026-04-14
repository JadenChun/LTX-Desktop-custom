"""MCP server factory for LTX Desktop.

Creates and configures the FastMCP server instance with all tool modules.
Mount the returned server at /mcp in app_factory.py:

    mcp_server = create_mcp_server(handler)
    app.mount("/mcp", mcp_server.streamable_http_app())
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING

from mcp.server.fastmcp import FastMCP

from mcp_server.project_state import ProjectStore
from mcp_server.tool_manifest import resolve_mcp_tool_flags
from mcp_server.tool_annotations import build_tool_annotations
from mcp_server.tools.assets import register_asset_tools
from mcp_server.tools.ai_generation import register_ai_generation_tools
from mcp_server.tools.export import register_export_tools
from mcp_server.tools.project import register_project_tools
from mcp_server.tools.subtitle import register_subtitle_tools
from mcp_server.tools.text_overlay import register_text_overlay_tools
from mcp_server.tools.timeline import register_timeline_tools
from mcp_server.tools.tracks import register_track_tools

if TYPE_CHECKING:
    from app_handler import AppHandler

logger = logging.getLogger(__name__)

# Module-level store reference so mcp_projects route can access it without
# circular imports (set by create_mcp_server at startup).
_store: ProjectStore | None = None


def _remove_disabled_tools(mcp: FastMCP, tool_flags: dict[str, dict[str, bool]]) -> None:
    """Remove disabled tools from the advertised MCP surface."""
    for module_tools in tool_flags.values():
        for tool_name, enabled in module_tools.items():
            if enabled:
                continue
            mcp._tool_manager._tools.pop(tool_name, None)  # noqa: SLF001  # pyright: ignore[reportPrivateUsage]


def _remove_null_defaults(value: object) -> object:
    """Recursively strip `default: null` from JSON Schema objects.

    Some MCP hosts render tool schemas directly into model prompt templates.
    LM Studio can fail during Jinja rendering when a schema includes a null
    default and the template tries to coerce it to a string.

    Keeping the field optional without an explicit null default preserves the
    intended call semantics while improving compatibility with those hosts.
    """
    if isinstance(value, dict):
        cleaned: dict[str, object] = {}
        for key, nested in value.items():
            if key == "default" and nested is None:
                continue
            cleaned[key] = _remove_null_defaults(nested)
        return cleaned
    if isinstance(value, list):
        return [_remove_null_defaults(item) for item in value]
    return value


def _sanitize_tool_schemas(mcp: FastMCP) -> None:
    """Normalize advertised tool schemas for MCP host compatibility."""
    for tool in mcp._tool_manager.list_tools():  # noqa: SLF001
        tool.parameters = _remove_null_defaults(tool.parameters)


def _apply_tool_annotations(mcp: FastMCP) -> None:
    """Apply consistent MCP annotations across all registered tools."""
    for tool in mcp._tool_manager.list_tools():  # noqa: SLF001
        if tool.annotations is None:
            tool.annotations = build_tool_annotations(tool.name)


def get_store() -> ProjectStore:
    """Return the active ProjectStore. Raises if create_mcp_server was not called."""
    if _store is None:
        raise RuntimeError("MCP server not initialized — call create_mcp_server() first.")
    return _store


def create_mcp_server(handler: "AppHandler") -> FastMCP:
    """Create the FastMCP server. Called once at app startup.

    Args:
        handler: The application handler providing AI generation capabilities.

    Returns:
        Configured FastMCP instance ready to be mounted at /mcp.
    """
    global _store  # noqa: PLW0603

    mcp = FastMCP("LTX Desktop", streamable_http_path="/", stateless_http=True)

    state_dir = Path(handler.config.outputs_dir) / "mcp_projects"
    _store = ProjectStore(state_dir=state_dir)

    register_project_tools(mcp, _store)
    register_asset_tools(mcp, _store)
    register_timeline_tools(mcp, _store)
    register_track_tools(mcp, _store)
    register_subtitle_tools(mcp, _store)
    register_text_overlay_tools(mcp, _store)
    register_export_tools(mcp, _store)

    tool_flags = resolve_mcp_tool_flags(
        handler.state.app_settings.mcp_modules,
        handler.state.app_settings.mcp_tools,
    )
    ai_tool_flags = tool_flags["ai_generation"]
    if any(ai_tool_flags.values()):
        register_ai_generation_tools(mcp, handler, enabled_tools=ai_tool_flags)

    _remove_disabled_tools(mcp, tool_flags)
    _apply_tool_annotations(mcp)
    _sanitize_tool_schemas(mcp)

    logger.info("MCP server created — %d tools registered", len(mcp._tool_manager._tools))  # noqa: SLF001  # pyright: ignore[reportPrivateUsage]
    return mcp
