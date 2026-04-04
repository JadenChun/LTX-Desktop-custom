# pyright: reportUnusedFunction=false

"""MCP tools for timeline clip management and clip property editing."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

from mcp.server.fastmcp import FastMCP

if TYPE_CHECKING:
    from mcp_server.project_state import ProjectStore


def register_timeline_tools(mcp: FastMCP, store: "ProjectStore") -> None:
    """Register timeline tools on the MCP server."""

    # ── Clip management ────────────────────────────────────────────────────────

    @mcp.tool()
    async def add_clip(
        asset_id: str,
        track_index: int = 0,
        start_time: float = 0.0,
        trim_start: float = 0.0,
        trim_end: float | None = None,
    ) -> dict[str, Any]:
        """Add a media clip to the timeline.

        Args:
            asset_id:    Asset id returned by import_asset (e.g. "asset-...").
            track_index: Which track to place on (0 = V1, 1 = V2, 2 = V3, 3 = A1, 4 = A2).
            start_time:  Position on the timeline in seconds (default 0).
            trim_start:  In-point in source media in seconds (default 0).
            trim_end:    Out-point in source media in seconds (defaults to asset duration).

        Returns:
            TimelineClip dict including its id.
        """
        asset = store.get_asset(asset_id)
        if trim_end is None:
            trim_end = asset.duration if asset.duration is not None else trim_start + 5.0
        clip = store.add_clip(
            asset_id=asset_id,
            track_index=track_index,
            start_time=start_time,
            trim_start=trim_start,
            trim_end=trim_end,
        )
        return clip.model_dump()

    @mcp.tool()
    async def remove_clip(clip_id: str) -> dict[str, Any]:
        """Remove a clip from the timeline.

        Args:
            clip_id: The clip id to remove (e.g. "clip-...").

        Returns:
            {"ok": true, "id": clip_id}
        """
        store.remove_clip(clip_id)
        return {"ok": True, "id": clip_id}

    @mcp.tool()
    async def move_clip(clip_id: str, track_index: int, start_time: float) -> dict[str, Any]:
        """Move a clip to a new position/track on the timeline.

        Args:
            clip_id:     The clip id to move.
            track_index: New track (0-based).
            start_time:  New start time in seconds.

        Returns:
            Updated TimelineClip dict.
        """
        return store.move_clip(clip_id, track_index, start_time).model_dump()

    @mcp.tool()
    async def trim_clip(clip_id: str, trim_start: float, trim_end: float) -> dict[str, Any]:
        """Change the in/out points of a clip (trim).

        This adjusts which portion of the source media is used and also
        updates the clip's duration accordingly.

        Args:
            clip_id:    The clip id to trim.
            trim_start: New in-point in source media (seconds).
            trim_end:   New out-point in source media (seconds).

        Returns:
            Updated TimelineClip dict.
        """
        return store.trim_clip(clip_id, trim_start, trim_end).model_dump()

    @mcp.tool()
    async def split_clip(clip_id: str, split_at_seconds: float) -> dict[str, Any]:
        """Split a clip into two clips at a timeline position.

        The original clip is replaced by a left half and a right half. Both
        halves inherit the original clip's properties (speed, volume, effects).

        Args:
            clip_id:          The clip id to split.
            split_at_seconds: Timeline position (seconds) at which to cut.
                              Must be within the clip's [startTime, startTime+duration] range.

        Returns:
            {"left": TimelineClip, "right": TimelineClip}
        """
        left, right = store.split_clip(clip_id, split_at_seconds)
        return {"left": left.model_dump(), "right": right.model_dump()}

    @mcp.tool()
    async def get_timeline_state() -> dict[str, Any]:
        """Return all clips on the active timeline, sorted by (track, start time).

        Returns:
            {"clips": [...], "subtitles": [...], "tracks": [...]}
        """
        tl = store._active_timeline()  # noqa: SLF001  # pyright: ignore[reportPrivateUsage]
        clips = sorted(tl.clips, key=lambda c: (c.trackIndex, c.startTime))
        subs = sorted(tl.subtitles, key=lambda s: s.startTime)
        return {
            "timelineId": tl.id,
            "clips": [c.model_dump() for c in clips],
            "subtitles": [s.model_dump() for s in subs],
            "tracks": [t.model_dump() for t in tl.tracks],
        }

    # ── Clip property setters ──────────────────────────────────────────────────

    @mcp.tool()
    async def set_clip_speed(clip_id: str, speed: float) -> dict[str, Any]:
        """Change the playback speed of a clip.

        Args:
            clip_id: The clip id to modify.
            speed:   Speed multiplier: 0.1–10.0 (1.0 = normal, 0.5 = half, 2.0 = double).

        Returns:
            Updated TimelineClip dict.
        """
        return store.set_clip_speed(clip_id, speed).model_dump()

    @mcp.tool()
    async def set_clip_volume(clip_id: str, volume: float) -> dict[str, Any]:
        """Set the volume of a clip.

        Args:
            clip_id: The clip id to modify.
            volume:  Volume level 0.0 (silent) to 1.0 (full, default).

        Returns:
            Updated TimelineClip dict.
        """
        return store.set_clip_volume(clip_id, volume).model_dump()

    @mcp.tool()
    async def set_clip_muted(clip_id: str, muted: bool) -> dict[str, Any]:
        """Mute or unmute a clip.

        Args:
            clip_id: The clip id to modify.
            muted:   True to mute, False to unmute.

        Returns:
            Updated TimelineClip dict.
        """
        return store.set_clip_muted(clip_id, muted).model_dump()

    @mcp.tool()
    async def reverse_clip(clip_id: str, reversed_: bool) -> dict[str, Any]:
        """Enable or disable reverse playback for a clip.

        Args:
            clip_id:   The clip id to modify.
            reversed_: True to play in reverse, False for normal direction.

        Returns:
            Updated TimelineClip dict.
        """
        return store.reverse_clip(clip_id, reversed_).model_dump()

    @mcp.tool()
    async def set_clip_opacity(clip_id: str, opacity: float) -> dict[str, Any]:
        """Set the opacity of a video/image clip.

        Args:
            clip_id: The clip id to modify.
            opacity: Opacity 0 (transparent) to 100 (fully opaque, default).

        Returns:
            Updated TimelineClip dict.
        """
        return store.set_clip_opacity(clip_id, opacity).model_dump()

    @mcp.tool()
    async def flip_clip(
        clip_id: str,
        flip_h: bool = False,
        flip_v: bool = False,
    ) -> dict[str, Any]:
        """Flip a clip horizontally and/or vertically.

        Args:
            clip_id: The clip id to modify.
            flip_h:  True to mirror horizontally (left-right).
            flip_v:  True to flip vertically (upside down).

        Returns:
            Updated TimelineClip dict.
        """
        return store.flip_clip(clip_id, flip_h, flip_v).model_dump()

    @mcp.tool()
    async def set_clip_motion(
        clip_id: str,
        motion_type: Literal["none", "ken_burns"] = "ken_burns",
        start_scale: float = 1.0,
        start_focus_x: float = 50.0,
        start_focus_y: float = 50.0,
        end_scale: float = 1.0,
        end_focus_x: float = 50.0,
        end_focus_y: float = 50.0,
        easing: Literal["linear", "easeInOut"] = "linear",
    ) -> dict[str, Any]:
        """Set per-clip motion (pan/zoom).

        Supports Ken Burns motion for image and video clips. Focus coordinates are
        in frame space (0â€“100% of the video frame), so they are stable across
        different source aspect ratios.

        Args:
            clip_id:        The clip id to modify.
            motion_type:    "none" to clear motion, or "ken_burns" to set.
            start_scale:    Zoom at clip start (>= 1.0 recommended).
            start_focus_x:  Focus X at clip start (0â€“100).
            start_focus_y:  Focus Y at clip start (0â€“100).
            end_scale:      Zoom at clip end (>= 1.0 recommended).
            end_focus_x:    Focus X at clip end (0â€“100).
            end_focus_y:    Focus Y at clip end (0â€“100).
            easing:         "linear" or "easeInOut".

        Returns:
            Updated TimelineClip dict.
        """
        if motion_type == "none":
            return store.set_clip_motion(clip_id, None).model_dump()

        from mcp_server.project_state import KenBurnsKeyframe, KenBurnsMotion

        motion = KenBurnsMotion(
            start=KenBurnsKeyframe(scale=start_scale, focusX=start_focus_x, focusY=start_focus_y),
            end=KenBurnsKeyframe(scale=end_scale, focusX=end_focus_x, focusY=end_focus_y),
            easing=easing,
        )
        return store.set_clip_motion(clip_id, motion).model_dump()

    @mcp.tool()
    async def set_clip_color_correction(
        clip_id: str,
        brightness: float | None = None,
        contrast: float | None = None,
        saturation: float | None = None,
        temperature: float | None = None,
        tint: float | None = None,
        exposure: float | None = None,
        highlights: float | None = None,
        shadows: float | None = None,
    ) -> dict[str, Any]:
        """Apply color correction to a clip.

        All parameters are optional — only the ones you provide are changed.
        Each value is in the range -100 to 100 (0 = no change).

        Args:
            clip_id:     The clip id to modify.
            brightness:  -100 (very dark) to 100 (very bright).
            contrast:    -100 (flat) to 100 (high contrast).
            saturation:  -100 (grayscale) to 100 (vivid).
            temperature: -100 (cool/blue) to 100 (warm/orange).
            tint:        -100 (green) to 100 (magenta).
            exposure:    -100 (underexposed) to 100 (overexposed).
            highlights:  -100 to 100 (adjust bright areas).
            shadows:     -100 to 100 (adjust dark areas).

        Returns:
            Updated TimelineClip dict.
        """
        kwargs: dict[str, float] = {}
        for name, val in [
            ("brightness", brightness), ("contrast", contrast),
            ("saturation", saturation), ("temperature", temperature),
            ("tint", tint), ("exposure", exposure),
            ("highlights", highlights), ("shadows", shadows),
        ]:
            if val is not None:
                kwargs[name] = val
        return store.set_clip_color_correction(clip_id, **kwargs).model_dump()

    @mcp.tool()
    async def set_clip_transition(
        clip_id: str,
        side: Literal["in", "out"],
        transition_type: Literal[
            "none", "dissolve", "fade-to-black", "fade-to-white",
            "wipe-left", "wipe-right", "wipe-up", "wipe-down"
        ],
        duration: float = 0.5,
    ) -> dict[str, Any]:
        """Set a transition on the in or out edge of a clip.

        Args:
            clip_id:         The clip id to modify.
            side:            "in" (clip entrance) or "out" (clip exit).
            transition_type: One of: none, dissolve, fade-to-black, fade-to-white,
                             wipe-left, wipe-right, wipe-up, wipe-down.
            duration:        Transition duration in seconds (default 0.5).

        Returns:
            Updated TimelineClip dict.
        """
        return store.set_clip_transition(clip_id, side, transition_type, duration).model_dump()

    @mcp.tool()
    async def add_clip_effect(
        clip_id: str,
        effect_type: Literal[
            "blur", "sharpen", "glow", "vignette", "grain",
            "lut-cinematic", "lut-vintage", "lut-bw",
            "lut-cool", "lut-warm", "lut-muted", "lut-vivid"
        ],
        amount: float | None = None,
        intensity: float | None = None,
        radius: float | None = None,
    ) -> dict[str, Any]:
        """Add a visual effect to a clip.

        Filter effects (blur/sharpen/glow/vignette/grain) use an "amount" parameter.
        LUT color-grading presets use an "intensity" parameter.
        Glow also accepts a "radius" parameter.

        Args:
            clip_id:     The clip id to add the effect to.
            effect_type: Effect name. Filters: blur, sharpen, glow, vignette, grain.
                         LUTs: lut-cinematic, lut-vintage, lut-bw, lut-cool,
                               lut-warm, lut-muted, lut-vivid.
            amount:      Filter strength 0-100 (for blur: 0-50). Omit to use default.
            intensity:   LUT intensity 0-100. Omit to use default.
            radius:      Glow radius 0-50. Omit to use default.

        Returns:
            {"clip": TimelineClip, "effect": ClipEffect} — includes the new effect id.
        """
        params: dict[str, float] = {}
        if amount is not None:
            params["amount"] = amount
        if intensity is not None:
            params["intensity"] = intensity
        if radius is not None:
            params["radius"] = radius
        clip, effect = store.add_clip_effect(clip_id, effect_type, params or None)
        return {"clip": clip.model_dump(), "effect": effect.model_dump()}

    @mcp.tool()
    async def remove_clip_effect(clip_id: str, effect_id: str) -> dict[str, Any]:
        """Remove a visual effect from a clip.

        Args:
            clip_id:   The clip id that owns the effect.
            effect_id: The effect id returned by add_clip_effect.

        Returns:
            Updated TimelineClip dict.
        """
        return store.remove_clip_effect(clip_id, effect_id).model_dump()

    @mcp.tool()
    async def update_clip_effect(
        clip_id: str,
        effect_id: str,
        amount: float | None = None,
        intensity: float | None = None,
        radius: float | None = None,
    ) -> dict[str, Any]:
        """Update the parameters of an existing clip effect.

        Args:
            clip_id:   The clip id that owns the effect.
            effect_id: The effect id to update.
            amount:    New filter strength.
            intensity: New LUT intensity.
            radius:    New glow radius.

        Returns:
            {"clip": TimelineClip, "effect": ClipEffect}
        """
        params: dict[str, float] = {}
        if amount is not None:
            params["amount"] = amount
        if intensity is not None:
            params["intensity"] = intensity
        if radius is not None:
            params["radius"] = radius
        if not params:
            raise ValueError("Provide at least one of: amount, intensity, radius")
        clip, effect = store.update_clip_effect(clip_id, effect_id, params)
        return {"clip": clip.model_dump(), "effect": effect.model_dump()}

    @mcp.tool()
    async def update_clip(
        clip_id: str,
        start_time: float | None = None,
        duration: float | None = None,
        trim_start: float | None = None,
        trim_end: float | None = None,
        track_index: int | None = None,
        muted: bool | None = None,
        volume: float | None = None,
        speed: float | None = None,
        reversed: bool | None = None,
        opacity: float | None = None,
        flip_h: bool | None = None,
        flip_v: bool | None = None,
    ) -> dict[str, Any]:
        """Update one or more properties of a clip in a single call.

        Only the parameters you provide are changed. This is a convenience
        wrapper — for validated operations (speed changes with duration
        recalculation), prefer the dedicated tools.

        Args:
            clip_id:     The clip id to modify.
            start_time:  New timeline position (seconds).
            duration:    New timeline duration (seconds).
            trim_start:  New in-point in source media (seconds).
            trim_end:    New amount trimmed from end of source media (seconds).
            track_index: New track index.
            muted:       Mute/unmute.
            volume:      Volume (0.0 to 1.0).
            speed:       Playback speed.
            reversed:    Reverse playback.
            opacity:     Opacity (0 to 100).
            flip_h:      Horizontal flip.
            flip_v:      Vertical flip.

        Returns:
            Updated TimelineClip dict.
        """
        kwargs: dict[str, Any] = {}
        if start_time is not None:
            kwargs["startTime"] = start_time
        if duration is not None:
            kwargs["duration"] = duration
        if trim_start is not None:
            kwargs["trimStart"] = trim_start
        if trim_end is not None:
            kwargs["trimEnd"] = trim_end
        if track_index is not None:
            kwargs["trackIndex"] = track_index
        if muted is not None:
            kwargs["muted"] = muted
        if volume is not None:
            kwargs["volume"] = max(0.0, min(1.0, volume))
        if speed is not None:
            kwargs["speed"] = speed
        if reversed is not None:
            kwargs["reversed"] = reversed
        if opacity is not None:
            kwargs["opacity"] = max(0.0, min(100.0, opacity))
        if flip_h is not None:
            kwargs["flipH"] = flip_h
        if flip_v is not None:
            kwargs["flipV"] = flip_v
        if not kwargs:
            raise ValueError("Provide at least one property to update")
        return store.update_clip(clip_id, **kwargs).model_dump()

    @mcp.tool()
    async def retake_clip(clip_id: str, take_index: int) -> dict[str, Any]:
        """Switch a clip to use a different take of its asset.

        The asset must have multiple takes (generated via retake/regeneration).
        Updates the clip and all linked clips (e.g. video↔audio pairs).

        Args:
            clip_id:    The clip id to update.
            take_index: 0-based index of the take to activate.

        Returns:
            Updated TimelineClip dict.
        """
        return store.retake_clip(clip_id, take_index).model_dump()
