
import pytest
from fastapi.testclient import TestClient
from app_factory import create_app
from mcp_server.project_state import Project, Asset, Timeline, Track, TimelineClip
import time

def test_reproduce_bgm_sync_issue(client):
    # 1. Create a project state similar to what the frontend sends
    now = int(time.time() * 1000)
    
    asset = {
        "id": "asset-123",
        "type": "audio",
        "path": "C:\\Users\\chang\\Downloads\\music.mp3",
        "url": "file:///C:/Users/chang/Downloads/music.mp3",
        "duration": 180.5,
        "createdAt": now,
        "prompt": "",
        "resolution": ""
    }
    
    clip = {
        "id": "clip-456",
        "assetId": "asset-123",
        "type": "audio",
        "startTime": 0,
        "duration": 10.0,
        "trimStart": 0,
        "trimEnd": 170.5,
        "speed": 1.0,
        "reversed": False,
        "muted": False,
        "volume": 1.0,
        "trackIndex": 3, # A1
        "asset": asset,
        "transitionIn": {"type": "none", "duration": 0},
        "transitionOut": {"type": "none", "duration": 0},
        "colorCorrection": {
            "brightness": 0, "contrast": 0, "saturation": 0, "temperature": 0,
            "tint": 0, "exposure": 0, "highlights": 0, "shadows": 0
        },
        "effects": []
    }
    
    project_payload = {
        "id": "project-789",
        "name": "Test Project",
        "createdAt": now,
        "updatedAt": now,
        "assets": [asset],
        "timelines": [
            {
                "id": "timeline-1",
                "name": "Timeline 1",
                "createdAt": now,
                "tracks": [
                    {"id": "track-v1", "name": "V1", "kind": "video", "muted": False, "locked": False},
                    {"id": "track-a1", "name": "A1", "kind": "audio", "muted": False, "locked": False}
                ],
                "clips": [clip]
            }
        ],
        "activeTimelineId": "timeline-1"
    }
    
    # 2. Add an existing project to the store first so PUT works
    # (In reality the frontend might have created it earlier)
    # But PUT route in mcp_projects.py actually uses Body(...) and then validates.
    
    response = client.put("/api/mcp/projects/project-789", json=project_payload)
    
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "project-789"
    assert len(data["assets"]) == 1
    assert data["assets"][0]["type"] == "audio"
