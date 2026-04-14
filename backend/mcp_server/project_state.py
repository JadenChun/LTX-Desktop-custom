"""Project state management for the MCP server.

Uses the EXACT same JSON schema as the frontend TypeScript interfaces
(Project, Asset, Timeline, Track, TimelineClip, SubtitleClip, TextOverlayStyle)
so that MCP-created projects can be imported directly into the LTX Desktop UI
via GET /api/mcp/projects/{id}.

Key conventions (matching the frontend):
- IDs:        "project-{unix_ms}-{random9}", "asset-{unix_ms}-{random9}", etc.
- Timestamps: Unix milliseconds (int), matching JS Date.now()
- file URLs:  Path.as_uri() → "file:///..." — frontend's recoverAssetUrls() handles these
"""

from __future__ import annotations

import json
import os
import threading
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, model_validator


class SchemaModel(BaseModel):
    model_config = ConfigDict(extra="allow")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _now_ms() -> int:
    return int(time.time() * 1000)


def _new_id(prefix: str) -> str:
    return f"{prefix}-{_now_ms()}-{uuid.uuid4().hex[:9]}"


# ── Sub-models (matching frontend types/project.ts exactly) ───────────────────

class ClipTransition(SchemaModel):
    type: str = "none"       # none|dissolve|fade-to-black|fade-to-white|wipe-left|wipe-right|wipe-up|wipe-down
    duration: float = 0.0   # seconds


class ColorCorrection(SchemaModel):
    brightness: float = 0.0
    contrast: float = 0.0
    saturation: float = 0.0
    temperature: float = 0.0
    tint: float = 0.0
    exposure: float = 0.0
    highlights: float = 0.0
    shadows: float = 0.0


class ClipEffect(SchemaModel):
    id: str
    type: str        # blur|sharpen|glow|vignette|grain|lut-cinematic|lut-vintage|lut-bw|lut-cool|lut-warm|lut-muted|lut-vivid
    enabled: bool = True
    params: dict[str, float] = Field(default_factory=dict)


class KenBurnsKeyframe(SchemaModel):
    scale: float
    focusX: float  # 0–100 (% of frame width), 50 = center
    focusY: float  # 0–100 (% of frame height), 50 = center


class KenBurnsMotion(SchemaModel):
    type: Literal["ken_burns"] = "ken_burns"
    start: KenBurnsKeyframe
    end: KenBurnsKeyframe
    easing: Literal["linear", "easeInOut"] | None = None


class TextOverlayStyle(SchemaModel):
    text: str = "Text"
    fontFamily: str = "Inter, Arial, sans-serif"
    fontSize: float = 64.0
    fontWeight: str = "bold"
    fontStyle: str = "normal"
    color: str = "#FFFFFF"
    backgroundColor: str = "transparent"
    textAlign: str = "center"
    positionX: float = 50.0   # 0-100% of frame width
    positionY: float = 50.0   # 0-100% of frame height
    strokeColor: str = "transparent"
    strokeWidth: float = 0.0
    shadowColor: str = "rgba(0,0,0,0.5)"
    shadowBlur: float = 4.0
    shadowOffsetX: float = 2.0
    shadowOffsetY: float = 2.0
    letterSpacing: float = 0.0
    lineHeight: float = 1.2
    maxWidth: float = 80.0    # % of frame
    padding: float = 0.0
    borderRadius: float = 0.0
    opacity: float = 100.0


class SubtitleStyle(SchemaModel):
    fontSize: float = 32.0
    fontFamily: str = "sans-serif"
    fontWeight: str = "normal"   # normal|bold
    color: str = "#FFFFFF"
    backgroundColor: str = "transparent"
    position: str = "bottom"     # bottom|top|center
    italic: bool = False
    highlightEnabled: bool = False
    highlightColor: str = "#FFDD00"
    progressiveMode: bool = False   # split added subtitles into word-chunk clips
    wordsPerChunk: int = 4          # max words per progressive chunk


class SubtitleClip(SchemaModel):
    id: str
    text: str
    startTime: float
    endTime: float
    trackIndex: int = 0
    style: SubtitleStyle | None = None


class Track(SchemaModel):
    id: str
    name: str
    muted: bool = False
    locked: bool = False
    solo: bool = False
    enabled: bool = True
    sourcePatched: bool = True
    kind: str | None = None   # "video" | "audio" | None
    type: str | None = None   # "default" | "subtitle" | None
    subtitleStyle: dict[str, Any] | None = None


class Asset(SchemaModel):
    id: str
    type: str   # "video" | "image" | "audio" | "adjustment"
    path: str   # absolute filesystem path
    url: str | None = None   # file:///... URL (not blob:)
    prompt: str = ""
    resolution: str = ""
    duration: float | None = None
    createdAt: int
    thumbnail: str | None = None
    favorite: bool = False
    bin: str | None = None
    generationParams: dict[str, Any] | None = None
    takes: list[dict[str, Any]] | None = None
    activeTakeIndex: int | None = None
    colorLabel: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _populate_missing_url(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value

        raw_value = cast(dict[str, Any], value)
        url = raw_value.get("url")
        path_value = raw_value.get("path")
        if url or not isinstance(path_value, str) or not path_value:
            return raw_value

        try:
            normalized_value: dict[str, Any] = dict(raw_value)
            normalized_value["url"] = Path(path_value).resolve().as_uri()
        except Exception:
            # If URL derivation fails, leave the payload untouched and let the
            # regular validation error surface if a caller truly requires it.
            return raw_value

        return normalized_value


class TimelineClip(SchemaModel):
    id: str
    # Text clips legitimately have no backing asset. Older persisted MCP project
    # JSON may omit null-valued fields entirely, so treat a missing assetId as None.
    assetId: str | None = None
    type: str   # "video" | "image" | "audio" | "adjustment" | "text"
    startTime: float    # position on timeline (seconds)
    duration: float     # duration on timeline (seconds)
    trimStart: float    # in-point in source media (seconds)
    trimEnd: float      # amount trimmed from end of source media (seconds)
    speed: float = 1.0
    reversed: bool = False
    muted: bool = False
    volume: float = 1.0
    audioFadeInDuration: float = 0.0
    audioFadeOutDuration: float = 0.0
    trackIndex: int = 0
    asset: Asset | None = None   # embedded copy for the frontend
    importedUrl: str | None = None
    importedName: str | None = None
    flipH: bool = False
    flipV: bool = False
    transitionIn: ClipTransition = Field(default_factory=ClipTransition)
    transitionOut: ClipTransition = Field(default_factory=ClipTransition)
    colorCorrection: ColorCorrection = Field(default_factory=ColorCorrection)
    opacity: float = 100.0
    effects: list[ClipEffect] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]
    textStyle: TextOverlayStyle | None = None   # only for type="text"
    motion: KenBurnsMotion | None = None
    linkedClipIds: list[str] | None = None
    colorLabel: str | None = None
    letterbox: dict[str, Any] | None = None  # adjustment layer letterbox settings
    takeIndex: int | None = None
    isRegenerating: bool = False


def _default_tracks() -> list[Track]:
    return [
        Track(id="track-v1", name="V1", kind="video"),
        Track(id="track-v2", name="V2", kind="video"),
        Track(id="track-v3", name="V3", kind="video"),
        Track(id="track-a1", name="A1", kind="audio"),
        Track(id="track-a2", name="A2", kind="audio"),
    ]


class Timeline(SchemaModel):
    id: str
    name: str
    createdAt: int
    tracks: list[Track] = Field(default_factory=_default_tracks)
    clips: list[TimelineClip] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]
    subtitles: list[SubtitleClip] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]


class Project(SchemaModel):
    id: str
    name: str
    createdAt: int
    updatedAt: int
    assets: list[Asset] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]
    timelines: list[Timeline] = Field(default_factory=list)  # pyright: ignore[reportUnknownVariableType]
    activeTimelineId: str | None = None
    thumbnail: str | None = None


# ── ProjectStore ──────────────────────────────────────────────────────────────

class ProjectStore:
    """Thread-safe, JSON-persisted project state manager.

    Maintains one "active" project in memory and syncs it to disk on every
    mutation so state survives crashes and is discoverable by the frontend
    via GET /api/mcp/projects.
    """

    def __init__(self, state_dir: Path) -> None:
        self._state_dir = state_dir
        self._state_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._active: Project | None = None
        self._listeners: list[Callable[[str, int], None]] = []

    # ── Listener management ──────────────────────────────────────────────────

    def add_listener(self, callback: Callable[[str, int], None]) -> None:
        """Register a callback invoked after every project mutation.

        The callback receives (project_id, updated_at_ms).
        """
        self._listeners.append(callback)

    def remove_listener(self, callback: Callable[[str, int], None]) -> None:
        """Remove a previously registered listener."""
        try:
            self._listeners.remove(callback)
        except ValueError:
            pass

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _project_file(self, project_id: str) -> Path:
        return self._state_dir / f"{project_id}.json"

    def _persist(self) -> None:
        """Write active project to disk. Caller must hold _lock."""
        if self._active is None:
            return
        
        # Optimize JSON: remove indent, exclude None values to minimize file size
        data = self._active.model_dump_json(indent=None, exclude_none=True)
        path = self._project_file(self._active.id)
        fd, temp_path = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(self._state_dir))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, path)
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)

    def _touch(self) -> tuple[str, int] | None:
        """Update updatedAt and persist. Caller must hold _lock.

        Returns (project_id, updated_at) for notification, or None.
        """
        if self._active:
            self._active.updatedAt = _now_ms()
            self._persist()
            return (self._active.id, self._active.updatedAt)
        self._persist()
        return None

    def _notify(self, info: tuple[str, int] | None) -> None:
        """Notify all listeners. Must be called OUTSIDE _lock to avoid deadlocks."""
        if info is None:
            return
        project_id, updated_at = info
        for cb in self._listeners:
            try:
                cb(project_id, updated_at)
            except Exception:
                pass

    def _find_clip(self, clip_id: str) -> TimelineClip:
        for clip in self._active_timeline().clips:
            if clip.id == clip_id:
                return clip
        raise KeyError(f"Clip not found: {clip_id}")

    def _active_timeline(self) -> Timeline:
        p = self.get_active()
        if not p.timelines:
            raise RuntimeError("Project has no timelines")
        for tl in p.timelines:
            if tl.id == p.activeTimelineId:
                return tl
        return p.timelines[0]

    # ── Project lifecycle ─────────────────────────────────────────────────────

    def create_project(self, name: str) -> Project:
        with self._lock:
            now = _now_ms()
            timeline = Timeline(id=_new_id("timeline"), name="Timeline 1", createdAt=now)
            self._active = Project(
                id=_new_id("project"),
                name=name,
                createdAt=now,
                updatedAt=now,
                timelines=[timeline],
                activeTimelineId=timeline.id,
            )
            self._persist()
            result = self._active
        self._notify((result.id, result.updatedAt))
        return result

    def peek_project(self, project_id: str) -> Project | None:
        """Read a project from disk without changing the active project."""
        path = self._project_file(project_id)
        if not path.exists():
            return None
        try:
            return Project.model_validate_json(path.read_text(encoding="utf-8"))
        except Exception:
            return None

    def open_project(self, project_id: str) -> Project:
        with self._lock:
            path = self._project_file(project_id)
            if not path.exists():
                raise FileNotFoundError(f"MCP project not found: {project_id}")
            self._active = Project.model_validate_json(path.read_text(encoding="utf-8"))
            return self._active

    def upsert_project(self, project: Project, *, notify: bool = True) -> Project:
        """Replace the stored project JSON with the provided state.

        Used for keeping the MCP store in sync with frontend edits.
        Set notify=False to skip SSE notifications (e.g. for frontend→backend sync
        where the frontend already has the latest state).
        """
        with self._lock:
            project.updatedAt = _now_ms()
            self._active = project
            self._persist()
            result = self._active
        if notify:
            self._notify((result.id, result.updatedAt))
        return result

    def delete_project(self, project_id: str) -> None:
        """Delete a project from disk and clear active state if it was active."""
        with self._lock:
            path = self._project_file(project_id)
            if not path.exists():
                raise FileNotFoundError(f"MCP project not found: {project_id}")
            path.unlink()
            if self._active and self._active.id == project_id:
                self._active = None

    def get_active(self) -> Project:
        with self._lock:
            if self._active is None:
                raise RuntimeError(
                    "No active project. Call create_project or open_project first."
                )
            return self._active

    def save(self) -> Project:
        with self._lock:
            info = self._touch()
            result = self.get_active()
        self._notify(info)
        return result

    def list_projects(self) -> list[dict[str, Any]]:
        summaries: list[dict[str, Any]] = []
        for path in sorted(self._state_dir.glob("*.json")):
            try:
                data_raw: Any = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(data_raw, dict):
                    continue
                data = cast(dict[str, Any], data_raw)
                summaries.append({
                    "id": data.get("id"),
                    "name": data.get("name"),
                    "createdAt": data.get("createdAt"),
                    "updatedAt": data.get("updatedAt"),
                    "assetCount": len(data.get("assets", [])),
                    "clipCount": sum(
                        len(tl.get("clips", []))
                        for tl in data.get("timelines", [])
                    ),
                })
            except Exception:
                pass
        return summaries

    # ── Asset management ──────────────────────────────────────────────────────

    def add_asset(
        self,
        file_path: str,
        media_type: str,
        duration: float | None,
        resolution: str,
        prompt: str = "",
    ) -> Asset:
        with self._lock:
            resolved = Path(file_path).resolve()
            asset = Asset(
                id=_new_id("asset"),
                type=media_type,
                path=str(resolved),
                url=resolved.as_uri(),
                prompt=prompt,
                resolution=resolution,
                duration=duration,
                createdAt=_now_ms(),
            )
            self.get_active().assets.append(asset)
            info = self._touch()
        self._notify(info)
        return asset

    def get_asset(self, asset_id: str) -> Asset:
        with self._lock:
            for a in self.get_active().assets:
                if a.id == asset_id:
                    return a
            raise KeyError(f"Asset not found: {asset_id}")

    # ── Clip management ───────────────────────────────────────────────────────

    def add_clip(
        self,
        asset_id: str,
        track_index: int,
        start_time: float,
        trim_start: float,
        trim_end: float,
    ) -> TimelineClip:
        with self._lock:
            asset = self.get_asset(asset_id)
            # trim_end is the out-point in source media, but the frontend
            # trimEnd field means "amount trimmed from the end of the media"
            media_duration = asset.duration or trim_end
            clip = TimelineClip(
                id=_new_id("clip"),
                assetId=asset_id,
                type=asset.type,
                startTime=start_time,
                duration=trim_end - trim_start,
                trimStart=trim_start,
                trimEnd=max(0.0, media_duration - trim_end),
                trackIndex=track_index,
                asset=asset,
            )
            self._active_timeline().clips.append(clip)
            info = self._touch()
        self._notify(info)
        return clip

    def remove_clip(self, clip_id: str) -> None:
        with self._lock:
            tl = self._active_timeline()
            before = len(tl.clips)
            tl.clips = [c for c in tl.clips if c.id != clip_id]
            if len(tl.clips) == before:
                raise KeyError(f"Clip not found: {clip_id}")
            info = self._touch()
        self._notify(info)

    def move_clip(self, clip_id: str, track_index: int, start_time: float) -> TimelineClip:
        with self._lock:
            clip = self._find_clip(clip_id)
            clip.trackIndex = track_index
            clip.startTime = start_time
            info = self._touch()
        self._notify(info)
        return clip

    def trim_clip(self, clip_id: str, trim_start: float, trim_end: float) -> TimelineClip:
        with self._lock:
            clip = self._find_clip(clip_id)
            if not clip.assetId:
                raise ValueError(f"Clip {clip_id} (type={clip.type}) has no source asset and cannot be trimmed")
            # trim_end is the out-point in source media, but the frontend
            # trimEnd field means "amount trimmed from the end of the media"
            asset = self.get_asset(clip.assetId)
            media_duration = asset.duration or trim_end
            clip.trimStart = trim_start
            clip.trimEnd = max(0.0, media_duration - trim_end)
            clip.duration = trim_end - trim_start
            info = self._touch()
        self._notify(info)
        return clip

    def split_clip(self, clip_id: str, split_at_seconds: float) -> tuple[TimelineClip, TimelineClip]:
        with self._lock:
            tl = self._active_timeline()
            for i, clip in enumerate(tl.clips):
                if clip.id != clip_id:
                    continue
                if not clip.assetId:
                    raise ValueError(f"Clip {clip_id} (type={clip.type}) has no source asset and cannot be split")
                # trimEnd is "amount trimmed from end", so the media
                # out-point is (mediaDuration - trimEnd)
                asset = self.get_asset(clip.assetId)
                media_duration = asset.duration or (clip.trimStart + clip.duration)
                out_point = media_duration - clip.trimEnd
                asset_split = clip.trimStart + (split_at_seconds - clip.startTime)
                if not (clip.trimStart < asset_split < out_point):
                    raise ValueError(
                        f"split_at_seconds {split_at_seconds} is outside clip bounds "
                        f"[{clip.startTime:.2f}, {clip.startTime + clip.duration:.2f}]"
                    )
                left = TimelineClip(
                    id=_new_id("clip"), assetId=clip.assetId, type=clip.type,
                    startTime=clip.startTime, duration=asset_split - clip.trimStart,
                    trimStart=clip.trimStart, trimEnd=media_duration - asset_split,
                    trackIndex=clip.trackIndex, asset=clip.asset,
                    speed=clip.speed, reversed=clip.reversed, muted=clip.muted, volume=clip.volume,
                    flipH=clip.flipH, flipV=clip.flipV, opacity=clip.opacity,
                    transitionIn=clip.transitionIn.model_copy(),
                    motion=clip.motion.model_copy() if clip.motion else None,
                    colorCorrection=clip.colorCorrection.model_copy(),
                    effects=list(clip.effects),
                )
                right = TimelineClip(
                    id=_new_id("clip"), assetId=clip.assetId, type=clip.type,
                    startTime=clip.startTime + left.duration,
                    duration=out_point - asset_split,
                    trimStart=asset_split, trimEnd=clip.trimEnd,
                    trackIndex=clip.trackIndex, asset=clip.asset,
                    speed=clip.speed, reversed=clip.reversed, muted=clip.muted, volume=clip.volume,
                    flipH=clip.flipH, flipV=clip.flipV, opacity=clip.opacity,
                    transitionOut=clip.transitionOut.model_copy(),
                    motion=clip.motion.model_copy() if clip.motion else None,
                    colorCorrection=clip.colorCorrection.model_copy(),
                    effects=list(clip.effects),
                )
                tl.clips[i : i + 1] = [left, right]
                info = self._touch()
                self._notify(info)
                return left, right
            raise KeyError(f"Clip not found: {clip_id}")

    def get_clips_sorted(self) -> list[TimelineClip]:
        with self._lock:
            return sorted(
                self._active_timeline().clips,
                key=lambda c: (c.trackIndex, c.startTime),
            )

    # ── Clip property setters ─────────────────────────────────────────────────

    def set_clip_speed(self, clip_id: str, speed: float) -> TimelineClip:
        with self._lock:
            clip = self._find_clip(clip_id)
            old_speed = clip.speed
            new_speed = max(0.1, min(10.0, speed))
            clip.duration = clip.duration * (old_speed / new_speed)
            clip.speed = new_speed
            info = self._touch()
        self._notify(info)
        return clip

    def set_clip_volume(self, clip_id: str, volume: float) -> TimelineClip:
        with self._lock:
            clip = self._find_clip(clip_id)
            clip.volume = max(0.0, min(1.0, volume))
            info = self._touch()
        self._notify(info)
        return clip

    def set_clip_muted(self, clip_id: str, muted: bool) -> TimelineClip:
        with self._lock:
            clip = self._find_clip(clip_id)
            clip.muted = muted
            info = self._touch()
        self._notify(info)
        return clip

    def reverse_clip(self, clip_id: str, reversed_: bool) -> TimelineClip:
        with self._lock:
            clip = self._find_clip(clip_id)
            clip.reversed = reversed_
            info = self._touch()
        self._notify(info)
        return clip

    def set_clip_opacity(self, clip_id: str, opacity: float) -> TimelineClip:
        with self._lock:
            clip = self._find_clip(clip_id)
            clip.opacity = max(0.0, min(100.0, opacity))
            info = self._touch()
        self._notify(info)
        return clip

    def flip_clip(self, clip_id: str, flip_h: bool, flip_v: bool) -> TimelineClip:
        with self._lock:
            clip = self._find_clip(clip_id)
            clip.flipH = flip_h
            clip.flipV = flip_v
            info = self._touch()
        self._notify(info)
        return clip

    def set_clip_motion(self, clip_id: str, motion: KenBurnsMotion | None) -> TimelineClip:
        with self._lock:
            clip = self._find_clip(clip_id)
            if motion is not None:
                motion.start.scale = max(1.0, float(motion.start.scale))
                motion.end.scale = max(1.0, float(motion.end.scale))
                motion.start.focusX = max(0.0, min(100.0, float(motion.start.focusX)))
                motion.end.focusX = max(0.0, min(100.0, float(motion.end.focusX)))
                motion.start.focusY = max(0.0, min(100.0, float(motion.start.focusY)))
                motion.end.focusY = max(0.0, min(100.0, float(motion.end.focusY)))
            clip.motion = motion
            info = self._touch()
        self._notify(info)
        return clip

    def set_clip_color_correction(self, clip_id: str, **kwargs: float) -> TimelineClip:
        with self._lock:
            clip = self._find_clip(clip_id)
            cc = clip.colorCorrection
            for field in ("brightness", "contrast", "saturation", "temperature",
                          "tint", "exposure", "highlights", "shadows"):
                if field in kwargs:
                    setattr(cc, field, max(-100.0, min(100.0, kwargs[field])))
            info = self._touch()
        self._notify(info)
        return clip

    def set_clip_transition(
        self, clip_id: str, side: str, transition_type: str, duration: float
    ) -> TimelineClip:
        with self._lock:
            clip = self._find_clip(clip_id)
            t = ClipTransition(type=transition_type, duration=max(0.0, duration))
            if side == "in":
                clip.transitionIn = t
            elif side == "out":
                clip.transitionOut = t
            else:
                raise ValueError(f"side must be 'in' or 'out', got '{side}'")
            info = self._touch()
        self._notify(info)
        return clip

    def add_clip_effect(
        self, clip_id: str, effect_type: str, params: dict[str, float] | None = None
    ) -> tuple[TimelineClip, ClipEffect]:
        with self._lock:
            clip = self._find_clip(clip_id)
            effect = ClipEffect(
                id=_new_id("effect"),
                type=effect_type,
                params=params or _default_effect_params(effect_type),
            )
            clip.effects.append(effect)
            info = self._touch()
        self._notify(info)
        return clip, effect

    def remove_clip_effect(self, clip_id: str, effect_id: str) -> TimelineClip:
        with self._lock:
            clip = self._find_clip(clip_id)
            before = len(clip.effects)
            clip.effects = [e for e in clip.effects if e.id != effect_id]
            if len(clip.effects) == before:
                raise KeyError(f"Effect not found: {effect_id}")
            info = self._touch()
        self._notify(info)
        return clip

    def update_clip_effect(
        self, clip_id: str, effect_id: str, params: dict[str, float]
    ) -> tuple[TimelineClip, ClipEffect]:
        with self._lock:
            clip = self._find_clip(clip_id)
            for effect in clip.effects:
                if effect.id == effect_id:
                    effect.params.update(params)
                    info = self._touch()
                    self._notify(info)
                    return clip, effect
            raise KeyError(f"Effect not found: {effect_id}")

    # ── Subtitle management ───────────────────────────────────────────────────

    def _ensure_subtitle_track(self, tl: "Timeline", ordinal: int) -> int:
        """Return the absolute track index of the ordinal-th subtitle track.

        Subtitle tracks are auto-created by appending (never inserting), so
        existing clip / subtitle trackIndex values are never shifted.
        ``ordinal=0`` → first subtitle track, ``ordinal=1`` → second, etc.
        """
        subtitle_indices = [i for i, t in enumerate(tl.tracks) if t.type == "subtitle"]
        while len(subtitle_indices) <= ordinal:
            new_track = Track(
                id=_new_id("track"),
                name="Subtitles",
                kind=None,
                type="subtitle",
            )
            tl.tracks.append(new_track)
            subtitle_indices.append(len(tl.tracks) - 1)
        return subtitle_indices[ordinal]

    def resolve_subtitle_track_index(self, ordinal: int) -> int | None:
        """Return the absolute track index of the ordinal-th subtitle track, or None."""
        with self._lock:
            tl = self._active_timeline()
            subtitle_indices = [i for i, t in enumerate(tl.tracks) if t.type == "subtitle"]
            return subtitle_indices[ordinal] if ordinal < len(subtitle_indices) else None

    def subtitle_track_ordinal(self, abs_index: int) -> int | None:
        """Return the ordinal of the subtitle track at abs_index, or None if it's not a subtitle track."""
        with self._lock:
            tl = self._active_timeline()
            subtitle_indices = [i for i, t in enumerate(tl.tracks) if t.type == "subtitle"]
            return subtitle_indices.index(abs_index) if abs_index in subtitle_indices else None

    def add_subtitle(
        self,
        text: str,
        start_time: float,
        end_time: float,
        track_index: int = 0,
        style: dict[str, Any] | None = None,
    ) -> SubtitleClip:
        with self._lock:
            tl = self._active_timeline()
            # track_index is an ordinal among subtitle tracks (0 = first, 1 = second …).
            # Subtitle tracks are appended as needed so no existing indices shift.
            actual_index = self._ensure_subtitle_track(tl, track_index)
            validated_style = SubtitleStyle.model_validate(style) if style else None

            # If the track has progressiveMode enabled, split the text into
            # word chunks instead of storing one long subtitle.
            track = tl.tracks[actual_index]
            track_style_raw = track.subtitleStyle or {}
            progressive = bool(track_style_raw.get("progressiveMode", False))
            words_per_chunk = int(track_style_raw.get("wordsPerChunk", 4))

            if progressive:
                return self._add_subtitle_progressive(
                    tl, text, start_time, end_time, actual_index, validated_style, words_per_chunk
                )

            sub = SubtitleClip(
                id=_new_id("sub"),
                text=text,
                startTime=start_time,
                endTime=end_time,
                trackIndex=actual_index,
                style=validated_style,
            )
            tl.subtitles.append(sub)
            info = self._touch()
        self._notify(info)
        return sub

    def _add_subtitle_progressive(
        self,
        tl: "Timeline",
        text: str,
        start_time: float,
        end_time: float,
        actual_index: int,
        style: SubtitleStyle | None,
        words_per_chunk: int,
    ) -> SubtitleClip:
        """Split text into sequential word-chunk clips (TikTok-style captions).

        Must be called inside the lock. Returns the first chunk clip.
        """
        words = text.strip().split()
        chunks = [
            " ".join(words[i : i + words_per_chunk])
            for i in range(0, len(words), words_per_chunk)
        ] or [text]

        total_duration = end_time - start_time
        total_chars = sum(len(c) for c in chunks) or 1

        first: SubtitleClip | None = None
        cursor = start_time
        for i, chunk_text in enumerate(chunks):
            chunk_end = end_time if i == len(chunks) - 1 else cursor + total_duration * (len(chunk_text) / total_chars)
            sub = SubtitleClip(
                id=_new_id("sub"),
                text=chunk_text,
                startTime=round(cursor, 3),
                endTime=round(chunk_end, 3),
                trackIndex=actual_index,
                style=style,
            )
            tl.subtitles.append(sub)
            if first is None:
                first = sub
            cursor = chunk_end

        info = self._touch()
        self._notify(info)
        assert first is not None
        return first

    def update_subtitle(
        self,
        subtitle_id: str,
        text: str | None = None,
        start_time: float | None = None,
        end_time: float | None = None,
    ) -> SubtitleClip:
        with self._lock:
            for sub in self._active_timeline().subtitles:
                if sub.id == subtitle_id:
                    if text is not None:
                        sub.text = text
                    if start_time is not None:
                        sub.startTime = start_time
                    if end_time is not None:
                        sub.endTime = end_time
                    info = self._touch()
                    self._notify(info)
                    return sub
            raise KeyError(f"Subtitle not found: {subtitle_id}")

    def remove_subtitle(self, subtitle_id: str) -> None:
        with self._lock:
            tl = self._active_timeline()
            before = len(tl.subtitles)
            tl.subtitles = [s for s in tl.subtitles if s.id != subtitle_id]
            if len(tl.subtitles) == before:
                raise KeyError(f"Subtitle not found: {subtitle_id}")
            info = self._touch()
        self._notify(info)

    def set_subtitle_style(self, subtitle_id: str, **style_kwargs: object) -> SubtitleClip:
        with self._lock:
            for sub in self._active_timeline().subtitles:
                if sub.id == subtitle_id:
                    if sub.style is None:
                        sub.style = SubtitleStyle()
                    for k, v in style_kwargs.items():
                        if hasattr(sub.style, k):
                            setattr(sub.style, k, v)
                    info = self._touch()
                    self._notify(info)
                    return sub
            raise KeyError(f"Subtitle not found: {subtitle_id}")

    def set_subtitle_track_style(self, track_index: int, **style_kwargs: object) -> list[SubtitleClip]:
        with self._lock:
            tl = self._active_timeline()
            # Resolve ordinal → absolute index (same semantics as add_subtitle).
            subtitle_indices = [i for i, t in enumerate(tl.tracks) if t.type == "subtitle"]
            if track_index >= len(subtitle_indices):
                return []
            abs_index = subtitle_indices[track_index]

            # Track-level settings (not per-subtitle style) are stored on the track.
            track_only_keys = {"progressiveMode", "wordsPerChunk"}
            track_kwargs = {k: v for k, v in style_kwargs.items() if k in track_only_keys}
            sub_style_kwargs = {k: v for k, v in style_kwargs.items() if k not in track_only_keys}

            # Apply per-subtitle style fields (only recognised SubtitleStyle fields).
            updated: list[SubtitleClip] = []
            normalized_style = {
                key: value
                for key, value in sub_style_kwargs.items()
                if hasattr(SubtitleStyle(), key)
            }
            for sub in tl.subtitles:
                if sub.trackIndex != abs_index:
                    continue
                if sub.style is None:
                    sub.style = SubtitleStyle()
                for key, value in normalized_style.items():
                    setattr(sub.style, key, value)
                updated.append(sub)

            # Persist all style + track-level fields on the track.
            existing = tl.tracks[abs_index].subtitleStyle or {}
            tl.tracks[abs_index].subtitleStyle = {**existing, **normalized_style, **track_kwargs}

            info = self._touch()
        self._notify(info)
        return updated

    def get_subtitles(self) -> list[SubtitleClip]:
        with self._lock:
            return list(self._active_timeline().subtitles)

    # ── Track management ─────────────────────────────────────────────────────

    def add_track(
        self,
        name: str,
        kind: str,
        position: int | None = None,
        track_type: str | None = None,
    ) -> Track:
        with self._lock:
            tl = self._active_timeline()
            track = Track(
                id=_new_id("track"),
                name=name,
                kind=kind,
                type=track_type,
            )
            if position is not None and 0 <= position <= len(tl.tracks):
                tl.tracks.insert(position, track)
                # Shift trackIndex for clips and subtitles at or after the insertion point
                for c in tl.clips:
                    if c.trackIndex >= position:
                        c.trackIndex += 1
                for s in tl.subtitles:
                    if s.trackIndex >= position:
                        s.trackIndex += 1
            else:
                tl.tracks.append(track)
            info = self._touch()
        self._notify(info)
        return track

    def remove_track(self, track_id: str) -> None:
        with self._lock:
            tl = self._active_timeline()
            if len(tl.tracks) <= 1:
                raise ValueError("Cannot remove the last track")
            idx = next((i for i, t in enumerate(tl.tracks) if t.id == track_id), None)
            if idx is None:
                raise KeyError(f"Track not found: {track_id}")
            tl.tracks.pop(idx)
            # Remove clips and subtitles on the deleted track, shift others down
            tl.clips = [c for c in tl.clips if c.trackIndex != idx]
            for c in tl.clips:
                if c.trackIndex > idx:
                    c.trackIndex -= 1
            tl.subtitles = [s for s in tl.subtitles if s.trackIndex != idx]
            for s in tl.subtitles:
                if s.trackIndex > idx:
                    s.trackIndex -= 1
            info = self._touch()
        self._notify(info)

    def reorder_track(self, track_id: str, new_position: int) -> list[Track]:
        with self._lock:
            tl = self._active_timeline()
            old_idx = next((i for i, t in enumerate(tl.tracks) if t.id == track_id), None)
            if old_idx is None:
                raise KeyError(f"Track not found: {track_id}")
            new_pos = max(0, min(new_position, len(tl.tracks) - 1))
            if old_idx == new_pos:
                return list(tl.tracks)
            track = tl.tracks.pop(old_idx)
            tl.tracks.insert(new_pos, track)
            # The track that was at old_idx moved to new_pos; all between shifted by ±1
            for c in tl.clips:
                if c.trackIndex == old_idx:
                    c.trackIndex = new_pos
                elif old_idx < new_pos and old_idx < c.trackIndex <= new_pos:
                    c.trackIndex -= 1
                elif old_idx > new_pos and new_pos <= c.trackIndex < old_idx:
                    c.trackIndex += 1
            for s in tl.subtitles:
                if s.trackIndex == old_idx:
                    s.trackIndex = new_pos
                elif old_idx < new_pos and old_idx < s.trackIndex <= new_pos:
                    s.trackIndex -= 1
                elif old_idx > new_pos and new_pos <= s.trackIndex < old_idx:
                    s.trackIndex += 1
            info = self._touch()
        self._notify(info)
        return list(tl.tracks)

    def set_track_properties(self, track_id: str, **kwargs: Any) -> Track:
        with self._lock:
            tl = self._active_timeline()
            for track in tl.tracks:
                if track.id == track_id:
                    for k, v in kwargs.items():
                        if hasattr(track, k) and k != "id":
                            setattr(track, k, v)
                    info = self._touch()
                    self._notify(info)
                    return track
            raise KeyError(f"Track not found: {track_id}")

    # ── Text overlay clip ─────────────────────────────────────────────────────

    def add_text_clip(
        self,
        track_index: int,
        start_time: float,
        duration: float,
        style: dict[str, Any] | None = None,
    ) -> TimelineClip:
        with self._lock:
            text_style = TextOverlayStyle.model_validate(style or {})
            clip = TimelineClip(
                id=_new_id("clip"),
                assetId=None,
                type="text",
                startTime=start_time,
                duration=duration,
                trimStart=0.0,
                trimEnd=duration,
                trackIndex=track_index,
                asset=None,
                textStyle=text_style,
            )
            self._active_timeline().clips.append(clip)
            info = self._touch()
        self._notify(info)
        return clip

    def update_text_clip_style(self, clip_id: str, **style_kwargs: object) -> TimelineClip:
        with self._lock:
            clip = self._find_clip(clip_id)
            if clip.type != "text":
                raise ValueError(f"Clip {clip_id} is not a text clip (type={clip.type})")
            if clip.textStyle is None:
                clip.textStyle = TextOverlayStyle()
            for k, v in style_kwargs.items():
                if hasattr(clip.textStyle, k):
                    setattr(clip.textStyle, k, v)
            info = self._touch()
        self._notify(info)
        return clip

    # ── Generic clip update ──────────────────────────────────────────────────

    def update_clip(self, clip_id: str, **kwargs: Any) -> TimelineClip:
        """Generic clip updater — set any field(s) on a clip.

        Delegates to dedicated setters where validation is needed (speed, volume,
        opacity, color correction, transitions). For other fields, sets directly.
        """
        with self._lock:
            clip = self._find_clip(clip_id)
            for k, v in kwargs.items():
                if k == "id":
                    continue
                if hasattr(clip, k):
                    setattr(clip, k, v)
            info = self._touch()
        self._notify(info)
        return clip

    def retake_clip(self, clip_id: str, take_index: int) -> TimelineClip:
        """Switch a clip to use a different take of its asset.

        Updates the clip's takeIndex and its embedded asset url/path/thumbnail
        to match the selected take. Also updates any linked clips.
        """
        with self._lock:
            clip = self._find_clip(clip_id)
            if not clip.assetId:
                raise ValueError(f"Clip {clip_id} has no asset")
            asset = self.get_asset(clip.assetId)
            if not asset.takes or take_index >= len(asset.takes):
                raise ValueError(f"Take index {take_index} out of range")
            take = asset.takes[take_index]
            take_url = take.get("url", asset.url)
            take_path = take.get("path", asset.path)
            take_thumbnail = take.get("thumbnail")

            # Update the asset
            asset.activeTakeIndex = take_index
            asset.url = take_url
            asset.path = take_path
            if take_thumbnail:
                asset.thumbnail = take_thumbnail

            # Update the clip and any linked clips
            clip_ids = [clip_id] + (clip.linkedClipIds or [])
            for cid in clip_ids:
                try:
                    c = self._find_clip(cid)
                    c.takeIndex = take_index
                    if c.asset:
                        c.asset.url = take_url
                        c.asset.path = take_path
                        c.asset.activeTakeIndex = take_index
                        if take_thumbnail:
                            c.asset.thumbnail = take_thumbnail
                except KeyError:
                    pass

            info = self._touch()
        self._notify(info)
        return clip


# ── Effect default params ─────────────────────────────────────────────────────

_EFFECT_DEFAULTS: dict[str, dict[str, float]] = {
    "blur":           {"amount": 5.0},
    "sharpen":        {"amount": 50.0},
    "glow":           {"amount": 30.0, "radius": 10.0},
    "vignette":       {"amount": 50.0},
    "grain":          {"amount": 30.0},
    "lut-cinematic":  {"intensity": 100.0},
    "lut-vintage":    {"intensity": 100.0},
    "lut-bw":         {"intensity": 100.0},
    "lut-cool":       {"intensity": 100.0},
    "lut-warm":       {"intensity": 100.0},
    "lut-muted":      {"intensity": 100.0},
    "lut-vivid":      {"intensity": 100.0},
}


def _default_effect_params(effect_type: str) -> dict[str, float]:
    return dict(_EFFECT_DEFAULTS.get(effect_type, {"amount": 50.0}))
