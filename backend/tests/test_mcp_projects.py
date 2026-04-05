from __future__ import annotations

import time


def test_get_mcp_project_reopens_text_clip_without_asset_id(client):
    now = int(time.time() * 1000)

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

    put_response = client.put("/api/mcp/projects/project-text-clip", json=project_payload)
    assert put_response.status_code == 200

    get_response = client.get("/api/mcp/projects/project-text-clip")
    assert get_response.status_code == 200
    payload = get_response.json()
    assert payload["timelines"][0]["clips"][0]["assetId"] is None


def test_put_mcp_project_derives_missing_asset_urls_from_paths(client):
    now = int(time.time() * 1000)
    asset = {
        "id": "asset-photo-scan-1",
        "type": "image",
        "path": r"C:\fake\photo_scan\frame-001.png",
        "prompt": "",
        "resolution": "1920x1080",
        "createdAt": now,
    }

    project_payload = {
        "id": "project-photo-scan-sync",
        "name": "Photo Scan Sync",
        "createdAt": now,
        "updatedAt": now,
        "assets": [asset],
        "timelines": [
            {
                "id": "timeline-1",
                "name": "Timeline 1",
                "createdAt": now,
                "tracks": [],
                "clips": [
                    {
                        "id": "clip-image-1",
                        "assetId": asset["id"],
                        "type": "image",
                        "startTime": 0,
                        "duration": 5,
                        "trimStart": 0,
                        "trimEnd": 0,
                        "speed": 1,
                        "reversed": False,
                        "muted": True,
                        "volume": 1,
                        "trackIndex": 0,
                        "asset": asset,
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
                    }
                ],
                "subtitles": [],
            }
        ],
        "activeTimelineId": "timeline-1",
    }

    put_response = client.put("/api/mcp/projects/project-photo-scan-sync", json=project_payload)
    assert put_response.status_code == 200

    payload = put_response.json()
    assert payload["assets"][0]["url"].startswith("file:///")
    assert payload["timelines"][0]["clips"][0]["asset"]["url"].startswith("file:///")
