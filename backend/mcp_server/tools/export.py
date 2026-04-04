# pyright: reportUnusedFunction=false

"""MCP tools for timeline export."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any

from mcp.server.fastmcp import FastMCP

if TYPE_CHECKING:
    from mcp_server.project_state import ProjectStore

# In-memory export job registry (keyed by job_id)
_export_jobs: dict[str, dict[str, Any]] = {}


def register_export_tools(mcp: FastMCP, store: "ProjectStore") -> None:
    """Register export tools on the MCP server."""

    @mcp.tool()
    async def export_timeline(output_filename: str | None = None, width: int = 1920, height: int = 1080) -> dict[str, Any]:
        """Export the active project timeline to an MP4 file.

        Concatenates all clips on track 0 (V1) in startTime order using ffmpeg.
        This is a basic agent-export — it does not apply effects, transitions,
        color correction, or subtitles. For full-quality export with those features,
        import the project into LTX Desktop UI and use its built-in export instead.

        The export runs asynchronously. Poll get_export_status(job_id) to check progress.

        Args:
            output_filename: Optional MP4 filename (no path). If omitted, uses the
                             project name with a timestamp.
            width: Output video width (default 1920). Use 1080 for vertical 1080p.
            height: Output video height (default 1080). Use 1920 for vertical 1080p.

        Returns:
            {"job_id": str, "output_path": str, "status": "pending"}
        """
        project = store.get_active()
        tl = store._active_timeline()  # noqa: SLF001  # pyright: ignore[reportPrivateUsage]
        clips = sorted(
            [c for c in tl.clips if c.trackIndex == 0 and c.assetId is not None],
            key=lambda c: c.startTime,
        )
        if not clips:
            raise RuntimeError("No clips on track 0 to export.")

        outputs_dir = Path(store._state_dir).parent  # noqa: SLF001  # pyright: ignore[reportPrivateUsage]
        export_dir = outputs_dir / "exports"
        export_dir.mkdir(parents=True, exist_ok=True)

        if output_filename is None:
            safe_name = "".join(c if c.isalnum() or c in "-_ " else "_" for c in project.name)
            output_filename = f"{safe_name}_{project.id[-9:]}.mp4"
        output_path = str(export_dir / output_filename)

        job_id = f"export-{uuid.uuid4().hex[:9]}"
        _export_jobs[job_id] = {"status": "pending", "output_path": output_path, "error": None}

        asyncio.get_event_loop().create_task(
            _run_export(job_id, clips, output_path, width, height)
        )

        return {"job_id": job_id, "output_path": output_path, "status": "pending"}

    @mcp.tool()
    async def get_export_status(job_id: str) -> dict[str, Any]:
        """Poll the status of an export job.

        Args:
            job_id: The job id returned by export_timeline.

        Returns:
            {"job_id": str, "status": "pending"|"running"|"complete"|"error",
             "output_path": str, "error": str|null}
        """
        if job_id not in _export_jobs:
            raise KeyError(f"Export job not found: {job_id}")
        return {"job_id": job_id, **_export_jobs[job_id]}


async def _run_export(
    job_id: str,
    clips: list[Any],
    output_path: str,
    width: int = 1920,
    height: int = 1080,
) -> None:
    """Background task: concatenate clips using ffmpeg."""
    import tempfile

    _export_jobs[job_id]["status"] = "running"
    try:
        import imageio_ffmpeg  # type: ignore[import]

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()

        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            segment_paths: list[str] = []

            # Extract each clip as a trimmed segment
            for i, clip in enumerate(clips):
                seg_path = str(tmp / f"seg_{i:04d}.mp4")
                cmd = [
                    ffmpeg, "-y",
                    "-ss", str(clip.trimStart),
                    "-i", clip.asset.path,
                    "-t", str(clip.trimEnd - clip.trimStart),
                    "-vf", f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:-1:-1:color=black",
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
                    raise RuntimeError(
                        f"ffmpeg failed for segment {i}: {stderr.decode()[-500:]}"
                    )
                segment_paths.append(seg_path)

            # Write concat list
            concat_list = tmp / "concat.txt"
            concat_list.write_text(
                "\n".join(f"file '{p}'" for p in segment_paths), encoding="utf-8"
            )

            # Concatenate
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
