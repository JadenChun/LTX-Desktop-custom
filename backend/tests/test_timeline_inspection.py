from __future__ import annotations

from mcp_server.project_state import ProjectStore
from mcp_server.tools.timeline import _inspect_timeline_render_state


def test_inspect_timeline_render_state_returns_active_visual_stack(tmp_path):
    store = ProjectStore(tmp_path / "mcp_projects")
    store.create_project("Inspect Timeline")

    bg_asset = store.add_asset(str(tmp_path / "bg.png"), "image", 10.0, "1920x1080")
    overlay_asset = store.add_asset(str(tmp_path / "overlay.png"), "image", 10.0, "1920x1080")

    bg_clip = store.add_clip(bg_asset.id, 0, 0.0, 0.0, 10.0)
    overlay_clip = store.add_clip(overlay_asset.id, 1, 0.0, 0.0, 10.0)
    store.set_clip_opacity(overlay_clip.id, 50.0)
    text_clip = store.add_text_clip(2, 1.0, 4.0, {"text": "Hello world"})
    subtitle = store.add_subtitle("Subtitle text", 1.0, 3.0, 0)

    timeline = store.get_active().timelines[0]
    render_state = _inspect_timeline_render_state(timeline, 2.0)

    assert render_state["activeClip"]["id"] == overlay_clip.id
    assert [clip["id"] for clip in render_state["compositingStack"]] == [bg_clip.id]
    assert [clip["id"] for clip in render_state["activeTextClips"]] == [text_clip.id]
    assert [cue["id"] for cue in render_state["activeSubtitles"]] == [subtitle.id]


def test_inspect_timeline_render_state_reports_dissolve_and_letterbox(tmp_path):
    store = ProjectStore(tmp_path / "mcp_projects")
    store.create_project("Inspect Timeline Dissolve")

    clip_a_asset = store.add_asset(str(tmp_path / "clip-a.mp4"), "video", 5.0, "1920x1080")
    clip_b_asset = store.add_asset(str(tmp_path / "clip-b.mp4"), "video", 5.0, "1920x1080")
    adjustment_asset = store.add_asset(str(tmp_path / "adjustment.lt"), "adjustment", 10.0, "1920x1080")

    clip_a = store.add_clip(clip_a_asset.id, 0, 0.0, 0.0, 5.0)
    clip_b = store.add_clip(clip_b_asset.id, 0, 5.0, 0.0, 5.0)
    adjustment_clip = store.add_clip(adjustment_asset.id, 2, 0.0, 0.0, 10.0)
    store.set_clip_transition(clip_a.id, "out", "dissolve", 1.0)
    store.set_clip_transition(clip_b.id, "in", "dissolve", 1.0)
    store.update_clip(
        adjustment_clip.id,
        letterbox={
            "enabled": True,
            "aspectRatio": "2.39:1",
            "color": "#000000",
            "opacity": 80,
        },
    )

    timeline = store.get_active().timelines[0]
    render_state = _inspect_timeline_render_state(timeline, 4.5)

    assert render_state["crossDissolve"] is not None
    assert render_state["crossDissolve"]["outgoing"]["id"] == clip_a.id
    assert render_state["crossDissolve"]["incoming"]["id"] == clip_b.id
    assert render_state["crossDissolveProgress"] == 0.5
    assert render_state["activeLetterbox"]["ratio"] == 2.39
    assert [entry["target"] for entry in render_state["activeVideoContributors"]] == ["active", "incoming"]
