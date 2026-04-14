from __future__ import annotations

from pathlib import Path
import asyncio

from PIL import Image

from mcp_server.preview_renderer import render_preview_clip, render_preview_frame
from mcp_server.project_state import ProjectStore
from mcp_server.tools.export import _export_jobs, _run_composited_preview_export


def _write_solid_image(path: Path, color: tuple[int, int, int]) -> None:
    Image.new("RGB", (1920, 1080), color).save(path)


def test_render_preview_frame_uses_selected_take_and_letterbox(tmp_path: Path) -> None:
    red_path = tmp_path / "red.png"
    blue_path = tmp_path / "blue.png"
    adjustment_path = tmp_path / "adjustment.lt"
    _write_solid_image(red_path, (255, 0, 0))
    _write_solid_image(blue_path, (0, 0, 255))
    adjustment_path.write_text("adjustment", encoding="utf-8")

    store = ProjectStore(tmp_path / "mcp_projects")
    store.create_project("Preview Frame")

    asset = store.add_asset(str(red_path), "image", 10.0, "1920x1080")
    asset.takes = [
        {"path": str(red_path), "createdAt": 1},
        {"path": str(blue_path), "createdAt": 2},
    ]
    adjustment_asset = store.add_asset(str(adjustment_path), "adjustment", 10.0, "1920x1080")

    clip = store.add_clip(asset.id, 0, 0.0, 0.0, 10.0)
    store.update_clip(clip.id, takeIndex=1)
    adjustment_clip = store.add_clip(adjustment_asset.id, 2, 0.0, 0.0, 10.0)
    store.update_clip(
        adjustment_clip.id,
        letterbox={
            "enabled": True,
            "aspectRatio": "2.39:1",
            "color": "#000000",
            "opacity": 100,
        },
    )

    result = render_preview_frame(
        project_payload=store.get_active().model_dump(),
        time=1.0,
        width=320,
        height=180,
    )

    assert Path(result["imagePath"]).exists()
    with Image.open(result["imagePath"]).convert("RGBA") as frame:
        center = frame.getpixel((160, 90))
        top = frame.getpixel((160, 2))

    assert center[2] > 240
    assert center[0] < 20
    assert top[:3] == (0, 0, 0)


def test_render_preview_frame_renders_text_clip_and_subtitle_backgrounds(tmp_path: Path) -> None:
    bg_path = tmp_path / "bg.png"
    _write_solid_image(bg_path, (0, 120, 0))

    store = ProjectStore(tmp_path / "mcp_projects")
    store.create_project("Preview Overlays")

    asset = store.add_asset(str(bg_path), "image", 10.0, "1920x1080")
    store.add_clip(asset.id, 0, 0.0, 0.0, 10.0)
    store.add_text_clip(
        1,
        0.0,
        10.0,
        {
            "text": "Overlay",
            "backgroundColor": "rgba(255,0,0,1)",
            "fontSize": 72,
            "padding": 18,
            "maxWidth": 50,
            "positionX": 50,
            "positionY": 50,
        },
    )
    store.add_subtitle(
        "Subtitle",
        0.0,
        10.0,
        0,
        style={
            "backgroundColor": "rgba(255,255,0,1)",
            "position": "bottom",
        },
    )

    result = render_preview_frame(
        project_payload=store.get_active().model_dump(),
        time=1.0,
        width=320,
        height=180,
    )

    assert Path(result["imagePath"]).exists()
    with Image.open(result["imagePath"]).convert("RGBA") as frame:
        center = frame.getpixel((160, 90))
        lower = frame.getpixel((160, 160))

    assert center[0] > 200 and center[1] < 80
    assert lower[0] > 200 and lower[1] > 200 and lower[2] < 80


def test_render_preview_clip_writes_mp4(tmp_path: Path) -> None:
    bg_path = tmp_path / "bg.png"
    _write_solid_image(bg_path, (20, 40, 220))

    store = ProjectStore(tmp_path / "mcp_projects")
    store.create_project("Preview Clip")

    asset = store.add_asset(str(bg_path), "image", 10.0, "1920x1080")
    store.add_clip(asset.id, 0, 0.0, 0.0, 10.0)

    result = render_preview_clip(
        project_payload=store.get_active().model_dump(),
        start_time=0.0,
        duration=0.5,
        width=320,
        height=180,
        fps=4,
    )

    output_path = Path(result["videoPath"])
    assert output_path.exists()
    assert output_path.stat().st_size > 0
    assert result["frameCount"] == 2
    assert result["width"] == 320
    assert result["height"] == 180


def test_composited_preview_export_writes_video_without_electron(tmp_path: Path) -> None:
    bg_path = tmp_path / "export-bg.png"
    _write_solid_image(bg_path, (80, 20, 180))

    store = ProjectStore(tmp_path / "mcp_projects")
    store.create_project("Preview Export")

    asset = store.add_asset(str(bg_path), "image", 10.0, "1920x1080")
    store.add_clip(asset.id, 0, 0.0, 0.0, 1.0)

    output_path = tmp_path / "preview-export.mp4"
    job_id = "export-test"
    _export_jobs[job_id] = {
        "status": "pending",
        "output_path": str(output_path),
        "mode": "composited_preview",
        "source_track_index": 0,
        "includes_audio": False,
        "includes_composited_visuals": True,
        "error": None,
    }

    asyncio.run(
        _run_composited_preview_export(
            job_id=job_id,
            project_payload=store.get_active().model_dump(),
            output_path=str(output_path),
            duration=1.0,
            width=320,
            height=180,
            fps=4,
        )
    )

    assert output_path.exists()
    assert output_path.stat().st_size > 0
    assert _export_jobs[job_id]["status"] == "complete"
