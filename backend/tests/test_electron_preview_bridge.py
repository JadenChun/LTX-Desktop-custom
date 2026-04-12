from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from mcp_server.electron_preview_bridge import render_preview_clip, render_preview_frame


@dataclass
class _CapturedRequest:
    path: str
    authorization: str
    payload: dict[str, object]


class _BridgeTestHandler(BaseHTTPRequestHandler):
    captured_request: _CapturedRequest | None = None
    response_payload: dict[str, object] = {}

    def do_POST(self) -> None:  # noqa: N802
        content_length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(content_length).decode("utf-8")
        payload = json.loads(body) if body else {}
        type(self).captured_request = _CapturedRequest(
            path=self.path,
            authorization=self.headers.get("Authorization", ""),
            payload=payload,
        )
        response_body = json.dumps(type(self).response_payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response_body)))
        self.end_headers()
        self.wfile.write(response_body)
        self.wfile.flush()
        self.close_connection = True

    def log_message(self, _format: str, *args: object) -> None:  # noqa: A003
        return


@pytest.fixture
def preview_bridge_server():
    _BridgeTestHandler.captured_request = None
    server = ThreadingHTTPServer(("127.0.0.1", 0), _BridgeTestHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join(timeout=5)
        server.server_close()


def test_render_preview_frame_posts_expected_payload(monkeypatch: pytest.MonkeyPatch, preview_bridge_server: str) -> None:
    _BridgeTestHandler.response_payload = {
        "imagePath": "/tmp/frame.png",
        "time": 1.25,
        "width": 640,
        "height": 360,
    }
    monkeypatch.setenv("LTX_ELECTRON_BRIDGE_URL", preview_bridge_server)
    monkeypatch.setenv("LTX_ELECTRON_BRIDGE_TOKEN", "bridge-secret")

    result = render_preview_frame(
        project_payload={"id": "project-1", "timelines": []},
        time=1.25,
        width=640,
        height=360,
    )

    assert result["imagePath"] == "/tmp/frame.png"
    assert _BridgeTestHandler.captured_request is not None
    assert _BridgeTestHandler.captured_request.path == "/preview/frame"
    assert _BridgeTestHandler.captured_request.authorization == "Bearer bridge-secret"
    assert _BridgeTestHandler.captured_request.payload == {
        "project": {"id": "project-1", "timelines": []},
        "time": 1.25,
        "width": 640,
        "height": 360,
    }


def test_render_preview_clip_posts_expected_payload(monkeypatch: pytest.MonkeyPatch, preview_bridge_server: str) -> None:
    _BridgeTestHandler.response_payload = {
        "videoPath": "/tmp/clip.mp4",
        "startTime": 2.0,
        "duration": 1.5,
        "fps": 8,
        "frameCount": 12,
        "width": 640,
        "height": 360,
    }
    monkeypatch.setenv("LTX_ELECTRON_BRIDGE_URL", preview_bridge_server)
    monkeypatch.setenv("LTX_ELECTRON_BRIDGE_TOKEN", "bridge-secret")

    result = render_preview_clip(
        project_payload={"id": "project-2", "timelines": []},
        start_time=2.0,
        duration=1.5,
        width=640,
        height=360,
        fps=8,
    )

    assert result["videoPath"] == "/tmp/clip.mp4"
    assert _BridgeTestHandler.captured_request is not None
    assert _BridgeTestHandler.captured_request.path == "/preview/clip"
    assert _BridgeTestHandler.captured_request.authorization == "Bearer bridge-secret"
    assert _BridgeTestHandler.captured_request.payload == {
        "project": {"id": "project-2", "timelines": []},
        "startTime": 2.0,
        "duration": 1.5,
        "width": 640,
        "height": 360,
        "fps": 8,
    }


def test_render_preview_frame_requires_bridge_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LTX_ELECTRON_BRIDGE_URL", raising=False)
    monkeypatch.delenv("LTX_ELECTRON_BRIDGE_TOKEN", raising=False)

    with pytest.raises(RuntimeError, match="Electron preview bridge is not configured"):
        render_preview_frame(
            project_payload={"id": "project-3"},
            time=0.0,
            width=640,
            height=360,
        )
