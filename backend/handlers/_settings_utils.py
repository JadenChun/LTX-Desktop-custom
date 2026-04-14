"""Utilities for settings patch/load workflows."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TypeAlias, TypeGuard, cast

from services.services_utils import JSONValue

JSONObject: TypeAlias = dict[str, JSONValue]


def _is_json_value(value: object) -> TypeGuard[JSONValue]:
    if value is None or isinstance(value, (str, int, float, bool)):
        return True
    if isinstance(value, list):
        typed_items = cast(list[object], value)
        return all(_is_json_value(item) for item in typed_items)
    if isinstance(value, dict):
        typed_mapping = cast(dict[object, object], value)
        return all(isinstance(key, str) and _is_json_value(item) for key, item in typed_mapping.items())
    return False


def _is_json_object(value: object) -> TypeGuard[JSONObject]:
    if not isinstance(value, dict):
        return False
    typed_mapping = cast(dict[object, object], value)
    return all(isinstance(key, str) and _is_json_value(item) for key, item in typed_mapping.items())


def ensure_json_object(payload: object) -> JSONObject:
    if not _is_json_object(payload):
        raise ValueError("Settings payload must be a JSON object")
    return payload


def deep_merge_dicts(base: Mapping[str, JSONValue], patch: Mapping[str, JSONValue]) -> JSONObject:
    merged: JSONObject = dict(base)
    for key, value in patch.items():
        base_value = merged.get(key)
        if _is_json_object(value) and _is_json_object(base_value):
            merged[key] = deep_merge_dicts(base_value, value)
        else:
            merged[key] = value
    return merged


def strip_none_values(payload: Mapping[str, JSONValue]) -> JSONObject:
    cleaned: JSONObject = {}
    for key, value in payload.items():
        if value is None:
            continue
        if _is_json_object(value):
            cleaned[key] = strip_none_values(value)
        else:
            cleaned[key] = value
    return cleaned


def collect_changed_paths(before: JSONValue, after: JSONValue, prefix: str = "") -> set[str]:
    if _is_json_object(before) and _is_json_object(after):
        paths: set[str] = set()
        for key in set(before.keys()) | set(after.keys()):
            next_prefix = f"{prefix}.{key}" if prefix else key
            if key not in before or key not in after:
                paths.add(next_prefix)
                continue
            paths |= collect_changed_paths(before[key], after[key], next_prefix)
        return paths

    if before != after and prefix:
        return {prefix}
    return set()


def migrate_legacy_settings(raw: Mapping[str, JSONValue]) -> JSONObject:
    migrated: JSONObject = dict(raw)
    if (
        "prompt_enhancer_enabled" in migrated
        and "prompt_enhancer_enabled_t2v" not in migrated
    ):
        legacy_value = bool(migrated["prompt_enhancer_enabled"])
        migrated.setdefault("prompt_enhancer_enabled_t2v", legacy_value)
        migrated.setdefault("prompt_enhancer_enabled_i2v", legacy_value)

    migrated.pop("prompt_enhancer_enabled", None)

    legacy_module_key = "mcp_ai_generation_tools_enabled"
    legacy_tool_keys = {
        "mcp_ai_generate_video_enabled": "generate_video",
        "mcp_ai_retake_clip_enabled": "ai_retake_clip",
        "mcp_ai_fill_gap_enabled": "fill_gap",
        "mcp_ai_get_generation_status_enabled": "get_generation_status",
        "mcp_ai_cancel_generation_enabled": "cancel_generation",
    }

    has_legacy_mcp_settings = legacy_module_key in migrated or any(
        key in migrated for key in legacy_tool_keys
    )

    if has_legacy_mcp_settings:
        raw_modules = migrated.get("mcp_modules")
        mcp_modules = dict(raw_modules) if _is_json_object(raw_modules) else {}
        if legacy_module_key in migrated:
            mcp_modules.setdefault("ai_generation", bool(migrated[legacy_module_key]))
        if mcp_modules:
            migrated["mcp_modules"] = mcp_modules

        raw_tools = migrated.get("mcp_tools")
        mcp_tools = dict(raw_tools) if _is_json_object(raw_tools) else {}
        raw_ai_tools = mcp_tools.get("ai_generation")
        ai_tools = dict(raw_ai_tools) if _is_json_object(raw_ai_tools) else {}

        for legacy_key, tool_name in legacy_tool_keys.items():
            if legacy_key in migrated:
                ai_tools.setdefault(tool_name, bool(migrated[legacy_key]))

        if ai_tools:
            mcp_tools["ai_generation"] = ai_tools
            migrated["mcp_tools"] = mcp_tools

    migrated.pop(legacy_module_key, None)
    for legacy_key in legacy_tool_keys:
        migrated.pop(legacy_key, None)
    return migrated
