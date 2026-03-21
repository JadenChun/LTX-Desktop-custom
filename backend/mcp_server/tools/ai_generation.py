# pyright: reportUnusedFunction=false

"""MCP tools for AI video generation."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, Literal

from mcp.server.fastmcp import FastMCP

if TYPE_CHECKING:
    from app_handler import AppHandler


def register_ai_generation_tools(mcp: FastMCP, handler: "AppHandler") -> None:
    """Register AI generation tools on the MCP server."""

    @mcp.tool()
    async def generate_video(
        prompt: str,
        resolution: str = "720p",
        model: str = "fast",
        camera_motion: Literal[
            "none", "dolly_in", "dolly_out", "dolly_left", "dolly_right",
            "jib_up", "jib_down", "static", "focus_shift"
        ] = "none",
        negative_prompt: str = "",
        duration: str = "6",
        fps: str = "24",
        aspect_ratio: Literal["16:9", "9:16"] = "16:9",
        image_path: str | None = None,
        audio_path: str | None = None,
    ) -> dict[str, Any]:
        """Generate a video using LTX AI.

        This is a blocking call — it runs the full generation pipeline and returns
        only when the video is ready (or has failed). For long generations, consider
        polling get_generation_status() in parallel.

        Args:
            prompt:          Text description of the video to generate.
            resolution:      Output resolution. Options: "480p", "720p", "1080p".
            model:           Model variant: "fast" (default) or "quality".
            camera_motion:   Camera movement: none (default), dolly_in, dolly_out,
                             dolly_left, dolly_right, jib_up, jib_down, static, focus_shift.
            negative_prompt: What to avoid in the generation.
            duration:        Video length in seconds as a string e.g. "6", "8", "10".
            fps:             Frames per second as a string e.g. "24", "30".
            aspect_ratio:    "16:9" (landscape, default) or "9:16" (portrait).
            image_path:      Optional absolute path to an image for image-to-video.
            audio_path:      Optional absolute path to an audio file to include.

        Returns:
            {"status": "success"|"error", "video_path": "/abs/path/to/video.mp4"}
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

    @mcp.tool()
    async def retake_clip(
        video_path: str,
        start_time: float,
        duration: float,
        prompt: str = "",
        mode: str = "replace_audio_and_video",
    ) -> dict[str, Any]:
        """Re-generate a section of an existing video clip.

        Useful for fixing a specific segment without regenerating the whole video.

        Args:
            video_path:  Absolute path to the source video file.
            start_time:  Start of the section to replace (seconds).
            duration:    Length of the section to replace (seconds).
            prompt:      Text prompt for the replacement segment.
            mode:        Replacement mode (default "replace_audio_and_video").

        Returns:
            {"status": str, "video_path": str|null, "result": dict|null}
        """
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

    @mcp.tool()
    async def fill_gap(
        gap_duration: float = 5.0,
        before_prompt: str = "",
        after_prompt: str = "",
        mode: str = "t2v",
        before_frame: str | None = None,
        after_frame: str | None = None,
        input_image: str | None = None,
    ) -> dict[str, Any]:
        """Get an AI-suggested prompt to fill a gap between two clips.

        This is a planning/advisory tool — it returns a suggested prompt which you
        can then pass to generate_video() to actually create the filler clip.

        Args:
            gap_duration:  Duration of the gap in seconds.
            before_prompt: Prompt/description of the clip before the gap.
            after_prompt:  Prompt/description of the clip after the gap.
            mode:          Generation mode hint: "t2v" (default) or "i2v".
            before_frame:  Optional path to the last frame of the clip before the gap.
            after_frame:   Optional path to the first frame of the clip after the gap.
            input_image:   Optional path to a reference image.

        Returns:
            {"status": str, "suggested_prompt": str}
        """
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

    @mcp.tool()
    async def get_generation_status() -> dict[str, Any]:
        """Poll the current AI generation progress.

        Returns:
            {"status": str, "phase": str, "progress": int,
             "currentStep": int|null, "totalSteps": int|null}
        """
        return handler.generation.get_generation_progress().model_dump()

    @mcp.tool()
    async def cancel_generation() -> dict[str, Any]:
        """Cancel the currently running AI generation.

        Returns:
            {"status": str, "id": str|null}
        """
        return handler.generation.cancel_generation().model_dump()
