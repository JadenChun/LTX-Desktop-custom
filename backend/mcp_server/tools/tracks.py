# pyright: reportUnusedFunction=false

"""MCP tools for track management."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from mcp.server.fastmcp import FastMCP

if TYPE_CHECKING:
    from mcp_server.project_state import ProjectStore


def register_track_tools(mcp: FastMCP, store: "ProjectStore") -> None:
    """Register track management tools on the MCP server."""

    @mcp.tool()
    async def add_track(
        name: str,
        kind: str,
        position: int | None = None,
        track_type: str | None = None,
    ) -> dict[str, Any]:
        """Add a new track to the active timeline.

        Args:
            name:       Display name for the track (e.g. "V4", "A3", "Subtitles").
            kind:       Track kind: "video" or "audio".
            position:   Insert position (0-based index). None = append at end.
            track_type: Track type: "default" (media) or "subtitle". Default is None (media).

        Returns:
            The created Track dict including its id.
        """
        track = store.add_track(name=name, kind=kind, position=position, track_type=track_type)
        return track.model_dump()

    @mcp.tool()
    async def remove_track(track_id: str) -> dict[str, str]:
        """Remove a track from the active timeline.

        All clips and subtitles on this track are deleted.
        Track indices of items on higher tracks are shifted down.
        Cannot remove the last remaining track.

        Args:
            track_id: The ID of the track to remove.

        Returns:
            Confirmation dict with status.
        """
        store.remove_track(track_id)
        return {"status": "removed", "trackId": track_id}

    @mcp.tool()
    async def reorder_track(track_id: str, new_position: int) -> list[dict[str, Any]]:
        """Move a track to a new position in the track list.

        All clip and subtitle trackIndex values are updated accordingly.

        Args:
            track_id:     The ID of the track to move.
            new_position: The new 0-based index for the track.

        Returns:
            The updated list of Track dicts.
        """
        tracks = store.reorder_track(track_id, new_position)
        return [t.model_dump() for t in tracks]

    @mcp.tool()
    async def set_track_properties(
        track_id: str,
        name: str | None = None,
        muted: bool | None = None,
        locked: bool | None = None,
        solo: bool | None = None,
        enabled: bool | None = None,
        source_patched: bool | None = None,
    ) -> dict[str, Any]:
        """Update properties of a track.

        Args:
            track_id:       The ID of the track to update.
            name:           New display name.
            muted:          Mute/unmute the track.
            locked:         Lock/unlock the track.
            solo:           Solo the track (only soloed tracks produce audio).
            enabled:        Enable/disable track output in preview.
            source_patched: Source/record patch toggle.

        Returns:
            The updated Track dict.
        """
        kwargs: dict[str, Any] = {}
        if name is not None:
            kwargs["name"] = name
        if muted is not None:
            kwargs["muted"] = muted
        if locked is not None:
            kwargs["locked"] = locked
        if solo is not None:
            kwargs["solo"] = solo
        if enabled is not None:
            kwargs["enabled"] = enabled
        if source_patched is not None:
            kwargs["sourcePatched"] = source_patched
        track = store.set_track_properties(track_id, **kwargs)
        return track.model_dump()
