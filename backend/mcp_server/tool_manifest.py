"""Canonical MCP module and tool manifest for LTX Desktop."""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy

MCP_MODULE_TOOL_NAMES: dict[str, tuple[str, ...]] = {
    "project": (
        "create_project",
        "open_project",
        "save_project",
        "get_project_state",
        "list_projects",
    ),
    "assets": (
        "import_asset",
        "list_assets",
        "get_asset_info",
    ),
    "timeline": (
        "add_clip",
        "remove_clip",
        "move_clip",
        "trim_clip",
        "split_clip",
        "get_timeline_state",
        "inspect_timeline",
        "preview_frame",
        "preview_clip",
        "set_clip_speed",
        "set_clip_volume",
        "set_clip_muted",
        "reverse_clip",
        "set_clip_opacity",
        "flip_clip",
        "set_clip_motion",
        "set_clip_color_correction",
        "set_clip_transition",
        "add_clip_effect",
        "remove_clip_effect",
        "update_clip_effect",
        "update_clip",
        "retake_clip",
    ),
    "tracks": (
        "add_track",
        "remove_track",
        "reorder_track",
        "set_track_properties",
    ),
    "subtitle": (
        "add_subtitle",
        "update_subtitle",
        "remove_subtitle",
        "set_subtitle_style",
        "set_subtitle_track_style",
        "list_subtitles",
    ),
    "text_overlay": (
        "add_text_clip",
        "update_text_clip_style",
    ),
    "export": (
        "export_timeline",
        "get_export_status",
    ),
    "ai_generation": (
        "generate_video",
        "ai_retake_clip",
        "fill_gap",
        "get_generation_status",
        "cancel_generation",
    ),
}

MCP_MODULE_DEFAULTS: dict[str, bool] = {
    "project": True,
    "assets": True,
    "timeline": True,
    "tracks": True,
    "subtitle": True,
    "text_overlay": True,
    "export": True,
    "ai_generation": False,
}

MCP_TOOL_DEFAULTS: dict[str, dict[str, bool]] = {
    module_id: {tool_name: True for tool_name in tool_names}
    for module_id, tool_names in MCP_MODULE_TOOL_NAMES.items()
}


def default_mcp_modules_enabled() -> dict[str, bool]:
    """Return a fresh copy of the default MCP module flags."""
    return dict(MCP_MODULE_DEFAULTS)


def default_mcp_tools_enabled() -> dict[str, dict[str, bool]]:
    """Return a fresh copy of the default MCP per-tool flags."""
    return deepcopy(MCP_TOOL_DEFAULTS)


def resolve_mcp_module_flags(
    module_flags: Mapping[str, bool] | None,
) -> dict[str, bool]:
    """Merge stored module flags with known defaults."""
    resolved = default_mcp_modules_enabled()
    if module_flags is None:
        return resolved

    for module_id in resolved:
        if module_id in module_flags:
            resolved[module_id] = bool(module_flags[module_id])
    return resolved


def resolve_mcp_tool_flags(
    module_flags: Mapping[str, bool] | None,
    tool_flags: Mapping[str, Mapping[str, bool]] | None,
) -> dict[str, dict[str, bool]]:
    """Return effective tool flags after applying module-level enablement."""
    resolved_modules = resolve_mcp_module_flags(module_flags)
    resolved_tools = default_mcp_tools_enabled()

    if tool_flags is not None:
        for module_id, module_tools in resolved_tools.items():
            raw_module_tools = tool_flags.get(module_id)
            if raw_module_tools is None:
                continue
            for tool_name in module_tools:
                if tool_name in raw_module_tools:
                    module_tools[tool_name] = bool(raw_module_tools[tool_name])

    return {
        module_id: {
            tool_name: resolved_modules[module_id] and enabled
            for tool_name, enabled in module_tools.items()
        }
        for module_id, module_tools in resolved_tools.items()
    }
