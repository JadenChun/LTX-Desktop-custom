
import pytest
import time
import json
from mcp_server.project_state import Project, Asset, Timeline

def test_large_project_sync_limit_check(client):
    # 1. Create a project with a very large "thumbnail" (data URL)
    # 5MB of random data to simulate many large thumbnails or one massive one
    large_data = "a" * (5 * 1024 * 1024) 
    now = int(time.time() * 1000)
    
    asset = {
        "id": "asset-large",
        "type": "image",
        "path": "C:\\fake\\path.png",
        "url": "file:///C:/fake/path.png",
        "thumbnail": f"data:image/png;base64,{large_data}",
        "createdAt": now,
        "prompt": "",
        "resolution": "1024x1024"
    }
    
    project_payload = {
        "id": "project-large",
        "name": "Large Project",
        "createdAt": now,
        "updatedAt": now,
        "assets": [asset],
        "timelines": [
            {
                "id": "timeline-1",
                "name": "Timeline 1",
                "createdAt": now,
                "tracks": [],
                "clips": []
            }
        ],
        "activeTimelineId": "timeline-1"
    }
    
    # 2. Try the PUT request. This might trigger 10054 or a timeout
    # though TestClient might handle it (since it's in-process)
    # But it will show us if Pydantic or the backend logging stalls.
    
    try:
        response = client.put("/api/mcp/projects/project-large", json=project_payload)
        assert response.status_code == 200
    except Exception as e:
        # If it Crashes, we catch it here (or rather pytest/TestClient will throw)
        print(f"Caught exception during large sync: {e}")
        raise
