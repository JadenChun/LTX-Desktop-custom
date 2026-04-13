"""Shared MCP tool annotations for LTX Desktop."""

from __future__ import annotations

from mcp.types import ToolAnnotations

_READ_ONLY_PREFIXES = (
    "get_",
    "list_",
    "inspect_",
    "preview_",
    "read_",
    "search_",
    "find_",
    "fetch_",
    "status_",
)

_DESTRUCTIVE_PREFIXES = (
    "remove_",
    "delete_",
    "trim_",
    "split_",
    "move_",
    "set_",
    "update_",
    "reorder_",
    "retake_",
    "cancel_",
)

_OPEN_WORLD_PREFIXES = (
    "generate_",
    "retake_",
    "fill_",
    "import_",
    "export_",
)


def build_tool_annotations(tool_name: str) -> ToolAnnotations:
    """Return default annotations for a named LTX MCP tool."""
    lowered = tool_name.lower()
    read_only = lowered.startswith(_READ_ONLY_PREFIXES)

    if read_only:
        return ToolAnnotations(
            readOnlyHint=True,
            destructiveHint=False,
            idempotentHint=True,
            openWorldHint=False,
        )

    return ToolAnnotations(
        readOnlyHint=False,
        destructiveHint=lowered.startswith(_DESTRUCTIVE_PREFIXES),
        idempotentHint=lowered.startswith(("open_", "save_")),
        openWorldHint=lowered.startswith(_OPEN_WORLD_PREFIXES),
    )
