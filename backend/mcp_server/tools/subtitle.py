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
    ) -> dict[str, Any]:
        """Apply one subtitle style to every subtitle on a track.

        This is the preferred way to normalize caption appearance for an edit
        pass. Only the provided style keys are changed.

        Args:
            track_index:      Subtitle track index to update (default 0).
            font_size:        Font size in pixels.
            font_family:      CSS font family string.
            font_weight:      "normal" or "bold".
            color:            Text color as CSS value.
            background_color: Background color (e.g. "rgba(0,0,0,0.6)").
            position:         "bottom", "top", or "center".
            italic:           True/False.

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

        updated = store.set_subtitle_track_style(track_index, **kwargs)
        return {
            "ok": True,
            "track_index": track_index,
            "updated_count": len(updated),
            "subtitles": [sub.model_dump() for sub in updated],
        }

    @mcp.tool()
    async def split_subtitle_progressive(
        subtitle_id: str,
        words_per_chunk: int = 4,
    ) -> list[dict[str, Any]]:
        """Split a long subtitle into short progressive chunks that appear one
        after another — like TikTok / Reels captions.

        Each chunk gets a proportional time slice based on character count,
        so longer phrases get more screen time.

        Args:
            subtitle_id:     The subtitle id to split.
            words_per_chunk: Maximum words per chunk (default 4).

        Returns:
            List of the new SubtitleClip dicts that replaced the original.
        """
        import math

        subs = store.get_subtitles()
        original = next((s for s in subs if s.id == subtitle_id), None)
        if original is None:
            return [{"error": f"Subtitle {subtitle_id} not found"}]

        words = original.text.strip().split()
        if len(words) <= words_per_chunk:
            return [original.model_dump()]

        # Build chunks
        chunks: list[str] = []
        for i in range(0, len(words), words_per_chunk):
            chunks.append(" ".join(words[i : i + words_per_chunk]))

        total_duration = original.endTime - original.startTime
        total_chars = sum(len(c) for c in chunks)

        # Remove original
        store.remove_subtitle(subtitle_id)

        # Create new progressive chunks
        new_subs: list[dict[str, Any]] = []
        cursor = original.startTime
        for i, chunk_text in enumerate(chunks):
            chunk_duration = total_duration * (len(chunk_text) / total_chars)
            end = original.endTime if i == len(chunks) - 1 else cursor + chunk_duration
            sub = store.add_subtitle(
                text=chunk_text,
                start_time=round(cursor, 3),
                end_time=round(end, 3),
                track_index=original.trackIndex,
                style=original.style or {},
            )
            new_subs.append(sub.model_dump())
            cursor = end

        return new_subs

    @mcp.tool()
    async def split_all_subtitles_progressive(
        track_index: int = 0,
        words_per_chunk: int = 4,
    ) -> dict[str, Any]:
        """Split ALL subtitles on a track into short progressive chunks.

        Subtitles that already have ≤ words_per_chunk words are left unchanged.

        Args:
            track_index:     Which subtitle track to process (default 0).
            words_per_chunk: Maximum words per chunk (default 4).

        Returns:
            {"ok": true, "original_count": N, "new_count": M}
        """
        subs = [s for s in store.get_subtitles() if s.trackIndex == track_index]
        subs.sort(key=lambda s: s.startTime)
        original_count = len(subs)

        ids_to_split = [s.id for s in subs if len(s.text.strip().split()) > words_per_chunk]
        for sid in ids_to_split:
            await split_subtitle_progressive(subtitle_id=sid, words_per_chunk=words_per_chunk)

        new_count = len([s for s in store.get_subtitles() if s.trackIndex == track_index])
        return {"ok": True, "original_count": original_count, "new_count": new_count}

    @mcp.tool()
    async def list_subtitles() -> list[dict[str, Any]]:
        """Return all subtitles in the active timeline, sorted by start time.

        Returns:
            List of SubtitleClip dicts.
        """
        subs = store.get_subtitles()
        return [s.model_dump() for s in sorted(subs, key=lambda s: s.startTime)]
