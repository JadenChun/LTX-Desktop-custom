# pyright: reportUnusedFunction=false

"""MCP tools for project lifecycle management."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from mcp.server.fastmcp import FastMCP

if TYPE_CHECKING:
    from mcp_server.project_state import ProjectStore


def register_project_tools(mcp: FastMCP, store: "ProjectStore") -> None:
    """Register project lifecycle tools on the MCP server."""

    @mcp.tool()
    async def create_project(name: str) -> dict[str, Any]:
        """Create a new empty project and set it as the active project.

        Creates a project with default tracks (V1, V2, V3, A1, A2) and one
        empty timeline. The project is immediately persisted to disk.

        Args:
            name: Human-readable project name (e.g. "My Short Film").

        Returns:
            Full project state dict including id, timelines, and assets.
        """
        return store.create_project(name=name).model_dump()

    @mcp.tool()
    async def open_project(project_id: str) -> dict[str, Any]:
        """Load a previously saved MCP project by its id.

        Args:
            project_id: The project id returned by create_project (e.g. "project-...").

        Returns:
            Full project state dict.
        """
        return store.open_project(project_id).model_dump()

    @mcp.tool()
    async def save_project() -> dict[str, Any]:
        """Flush the active project to disk and update its updatedAt timestamp.

        Returns:
            Full project state dict.
        """
        return store.save().model_dump()

    @mcp.tool()
    async def get_project_state() -> dict[str, Any]:
        """Return the full state of the active project.

        Includes all assets, timelines, and clips. Useful for inspecting the
        current edit state before performing operations.

        Returns:
            Full project state dict (id, name, assets, timelines, clips).
        """
        return store.get_active().model_dump()

    @mcp.tool()
    async def list_projects() -> list[dict[str, Any]]:
        """List all available MCP-created projects.

        Returns id, name, createdAt, updatedAt, assetCount, and clipCount for each project.
        """
        return store.list_projects()
