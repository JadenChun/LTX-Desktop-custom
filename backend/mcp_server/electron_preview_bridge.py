"""Helpers for calling the local Electron preview bridge from the backend."""

from __future__ import annotations

import json
import os
from typing import Any, cast
from urllib import error, request

_BRIDGE_URL_ENV = "LTX_ELECTRON_BRIDGE_URL"
_BRIDGE_TOKEN_ENV = "LTX_ELECTRON_BRIDGE_TOKEN"
_DEFAULT_TIMEOUT_SECONDS = 120.0


def _bridge_config() -> tuple[str, str]:
    bridge_url = os.environ.get(_BRIDGE_URL_ENV, "").strip()
    bridge_token = os.environ.get(_BRIDGE_TOKEN_ENV, "").strip()
    if not bridge_url or not bridge_token:
        raise RuntimeError(
            "Electron preview bridge is not configured. Start the backend from the LTX Desktop app "
            "so preview_frame and preview_clip can reach the hidden renderer."
        )
    return bridge_url.rstrip("/"), bridge_token


def _bridge_post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    base_url, bridge_token = _bridge_config()
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(
        f"{base_url}{path}",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {bridge_token}",
        },
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=_DEFAULT_TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8")
    except error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Electron preview bridge request failed with HTTP {exc.code}: {detail or exc.reason}"
        ) from exc
    except error.URLError as exc:
        raise RuntimeError(f"Electron preview bridge is unreachable: {exc.reason}") from exc

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Electron preview bridge returned invalid JSON.") from exc

    if not isinstance(parsed, dict):
        raise RuntimeError("Electron preview bridge returned an unexpected response payload.")

    return cast(dict[str, Any], parsed)


def render_preview_frame(
    *,
    project_payload: dict[str, Any],
    time: float,
    width: int,
    height: int,
    output_path: str | None = None,
) -> dict[str, Any]:
    payload = {
        "project": project_payload,
        "time": time,
        "width": width,
        "height": height,
    }
    if output_path:
        payload["outputPath"] = output_path
    return _bridge_post(
        "/preview/frame",
        payload,
    )


def render_preview_clip(
    *,
    project_payload: dict[str, Any],
    start_time: float,
    duration: float,
    width: int,
    height: int,
    fps: int,
    output_path: str | None = None,
) -> dict[str, Any]:
    payload = {
        "project": project_payload,
        "startTime": start_time,
        "duration": duration,
        "width": width,
        "height": height,
        "fps": fps,
    }
    if output_path:
        payload["outputPath"] = output_path
    return _bridge_post(
        "/preview/clip",
        payload,
    )
