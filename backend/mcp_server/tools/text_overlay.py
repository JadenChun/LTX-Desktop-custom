# pyright: reportUnusedFunction=false

"""MCP tools for text overlay clips."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from mcp.server.fastmcp import FastMCP

if TYPE_CHECKING:
    from mcp_server.project_state import ProjectStore


def register_text_overlay_tools(mcp: FastMCP, store: "ProjectStore") -> None:
    """Register text overlay tools on the MCP server."""

    @mcp.tool()
    async def add_text_clip(
        track_index: int,
        start_time: float,
        duration: float,
        text: str = "Text",
        font_family: str = "Inter, Arial, sans-serif",
        font_size: float = 64.0,
        font_weight: str = "bold",
        font_style: str = "normal",
        color: str = "#FFFFFF",
        background_color: str = "transparent",
        text_align: str = "center",
        position_x: float = 50.0,
        position_y: float = 50.0,
        stroke_color: str = "transparent",
        stroke_width: float = 0.0,
        shadow_color: str = "rgba(0,0,0,0.5)",
        shadow_blur: float = 4.0,
        shadow_offset_x: float = 2.0,
        shadow_offset_y: float = 2.0,
        letter_spacing: float = 0.0,
        line_height: float = 1.2,
        max_width: float = 80.0,
        padding: float = 0.0,
        border_radius: float = 0.0,
        opacity: float = 100.0,
    ) -> dict[str, Any]:
        """Add a text overlay clip to the timeline.

        Text overlays render on top of video tracks. Use a high track_index
        (e.g. 2) to ensure they appear above video clips.

        Args:
            track_index:     Track to place the clip on (0-based; use 2 for V3).
            start_time:      Start position on the timeline in seconds.
            duration:        How long the text is visible in seconds.
            text:            The text to display.
            font_family:     CSS font family (default "Inter, Arial, sans-serif").
            font_size:       Font size in pixels (default 64).
            font_weight:     "normal", "bold", or numeric e.g. "600".
            font_style:      "normal" or "italic".
            color:           Text color as CSS value (default "#FFFFFF").
            background_color: Background box color (default "transparent").
            text_align:      "left", "center", or "right".
            position_x:      Horizontal center position as % of frame width (0-100).
            position_y:      Vertical center position as % of frame height (0-100).
            stroke_color:    Outline color (default "transparent" = no outline).
            stroke_width:    Outline thickness in pixels (default 0).
            shadow_color:    Drop shadow color.
            shadow_blur:     Drop shadow blur radius in pixels.
            shadow_offset_x: Drop shadow X offset.
            shadow_offset_y: Drop shadow Y offset.
            letter_spacing:  Extra spacing between letters in pixels.
            line_height:     Line height multiplier (default 1.2).
            max_width:       Maximum text width as % of frame (default 80).
            padding:         Inner padding in pixels.
            border_radius:   Background box corner radius in pixels.
            opacity:         Overall opacity 0-100 (default 100).

        Returns:
            TimelineClip dict including clip id and textStyle.
        """
        style = {
            "text": text,
            "fontFamily": font_family,
            "fontSize": font_size,
            "fontWeight": font_weight,
            "fontStyle": font_style,
            "color": color,
            "backgroundColor": background_color,
            "textAlign": text_align,
            "positionX": position_x,
            "positionY": position_y,
            "strokeColor": stroke_color,
            "strokeWidth": stroke_width,
            "shadowColor": shadow_color,
            "shadowBlur": shadow_blur,
            "shadowOffsetX": shadow_offset_x,
            "shadowOffsetY": shadow_offset_y,
            "letterSpacing": letter_spacing,
            "lineHeight": line_height,
            "maxWidth": max_width,
            "padding": padding,
            "borderRadius": border_radius,
            "opacity": opacity,
        }
        clip = store.add_text_clip(
            track_index=track_index,
            start_time=start_time,
            duration=duration,
            style=style,
        )
        return clip.model_dump()

    @mcp.tool()
    async def update_text_clip_style(
        clip_id: str,
        text: str | None = None,
        font_family: str | None = None,
        font_size: float | None = None,
        font_weight: str | None = None,
        font_style: str | None = None,
        color: str | None = None,
        background_color: str | None = None,
        text_align: str | None = None,
        position_x: float | None = None,
        position_y: float | None = None,
        stroke_color: str | None = None,
        stroke_width: float | None = None,
        shadow_color: str | None = None,
        shadow_blur: float | None = None,
        shadow_offset_x: float | None = None,
        shadow_offset_y: float | None = None,
        letter_spacing: float | None = None,
        line_height: float | None = None,
        max_width: float | None = None,
        padding: float | None = None,
        border_radius: float | None = None,
        opacity: float | None = None,
    ) -> dict[str, Any]:
        """Update the style of an existing text overlay clip.

        All parameters are optional — only the ones you provide are changed.

        Args:
            clip_id: The clip id of the text clip to update.
            (all other args match add_text_clip)

        Returns:
            Updated TimelineClip dict.
        """
        kwargs: dict[str, object] = {}
        mapping = {
            "text": text,
            "fontFamily": font_family,
            "fontSize": font_size,
            "fontWeight": font_weight,
            "fontStyle": font_style,
            "color": color,
            "backgroundColor": background_color,
            "textAlign": text_align,
            "positionX": position_x,
            "positionY": position_y,
            "strokeColor": stroke_color,
            "strokeWidth": stroke_width,
            "shadowColor": shadow_color,
            "shadowBlur": shadow_blur,
            "shadowOffsetX": shadow_offset_x,
            "shadowOffsetY": shadow_offset_y,
            "letterSpacing": letter_spacing,
            "lineHeight": line_height,
            "maxWidth": max_width,
            "padding": padding,
            "borderRadius": border_radius,
            "opacity": opacity,
        }
        for camel_key, val in mapping.items():
            if val is not None:
                kwargs[camel_key] = val

        clip = store.update_text_clip_style(clip_id, **kwargs)
        return clip.model_dump()
