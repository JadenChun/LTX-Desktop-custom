# pyright: reportUnusedFunction=false

"""MCP tools for subtitle management."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from mcp.server.fastmcp import FastMCP

if TYPE_CHECKING:
    from mcp_server.project_state import ProjectStore


def register_subtitle_tools(mcp: FastMCP, store: "ProjectStore") -> None:
    """Register subtitle tools on the MCP server."""

    @mcp.tool()
    async def add_subtitle(
        text: str,
        start_time: float,
        end_time: float,
        track_index: int = 0,
        font_size: float = 32.0,
        font_family: str = "sans-serif",
        font_weight: str = "normal",
        color: str = "#FFFFFF",
        background_color: str = "transparent",
        position: str = "bottom",
        italic: bool = False,
    ) -> dict[str, Any]:
        """Add a subtitle entry to the active timeline.

        Args:
            text:             Subtitle text content.
            start_time:       When the subtitle appears (seconds from timeline start).
            end_time:         When the subtitle disappears (seconds).
            track_index:      Which track to place this on (default 0).
            font_size:        Font size in pixels (default 32).
            font_family:      CSS font family (default "sans-serif").
            font_weight:      "normal" or "bold".
            color:            Text color as CSS value e.g. "#FFFFFF".
            background_color: Background box color, e.g. "rgba(0,0,0,0.6)" or "transparent".
            position:         Vertical position: "bottom" (default), "top", or "center".
            italic:           Whether to render in italic.

        Returns:
            SubtitleClip dict including its id.
        """
        style = {
            "fontSize": font_size,
            "fontFamily": font_family,
            "fontWeight": font_weight,
            "color": color,
            "backgroundColor": background_color,
            "position": position,
            "italic": italic,
        }
        sub = store.add_subtitle(
            text=text,
            start_time=start_time,
            end_time=end_time,
            track_index=track_index,
            style=style,
        )
        return sub.model_dump()

    @mcp.tool()
    async def update_subtitle(
        subtitle_id: str,
        text: str | None = None,
        start_time: float | None = None,
        end_time: float | None = None,
    ) -> dict[str, Any]:
        """Update the text or timing of an existing subtitle.

        Args:
            subtitle_id: The subtitle id returned by add_subtitle.
            text:        New subtitle text (omit to leave unchanged).
            start_time:  New start time in seconds (omit to leave unchanged).
            end_time:    New end time in seconds (omit to leave unchanged).

        Returns:
            Updated SubtitleClip dict.
        """
        sub = store.update_subtitle(
            subtitle_id=subtitle_id,
            text=text,
            start_time=start_time,
            end_time=end_time,
        )
        return sub.model_dump()

    @mcp.tool()
    async def remove_subtitle(subtitle_id: str) -> dict[str, Any]:
        """Remove a subtitle entry from the active timeline.

        Args:
            subtitle_id: The subtitle id to remove.

        Returns:
            {"ok": true, "id": subtitle_id}
        """
        store.remove_subtitle(subtitle_id)
        return {"ok": True, "id": subtitle_id}

    @mcp.tool()
    async def set_subtitle_style(
        subtitle_id: str,
        font_size: float | None = None,
        font_family: str | None = None,
        font_weight: str | None = None,
        color: str | None = None,
        background_color: str | None = None,
        position: str | None = None,
        italic: bool | None = None,
    ) -> dict[str, Any]:
        """Update the visual style of a subtitle.

        All parameters are optional — only the ones you provide are changed.

        Args:
            subtitle_id:      Target subtitle id.
            font_size:        Font size in pixels.
            font_family:      CSS font family string.
            font_weight:      "normal" or "bold".
            color:            Text color as CSS value.
            background_color: Background color (use "rgba(0,0,0,0.6)" for semi-transparent).
            position:         "bottom", "top", or "center".
            italic:           True/False.

        Returns:
            Updated SubtitleClip dict.
        """
        kwargs: dict[str, object] = {}
        if font_size is not None:
            kwargs["fontSize"] = font_size
        if font_family is not None:
            kwargs["fontFamily"] = font_family
        if font_weight is not None:
            kwargs["fontWeight"] = font_weight
        if color is not None:
            kwargs["color"] = color
        if background_color is not None:
            kwargs["backgroundColor"] = background_color
        if position is not None:
            kwargs["position"] = position
        if italic is not None:
            kwargs["italic"] = italic

        sub = store.set_subtitle_style(subtitle_id, **kwargs)
        return sub.model_dump()

    @mcp.tool()
    async def set_subtitle_track_style(
        track_index: int = 0,
        font_size: float | None = None,
        font_family: str | None = None,
        font_weight: str | None = None,
        color: str | None = None,
        background_color: str | None = None,
        position: str | None = None,
        italic: bool | None = None,
        progressive_mode: bool | None = None,
        words_per_chunk: int | None = None,
    ) -> dict[str, Any]:
        """Configure style and behaviour for a subtitle track.

        Applies visual style to every existing subtitle on the track.
        Also sets track-level behaviour that affects future add_subtitle calls:

        - progressive_mode=True  — each new subtitle is automatically split into
          short word-chunk clips (TikTok / Reels-style captions).
        - words_per_chunk        — max words per chunk when progressive_mode is on
          (default 4).

        Only the provided keys are changed.

        Args:
            track_index:      Subtitle track ordinal to update (default 0).
            font_size:        Font size in pixels.
            font_family:      CSS font family string.
            font_weight:      "normal" or "bold".
            color:            Text color as CSS value.
            background_color: Background color (e.g. "rgba(0,0,0,0.6)").
            position:         "bottom", "top", or "center".
            italic:           True/False.
            progressive_mode: Auto-split new subtitles into word chunks.
            words_per_chunk:  Max words per chunk (default 4).

        Returns:
            {"ok": true, "track_index": int, "updated_count": int, "subtitles": [...]}
        """
        kwargs: dict[str, object] = {}
        if font_size is not None:
            kwargs["fontSize"] = font_size
        if font_family is not None:
            kwargs["fontFamily"] = font_family
        if font_weight is not None:
            kwargs["fontWeight"] = font_weight
        if color is not None:
            kwargs["color"] = color
        if background_color is not None:
            kwargs["backgroundColor"] = background_color
        if position is not None:
            kwargs["position"] = position
        if italic is not None:
            kwargs["italic"] = italic
        if progressive_mode is not None:
            kwargs["progressiveMode"] = progressive_mode
        if words_per_chunk is not None:
            kwargs["wordsPerChunk"] = words_per_chunk

        updated = store.set_subtitle_track_style(track_index, **kwargs)
        return {
            "ok": True,
            "track_index": track_index,
            "updated_count": len(updated),
            "subtitles": [sub.model_dump() for sub in updated],
        }


    @mcp.tool()
    async def list_subtitles() -> list[dict[str, Any]]:
        """Return all subtitles in the active timeline, sorted by start time.

        Returns:
            List of SubtitleClip dicts.
        """
        subs = store.get_subtitles()
        return [s.model_dump() for s in sorted(subs, key=lambda s: s.startTime)]
