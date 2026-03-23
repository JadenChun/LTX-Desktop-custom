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
    register_ai_generation_tools(mcp, handler)
    register_export_tools(mcp, _store)

    logger.info("MCP server created — %d tools registered", len(mcp._tool_manager._tools))  # noqa: SLF001  # pyright: ignore[reportPrivateUsage]
    return mcp
