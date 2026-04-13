# pyright: reportUnusedFunction=false

"""MCP tools for timeline export."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp_server.electron_preview_bridge import render_preview_clip

if TYPE_CHECKING:
    from mcp_server.project_state import ProjectStore, Timeline, TimelineClip

# In-memory export job registry (keyed by job_id)
_export_jobs: dict[str, dict[str, Any]] = {}


def _timeline_duration(timeline: "Timeline") -> float:
    duration = 0.0
    for clip in timeline.clips:
        duration = max(duration, clip.startTime + clip.duration)
    for subtitle in timeline.subtitles:
        duration = max(duration, subtitle.endTime)
    return duration


def _primary_visual_track_index(timeline: "Timeline") -> int | None:
    for track_index in range(len(timeline.tracks) - 1, -1, -1):
        track = timeline.tracks[track_index]
        if track.enabled is False:
            continue
        for clip in timeline.clips:
            if clip.trackIndex == track_index and clip.assetId is not None and clip.type in {"video", "image"}:
                return track_index
    return None


def _job_payload(
    *,
    status: str,
    output_path: str,
    mode: str,
    source_track_index: int | None,
    includes_audio: bool,
    includes_composited_visuals: bool,
) -> dict[str, Any]:
    return {
        "status": status,
        "output_path": output_path,
        "mode": mode,
        "source_track_index": source_track_index,
        "includes_audio": includes_audio,
        "includes_composited_visuals": includes_composited_visuals,
        "error": None,
    }


def register_export_tools(mcp: FastMCP, store: "ProjectStore") -> None:
    """Register export tools on the MCP server."""

    @mcp.tool()
    async def export_timeline(
        output_filename: str | None = None,
        width: int = 1920,
        height: int = 1080,
        mode: Literal["primary_video_concat", "track0_concat", "composited_preview"] = "primary_video_concat",
        fps: int = 12,
    ) -> dict[str, Any]:
        """Export the active project timeline to an MP4 file.

        Modes:
        - primary_video_concat: ffmpeg concat of the highest enabled visual media track.
        - track0_concat: legacy ffmpeg concat of track 0 only.
        - composited_preview: visual export of the composed timeline via the Electron preview bridge.

        `composited_preview` preserves overlays and subtitles in the rendered frames,
        but it is currently visual-only and does not include mixed audio.

        The export runs asynchronously. Poll get_export_status(job_id) to check progress.

        Args:
            output_filename: Optional MP4 filename (no path). If omitted, uses the
                project name with a timestamp.
            width: Output video width (default 1920). Use 1080 for vertical 1080p.
            height: Output video height (default 1080). Use 1920 for vertical 1080p.
            mode: Export mode. Default is "primary_video_concat".
            fps: Frame rate for composited_preview mode (default 12, max 24).

        Returns:
            Export job metadata including mode and whether the output includes
            composited visuals and/or audio.
        """
        project = store.get_active()
        timeline = store._active_timeline()  # noqa: SLF001  # pyright: ignore[reportPrivateUsage]
        outputs_dir = Path(store._state_dir).parent  # noqa: SLF001  # pyright: ignore[reportPrivateUsage]
        export_dir = outputs_dir / "exports"
        export_dir.mkdir(parents=True, exist_ok=True)

        if output_filename is None:
            safe_name = "".join(c if c.isalnum() or c in "-_ " else "_" for c in project.name)
            suffix = "preview" if mode == "composited_preview" else "export"
            output_filename = f"{safe_name}_{project.id[-9:]}_{suffix}.mp4"
        output_path = str(export_dir / output_filename)

        job_id = f"export-{uuid.uuid4().hex[:9]}"

        if mode == "composited_preview":
            duration = _timeline_duration(timeline)
            if duration <= 0:
                raise RuntimeError("Timeline is empty; nothing to export.")
            _export_jobs[job_id] = _job_payload(
                status="pending",
                output_path=output_path,
                mode=mode,
                source_track_index=_primary_visual_track_index(timeline),
                includes_audio=False,
                includes_composited_visuals=True,
            )
            asyncio.get_event_loop().create_task(
                _run_composited_preview_export(
                    job_id=job_id,
                    project_payload=project.model_dump(),
                    output_path=output_path,
                    duration=duration,
                    width=width,
                    height=height,
                    fps=max(1, min(24, fps)),
                )
            )
            return {"job_id": job_id, **_export_jobs[job_id]}

        source_track_index = 0 if mode == "track0_concat" else _primary_visual_track_index(timeline)
        if source_track_index is None:
            raise RuntimeError("No enabled visual media track found to export.")

        clips = sorted(
            [
                clip
                for clip in timeline.clips
                if clip.trackIndex == source_track_index and clip.assetId is not None
            ],
            key=lambda clip: clip.startTime,
        )
        if not clips:
            raise RuntimeError(f"No clips on track {source_track_index} to export.")

        _export_jobs[job_id] = _job_payload(
            status="pending",
            output_path=output_path,
            mode=mode,
            source_track_index=source_track_index,
            includes_audio=True,
            includes_composited_visuals=False,
        )

        asyncio.get_event_loop().create_task(
            _run_concat_export(
                job_id=job_id,
                clips=clips,
                output_path=output_path,
                width=width,
                height=height,
            )
        )

        return {"job_id": job_id, **_export_jobs[job_id]}

    @mcp.tool()
    async def get_export_status(job_id: str) -> dict[str, Any]:
        """Poll the status of an export job.

        Args:
            job_id: The job id returned by export_timeline.

        Returns:
            Export job status plus output characteristics.
        """
        if job_id not in _export_jobs:
            raise KeyError(f"Export job not found: {job_id}")
        return {"job_id": job_id, **_export_jobs[job_id]}


async def _run_concat_export(
    *,
    job_id: str,
    clips: list["TimelineClip"],
    output_path: str,
    width: int,
    height: int,
) -> None:
    """Background task: concatenate one visual media track using ffmpeg."""
    import tempfile

    _export_jobs[job_id]["status"] = "running"
    try:
        import imageio_ffmpeg  # type: ignore[import]

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            segment_paths: list[str] = []

            for index, clip in enumerate(clips):
                if clip.asset is None:
                    raise RuntimeError(f"Clip {clip.id} is missing embedded asset metadata.")
                seg_path = str(tmp / f"seg_{index:04d}.mp4")
                cmd = [
                    ffmpeg, "-y",
                    "-ss", str(clip.trimStart),
                    "-i", clip.asset.path,
                    "-t", str(clip.trimEnd - clip.trimStart),
                    "-vf",
                    f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:-1:-1:color=black",
                    "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                    "-c:a", "aac",
                    seg_path,
                ]
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.PIPE,
                )
                _, stderr = await proc.communicate()
                if proc.returncode != 0:
                    raise RuntimeError(f"ffmpeg failed for segment {index}: {stderr.decode()[-500:]}")
                segment_paths.append(seg_path)

            concat_list = tmp / "concat.txt"
            concat_list.write_text(
                "\n".join(f"file '{path}'" for path in segment_paths),
                encoding="utf-8",
            )

            cmd = [
                ffmpeg, "-y",
                "-f", "concat", "-safe", "0",
                "-i", str(concat_list),
                "-c", "copy",
                output_path,
            ]
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                raise RuntimeError(f"ffmpeg concat failed: {stderr.decode()[-500:]}")

        _export_jobs[job_id]["status"] = "complete"
    except Exception as exc:
        _export_jobs[job_id]["status"] = "error"
        _export_jobs[job_id]["error"] = str(exc)


async def _run_composited_preview_export(
    *,
    job_id: str,
    project_payload: dict[str, Any],
    output_path: str,
    duration: float,
    width: int,
    height: int,
    fps: int,
) -> None:
    """Background task: render a composed visual timeline preview through Electron."""
    _export_jobs[job_id]["status"] = "running"
    try:
        await asyncio.to_thread(
            render_preview_clip,
            project_payload=project_payload,
            start_time=0.0,
            duration=duration,
            width=max(64, width),
            height=max(64, height),
            fps=max(1, min(24, fps)),
            output_path=output_path,
        )
        _export_jobs[job_id]["status"] = "complete"
    except Exception as exc:
        _export_jobs[job_id]["status"] = "error"
        _export_jobs[job_id]["error"] = str(exc)
