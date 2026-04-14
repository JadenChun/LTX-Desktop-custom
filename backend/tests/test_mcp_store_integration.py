from __future__ import annotations

import json
import time

from mcp_server.project_state import Project, ProjectStore


def test_project_store_persists_text_clip_without_asset_id(tmp_path) -> None:
    now = int(time.time() * 1000)
    store = ProjectStore(tmp_path / "mcp_projects")

    project_payload = {
        "id": "project-text-clip",
        "name": "Text Clip Project",
        "createdAt": now,
        "updatedAt": now,
        "assets": [],
        "timelines": [
            {
                "id": "timeline-1",
                "name": "Timeline 1",
                "createdAt": now,
                "tracks": [],
                "clips": [
                    {
                        "id": "clip-text-1",
                        "assetId": None,
                        "type": "text",
                        "startTime": 0,
                        "duration": 5,
                        "trimStart": 0,
                        "trimEnd": 0,
                        "speed": 1,
                        "reversed": False,
                        "muted": True,
                        "volume": 1,
                        "trackIndex": 0,
                        "asset": None,
                        "flipH": False,
                        "flipV": False,
                        "transitionIn": {"type": "none", "duration": 0},
                        "transitionOut": {"type": "none", "duration": 0},
                        "colorCorrection": {
                            "brightness": 0,
                            "contrast": 0,
                            "saturation": 0,
                            "temperature": 0,
                            "tint": 0,
                            "exposure": 0,
                            "highlights": 0,
                            "shadows": 0,
                        },
                        "opacity": 100,
                        "textStyle": {"text": "Hello"},
                    }
                ],
                "subtitles": [],
            }
        ],
        "activeTimelineId": "timeline-1",
    }

    project = Project.model_validate(project_payload)
    saved = store.upsert_project(project)

    assert saved.timelines[0].clips[0].assetId is None
    reopened = store.open_project("project-text-clip")
    assert reopened.timelines[0].clips[0].assetId is None


def test_project_store_uses_atomic_replacement(tmp_path) -> None:
    store = ProjectStore(tmp_path / "mcp_projects")
    project = store.create_project("Atomic Save")

    project.name = "Updated"
    saved = store.upsert_project(project)

    raw = json.loads((tmp_path / "mcp_projects" / f"{project.id}.json").read_text(encoding="utf-8"))
    assert raw["id"] == saved.id
    assert raw["name"] == "Updated"
    assert not list((tmp_path / "mcp_projects").glob("*.tmp"))
