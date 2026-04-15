from __future__ import annotations

from mcp_server import create_mcp_server
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


def test_create_mcp_server_excludes_ai_generation_tools_by_default(test_state) -> None:
    server = create_mcp_server(test_state)

    tool_names = {tool.name for tool in server._tool_manager.list_tools()}  # noqa: SLF001

    assert "generate_video" not in tool_names
    assert "ai_retake_clip" not in tool_names
    assert "fill_gap" not in tool_names
    assert "get_generation_status" not in tool_names
    assert "cancel_generation" not in tool_names
    assert "retake_clip" in tool_names


def test_create_mcp_server_includes_ai_generation_tools_when_enabled(test_state) -> None:
    test_state.state.app_settings.mcp_modules["ai_generation"] = True

    server = create_mcp_server(test_state)

    tool_names = {tool.name for tool in server._tool_manager.list_tools()}  # noqa: SLF001

    assert "generate_video" in tool_names
    assert "ai_retake_clip" in tool_names
    assert "retake_clip" in tool_names
    assert "fill_gap" in tool_names
    assert "get_generation_status" in tool_names
    assert "cancel_generation" in tool_names


def test_create_mcp_server_respects_individual_ai_tool_toggles(test_state) -> None:
    test_state.state.app_settings.mcp_modules["ai_generation"] = True
    test_state.state.app_settings.mcp_tools["ai_generation"]["generate_video"] = False
    test_state.state.app_settings.mcp_tools["ai_generation"]["fill_gap"] = False

    server = create_mcp_server(test_state)

    tool_names = {tool.name for tool in server._tool_manager.list_tools()}  # noqa: SLF001

    assert "generate_video" not in tool_names
    assert "ai_retake_clip" in tool_names
    assert "fill_gap" not in tool_names
    assert "get_generation_status" in tool_names
    assert "cancel_generation" in tool_names


def test_create_mcp_server_respects_non_ai_module_toggle(test_state) -> None:
    test_state.state.app_settings.mcp_modules["text_overlay"] = False

    server = create_mcp_server(test_state)

    tool_names = {tool.name for tool in server._tool_manager.list_tools()}  # noqa: SLF001

    assert "add_text_clip" not in tool_names
    assert "update_text_clip_style" not in tool_names
    assert "add_subtitle" in tool_names


def test_create_mcp_server_respects_non_ai_tool_toggle(test_state) -> None:
    test_state.state.app_settings.mcp_tools["timeline"]["preview_clip"] = False

    server = create_mcp_server(test_state)

    tool_names = {tool.name for tool in server._tool_manager.list_tools()}  # noqa: SLF001

    assert "preview_clip" not in tool_names
    assert "preview_frame" in tool_names
    assert "add_clip" in tool_names


def test_create_mcp_server_stdio_excludes_preview_tools(test_state) -> None:
    server = create_mcp_server(test_state, transport="stdio")

    tool_names = {tool.name for tool in server._tool_manager.list_tools()}  # noqa: SLF001

    assert "preview_clip" in tool_names
    assert "preview_frame" in tool_names
    assert "export_timeline" in tool_names
