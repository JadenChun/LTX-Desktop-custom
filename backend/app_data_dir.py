"""Shared app-data path resolution for backend entrypoints."""

from __future__ import annotations

import os
import platform
from pathlib import Path

APP_FOLDER_NAME = "LTXDesktop"


def default_app_data_dir() -> Path:
    system = platform.system()
    home = Path.home()

    if system == "Windows":
        local_app_data = os.environ.get("LOCALAPPDATA")
        base = Path(local_app_data) if local_app_data else home / "AppData" / "Local"
        return base / APP_FOLDER_NAME

    if system == "Darwin":
        return home / "Library" / "Application Support" / APP_FOLDER_NAME

    xdg_data = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg_data) if xdg_data else home / ".local" / "share"
    return base / APP_FOLDER_NAME


def resolve_app_data_dir() -> Path:
    env_path = os.environ.get("LTX_APP_DATA_DIR")
    candidate = Path(env_path) if env_path else default_app_data_dir()
    candidate.mkdir(parents=True, exist_ok=True)
    return candidate
