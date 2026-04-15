# pyright: reportUnusedFunction=false

"""MCP tools for AI video generation."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Literal

from mcp.server.fastmcp import FastMCP

if TYPE_CHECKING:
    from app_handler import AppHandler


def register_ai_generation_tools(
    mcp: FastMCP,
    handler: "AppHandler",
    *,
    enabled_tools: Mapping[str, bool] | None = None,
) -> None:
    """Register AI generation tools on the MCP server."""

    def tool_enabled(name: str) -> bool:
        if enabled_tools is None:
            return True
        return enabled_tools.get(name, True)

    if tool_enabled("generate_video"):
        @mcp.tool()
        async def generate_video(
            prompt: str,
            resolution: Literal["540p", "720p", "1080p", "1440p", "2160p"] = "720p",
            model: Literal["fast", "pro"] = "fast",
            camera_motion: Literal[
                "none", "dolly_in", "dolly_out", "dolly_left", "dolly_right",
                "jib_up", "jib_down", "static", "focus_shift"
            ] = "none",
            negative_prompt: str = "",
            duration: int = 6,
            fps: int = 24,
            aspect_ratio: Literal["16:9", "9:16"] = "16:9",
            image_path: str | None = None,
            audio_path: str | None = None,
        ) -> dict[str, Any]:
            """Generate a video using LTX AI.

            This is a blocking call — it runs the full generation pipeline and returns
            only when the video is ready (or has failed). For long generations, consider
            polling get_generation_status() in parallel.
            """
            from api_types import GenerateVideoRequest

            req = GenerateVideoRequest(
                prompt=prompt,
                resolution=resolution,
                model=model,
                cameraMotion=camera_motion,
                negativePrompt=negative_prompt,
                duration=duration,
                fps=fps,
                aspectRatio=aspect_ratio,
                imagePath=image_path,
                audioPath=audio_path,
            )
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None, handler.video_generation.generate, req
            )
            return result.model_dump()

    if tool_enabled("ai_retake_clip"):
        @mcp.tool()
        async def ai_retake_clip(
            video_path: str,
            start_time: float,
            duration: float,
            prompt: str = "",
            mode: Literal["replace_audio_and_video", "replace_video", "replace_audio"] = "replace_audio_and_video",
        ) -> dict[str, Any]:
            """Re-generate a section of an existing video clip."""
            from api_types import RetakeRequest

            req = RetakeRequest(
                video_path=video_path,
                start_time=start_time,
                duration=duration,
                prompt=prompt,
                mode=mode,
            )
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(None, handler.retake.run, req)
            return result.model_dump()

    if tool_enabled("fill_gap"):
        @mcp.tool()
        async def fill_gap(
            gap_duration: float = 5.0,
            before_prompt: str = "",
            after_prompt: str = "",
            mode: Literal["text-to-video", "image-to-video", "text-to-image"] = "text-to-video",
            before_frame: str | None = None,
            after_frame: str | None = None,
            input_image: str | None = None,
        ) -> dict[str, Any]:
            """Get an AI-suggested prompt to fill a gap between two clips."""
            from api_types import SuggestGapPromptRequest

            req = SuggestGapPromptRequest(
                beforePrompt=before_prompt,
                afterPrompt=after_prompt,
                beforeFrame=before_frame,
                afterFrame=after_frame,
                gapDuration=gap_duration,
                mode=mode,
                inputImage=input_image,
            )
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                None, handler.suggest_gap_prompt.suggest_gap, req
            )
            return result.model_dump()

    if tool_enabled("get_generation_status"):
        @mcp.tool()
        async def get_generation_status() -> dict[str, Any]:
            """Poll the current AI generation progress."""
            return handler.generation.get_generation_progress().model_dump()

    if tool_enabled("cancel_generation"):
        @mcp.tool()
        async def cancel_generation() -> dict[str, Any]:
            """Cancel the currently running AI generation."""
            return handler.generation.cancel_generation().model_dump()
