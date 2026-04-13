from __future__ import annotations

from mcp_server.project_state import ProjectStore
from mcp_server.tool_annotations import build_tool_annotations
from mcp_server.tools.export import _primary_visual_track_index


def test_build_tool_annotations_marks_read_only_tools() -> None:
    annotations = build_tool_annotations("inspect_timeline")

    assert annotations.readOnlyHint is True
    assert annotations.idempotentHint is True
    assert annotations.destructiveHint is False


def test_build_tool_annotations_marks_mutating_tools() -> None:
    annotations = build_tool_annotations("open_project")

    assert annotations.readOnlyHint is False


def test_primary_visual_track_index_prefers_top_enabled_visual_track(tmp_path) -> None:
    store = ProjectStore(tmp_path / "mcp_projects")
    store.create_project("Export Tracks")

    bg_asset = store.add_asset(str(tmp_path / "bg.png"), "image", 10.0, "1920x1080")
    top_asset = store.add_asset(str(tmp_path / "top.png"), "image", 10.0, "1920x1080")

    store.add_clip(bg_asset.id, 0, 0.0, 0.0, 10.0)
    store.add_clip(top_asset.id, 1, 0.0, 0.0, 10.0)

    timeline = store.get_active().timelines[0]

    assert _primary_visual_track_index(timeline) == 1


def test_set_subtitle_track_style_updates_all_matching_subtitles(tmp_path) -> None:
    store = ProjectStore(tmp_path / "mcp_projects")
    store.create_project("Subtitle Track Style")

    first = store.add_subtitle("One", 0.0, 1.0, track_index=0)
    second = store.add_subtitle("Two", 1.0, 2.0, track_index=0)
    store.add_subtitle("Elsewhere", 2.0, 3.0, track_index=1)

    updated = store.set_subtitle_track_style(0, fontSize=42.0, color="#FFEE00")

    assert [subtitle.id for subtitle in updated] == [first.id, second.id]
    assert all(subtitle.style is not None and subtitle.style.fontSize == 42.0 for subtitle in updated)
    assert all(subtitle.style is not None and subtitle.style.color == "#FFEE00" for subtitle in updated)
