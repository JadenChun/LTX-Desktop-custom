from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from mcp_server.project_state import Project, SubtitleClip, Timeline, TimelineClip, Track


_LETTERBOX_RATIO_MAP: dict[str, float] = {
    "2.35:1": 2.35,
    "2.39:1": 2.39,
    "2.76:1": 2.76,
    "1.85:1": 1.85,
    "4:3": 4 / 3,
}


@dataclass(frozen=True)
class ActiveLetterboxState:
    ratio: float
    color: str
    opacity: float
    key: str


@dataclass(frozen=True)
class DissolvePair:
    outgoing: "TimelineClip"
    incoming: "TimelineClip"


@dataclass(frozen=True)
class TimelineRenderState:
    time: float
    active_clip: "TimelineClip | None"
    cross_dissolve: DissolvePair | None
    cross_dissolve_progress: float
    compositing_stack: list["TimelineClip"]
    active_text_clips: list["TimelineClip"]
    active_subtitles: list["SubtitleClip"]
    active_letterbox: ActiveLetterboxState | None
    audio_only_clips: list["TimelineClip"]
    active_video_contributors: list[dict[str, Any]]


def resolve_active_timeline(project: "Project") -> "Timeline":
    if not project.timelines:
        raise RuntimeError("Project has no timelines")
    for timeline in project.timelines:
        if timeline.id == project.activeTimelineId:
            return timeline
    return project.timelines[0]


def clip_active_at_time(clip: "TimelineClip", time: float) -> bool:
    return time >= clip.startTime and time < clip.startTime + clip.duration


def track_output_disabled(tracks: list["Track"], track_index: int) -> bool:
    return bool(0 <= track_index < len(tracks) and tracks[track_index].enabled is False)


def get_top_visible_clip_at_time(
    media_clips: list["TimelineClip"],
    tracks: list["Track"],
    time: float,
) -> "TimelineClip | None":
    best: tuple["TimelineClip", int] | None = None

    for array_index, clip in enumerate(media_clips):
        if track_output_disabled(tracks, clip.trackIndex):
            continue
        if not clip_active_at_time(clip, time):
            continue
        if best is None:
            best = (clip, array_index)
            continue
        best_clip, best_array_index = best
        if clip.trackIndex > best_clip.trackIndex or (
            clip.trackIndex == best_clip.trackIndex and array_index > best_array_index
        ):
            best = (clip, array_index)

    return best[0] if best is not None else None


def get_dissolve_at_time(
    media_clips: list["TimelineClip"],
    tracks: list["Track"],
    time: float,
) -> tuple[DissolvePair, float] | None:
    for clip_a in media_clips:
        if track_output_disabled(tracks, clip_a.trackIndex):
            continue
        if clip_a.transitionOut.type != "dissolve" or clip_a.transitionOut.duration <= 0:
            continue
        clip_a_end = clip_a.startTime + clip_a.duration
        dissolve_start = clip_a_end - clip_a.transitionOut.duration
        if time < dissolve_start or time >= clip_a_end:
            continue
        for candidate in media_clips:
            if candidate.id == clip_a.id:
                continue
            if track_output_disabled(tracks, candidate.trackIndex):
                continue
            if candidate.trackIndex != clip_a.trackIndex:
                continue
            if candidate.transitionIn.type != "dissolve":
                continue
            if abs(candidate.startTime - clip_a_end) >= 0.05:
                continue
            progress = max(
                0.0,
                min(1.0, (time - dissolve_start) / clip_a.transitionOut.duration),
            )
            return (DissolvePair(outgoing=clip_a, incoming=candidate), progress)
    return None


def get_active_text_clips(
    text_clips: list["TimelineClip"],
    tracks: list["Track"],
    time: float,
) -> list["TimelineClip"]:
    return sorted(
        [
            clip
            for clip in text_clips
            if not track_output_disabled(tracks, clip.trackIndex) and clip_active_at_time(clip, time)
        ],
        key=lambda clip: clip.trackIndex,
    )


def get_active_subtitles(
    subtitles: list["SubtitleClip"],
    tracks: list["Track"],
    time: float,
) -> list["SubtitleClip"]:
    active: list["SubtitleClip"] = []
    for subtitle in subtitles:
        if not (0 <= subtitle.trackIndex < len(tracks)):
            continue
        if tracks[subtitle.trackIndex].muted:
            continue
        if time >= subtitle.startTime and time < subtitle.endTime:
            active.append(subtitle)
    return active


def get_active_letterbox(
    adjustment_clips: list["TimelineClip"],
    tracks: list["Track"],
    time: float,
) -> ActiveLetterboxState | None:
    active_adjustments = sorted(
        [
            clip
            for clip in adjustment_clips
            if not track_output_disabled(tracks, clip.trackIndex) and clip_active_at_time(clip, time)
        ],
        key=lambda clip: clip.trackIndex,
        reverse=True,
    )

    for clip in active_adjustments:
        letterbox = clip.letterbox
        if not letterbox or not letterbox.get("enabled"):
            continue
        ratio = (
            letterbox.get("customRatio", 2.35)
            if letterbox.get("aspectRatio") == "custom"
            else _LETTERBOX_RATIO_MAP.get(str(letterbox.get("aspectRatio")), 2.35)
        )
        color = str(letterbox.get("color", "#000000"))
        opacity = float(letterbox.get("opacity", 100)) / 100
        return ActiveLetterboxState(
            ratio=ratio,
            color=color,
            opacity=opacity,
            key=f"{clip.id}:{ratio}:{color}:{letterbox.get('opacity', 100)}",
        )

    return None


def get_compositing_stack(
    media_clips: list["TimelineClip"],
    tracks: list["Track"],
    active_clip: "TimelineClip | None",
    time: float,
) -> list["TimelineClip"]:
    if active_clip is None or active_clip.opacity >= 100:
        return []

    return sorted(
        [
            clip
            for clip in media_clips
            if clip.id != active_clip.id
            and not track_output_disabled(tracks, clip.trackIndex)
            and clip.trackIndex < active_clip.trackIndex
            and clip_active_at_time(clip, time)
        ],
        key=lambda clip: clip.trackIndex,
    )


def clip_visual_opacity(clip: "TimelineClip", time: float) -> float:
    opacity = clip.opacity / 100
    time_in_clip = max(0.0, time - clip.startTime)
    transition_in = clip.transitionIn
    transition_out = clip.transitionOut

    if transition_in.duration > 0 and time_in_clip < transition_in.duration:
        if transition_in.type in ("fade-to-black", "fade-to-white"):
            opacity = min(opacity, time_in_clip / transition_in.duration)

    if transition_out.duration > 0:
        time_from_end = clip.duration - time_in_clip
        if time_from_end < transition_out.duration:
            if transition_out.type in ("fade-to-black", "fade-to-white"):
                opacity = min(opacity, time_from_end / transition_out.duration)

    return opacity


def get_active_video_contributors(
    active_clip: "TimelineClip | None",
    cross_dissolve: DissolvePair | None,
    cross_dissolve_progress: float,
    compositing_stack: list["TimelineClip"],
    time: float,
) -> list[dict[str, Any]]:
    contributors: list[dict[str, Any]] = []
    primary_clip = cross_dissolve.outgoing if cross_dissolve is not None else active_clip

    if primary_clip is not None and primary_clip.asset is not None and primary_clip.asset.type == "video":
        primary_opacity = (
            (1 - cross_dissolve_progress) * (cross_dissolve.outgoing.opacity / 100)
            if cross_dissolve is not None
            else clip_visual_opacity(primary_clip, time)
        )
        contributors.append({
            "clipId": primary_clip.id,
            "target": "active",
            "role": "primary",
            "opacity": primary_opacity,
        })

    if cross_dissolve is not None:
        incoming = cross_dissolve.incoming
        if incoming.asset is not None and incoming.asset.type == "video":
            contributors.append({
                "clipId": incoming.id,
                "target": "incoming",
                "role": "dissolveIncoming",
                "opacity": cross_dissolve_progress * (incoming.opacity / 100),
            })

    for clip in compositing_stack:
        if clip.asset is None or clip.asset.type != "video":
            continue
        contributors.append({
            "clipId": clip.id,
            "target": "compositing",
            "role": "compositing",
            "opacity": clip_visual_opacity(clip, time),
        })

    return contributors


def derive_render_state(timeline: "Timeline", time: float) -> TimelineRenderState:
    media_clips = [
        clip
        for clip in timeline.clips
        if clip.type not in ("audio", "adjustment", "text")
    ]
    text_clips = [
        clip
        for clip in timeline.clips
        if clip.type == "text" and clip.textStyle is not None
    ]
    adjustment_clips = [
        clip
        for clip in timeline.clips
        if clip.type == "adjustment"
    ]
    audio_clips = [
        clip
        for clip in timeline.clips
        if clip.type == "audio"
    ]

    active_clip = get_top_visible_clip_at_time(media_clips, timeline.tracks, time)
    dissolve = get_dissolve_at_time(media_clips, timeline.tracks, time)
    cross_dissolve = dissolve[0] if dissolve is not None else None
    cross_dissolve_progress = dissolve[1] if dissolve is not None else 0.0
    compositing_stack = get_compositing_stack(media_clips, timeline.tracks, active_clip, time)

    return TimelineRenderState(
        time=time,
        active_clip=active_clip,
        cross_dissolve=cross_dissolve,
        cross_dissolve_progress=cross_dissolve_progress,
        compositing_stack=compositing_stack,
        active_text_clips=get_active_text_clips(text_clips, timeline.tracks, time),
        active_subtitles=get_active_subtitles(timeline.subtitles, timeline.tracks, time),
        active_letterbox=get_active_letterbox(adjustment_clips, timeline.tracks, time),
        audio_only_clips=[
            clip
            for clip in audio_clips
            if clip_active_at_time(clip, time)
        ],
        active_video_contributors=get_active_video_contributors(
            active_clip,
            cross_dissolve,
            cross_dissolve_progress,
            compositing_stack,
            time,
        ),
    )


def inspect_timeline_render_state(timeline: "Timeline", time: float) -> dict[str, Any]:
    render_state = derive_render_state(timeline, time)
    return {
        "time": render_state.time,
        "activeClip": render_state.active_clip.model_dump() if render_state.active_clip is not None else None,
        "crossDissolve": (
            {
                "outgoing": render_state.cross_dissolve.outgoing.model_dump(),
                "incoming": render_state.cross_dissolve.incoming.model_dump(),
            }
            if render_state.cross_dissolve is not None
            else None
        ),
        "crossDissolveProgress": render_state.cross_dissolve_progress,
        "compositingStack": [clip.model_dump() for clip in render_state.compositing_stack],
        "activeTextClips": [clip.model_dump() for clip in render_state.active_text_clips],
        "activeSubtitles": [subtitle.model_dump() for subtitle in render_state.active_subtitles],
        "activeLetterbox": (
            None
            if render_state.active_letterbox is None
            else {
                "ratio": render_state.active_letterbox.ratio,
                "color": render_state.active_letterbox.color,
                "opacity": render_state.active_letterbox.opacity,
                "key": render_state.active_letterbox.key,
            }
        ),
        "audioOnlyClips": [clip.model_dump() for clip in render_state.audio_only_clips],
        "activeVideoContributors": render_state.active_video_contributors,
    }


def timeline_duration(timeline: "Timeline") -> float:
    duration = 0.0
    for clip in timeline.clips:
        duration = max(duration, clip.startTime + clip.duration)
    for subtitle in timeline.subtitles:
        duration = max(duration, subtitle.endTime)
    return duration


def build_track_summary(timeline: "Timeline") -> list[dict[str, Any]]:
    summary: list[dict[str, Any]] = []
    for track_index, track in enumerate(timeline.tracks):
        clips = [clip for clip in timeline.clips if clip.trackIndex == track_index]
        subtitles = [subtitle for subtitle in timeline.subtitles if subtitle.trackIndex == track_index]
        visual_media = [
            clip for clip in clips
            if clip.type in {"video", "image"} and clip.assetId is not None
        ]
        summary.append({
            "index": track_index,
            "id": track.id,
            "name": track.name,
            "kind": track.kind,
            "type": track.type,
            "enabled": track.enabled,
            "muted": track.muted,
            "clipCount": len(clips),
            "subtitleCount": len(subtitles),
            "hasVisualMedia": bool(visual_media),
            "hasTextOverlays": any(clip.type == "text" for clip in clips),
        })
    return summary


def primary_visible_video_track(summary: list[dict[str, Any]]) -> dict[str, Any] | None:
    for track in reversed(summary):
        if track["enabled"] and track["hasVisualMedia"]:
            return track
    return None
