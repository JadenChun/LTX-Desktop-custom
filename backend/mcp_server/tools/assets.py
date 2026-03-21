# pyright: reportUnusedFunction=false

"""MCP tools for asset management."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal, cast

from mcp.server.fastmcp import FastMCP

if TYPE_CHECKING:
    from mcp_server.project_state import ProjectStore


def register_asset_tools(mcp: FastMCP, store: "ProjectStore") -> None:
    """Register asset management tools on the MCP server."""

    @mcp.tool()
    async def import_asset(
        file_path: str,
        prompt: str = "",
        media_type: Literal["video", "image", "audio"] = "video",
    ) -> dict[str, Any]:
        """Import a media file into the active project as an asset.

        Probes video/image metadata (duration, resolution) automatically via imageio.
        The asset is added to the project and can then be placed on the timeline
        using add_clip().

        Args:
            file_path: Absolute path to an existing media file.
            prompt:    Optional text prompt that was used to generate this asset.
            media_type: One of "video", "image", or "audio".

        Returns:
            Asset dict with id, type, path, url, duration, resolution.
        """
        from pathlib import Path

        resolved = Path(file_path).resolve()
        if not resolved.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        duration: float | None = None
        resolution: str = ""

        if media_type in ("video", "image"):
            try:
                import imageio.v3 as iio  # type: ignore[import]

                props: Any = iio.improps(str(resolved))  # pyright: ignore[reportUnknownMemberType]
                shape_any = getattr(props, "shape", None)
                if isinstance(shape_any, tuple):
                    shape = cast(tuple[int, ...], shape_any)
                    if len(shape) >= 2:
                        if len(shape) >= 3:
                            h = shape[1]
                            w = shape[2]
                        else:
                            h = shape[0]
                            w = shape[1]
                        resolution = f"{w}x{h}"

                if media_type == "video":
                    dur_val = getattr(props, "duration", None)
                    if dur_val is not None:
                        duration = float(dur_val)
            except Exception:
                # imageio probe is best-effort; fall back to empty metadata
                pass

        asset = store.add_asset(
            file_path=str(resolved),
            media_type=media_type,
            duration=duration,
            resolution=resolution,
            prompt=prompt,
        )
        return asset.model_dump()

    @mcp.tool()
    async def list_assets() -> list[dict[str, Any]]:
        """List all assets in the active project.

        Returns:
            List of asset dicts (id, type, path, url, duration, resolution, prompt).
        """
        return [a.model_dump() for a in store.get_active().assets]

    @mcp.tool()
    async def get_asset_info(asset_id: str) -> dict[str, Any]:
        """Return full metadata for a single asset.

        Args:
            asset_id: The asset id returned by import_asset (e.g. "asset-...").

        Returns:
            Asset dict.
        """
        return store.get_asset(asset_id).model_dump()
