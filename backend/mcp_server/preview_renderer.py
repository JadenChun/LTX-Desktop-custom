from __future__ import annotations

import io
import math
import os
import re
import subprocess
import tempfile
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from PIL import Image, ImageColor, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

from mcp_server.preview_state import clip_visual_opacity, derive_render_state, resolve_active_timeline

if TYPE_CHECKING:
    from mcp_server.project_state import (
        Asset,
        Project,
        SubtitleClip,
        SubtitleStyle,
        TextOverlayStyle,
        Timeline,
        TimelineClip,
    )


_DEFAULT_TIMEOUT_SECONDS = 120.0
_RENDER_LOCK = threading.Lock()
_ffmpeg_path_cache: str | None = None
_RGBA_PATTERN = re.compile(
    r"rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9.]+))?\s*\)"
)


def _new_asset_cache() -> dict[str, "Asset"]:
    return {}


def _new_image_cache() -> dict[str, Image.Image]:
    return {}


def _new_font_cache() -> dict[tuple[str, int], ImageFont.FreeTypeFont | ImageFont.ImageFont]:
    return {}


@dataclass
class PreviewRenderSession:
    project: "Project"
    timeline: "Timeline"
    width: int
    height: int
    asset_map: dict[str, "Asset"] = field(default_factory=_new_asset_cache)
    image_cache: dict[str, Image.Image] = field(default_factory=_new_image_cache)
    font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont | ImageFont.ImageFont] = field(default_factory=_new_font_cache)
    measure_image: Image.Image = field(default_factory=lambda: Image.new("RGBA", (1, 1), (0, 0, 0, 0)))


def _get_ffmpeg_path() -> str:
    global _ffmpeg_path_cache  # noqa: PLW0603
    if _ffmpeg_path_cache is None:
        import imageio_ffmpeg  # type: ignore[import]

        _ffmpeg_path_cache = imageio_ffmpeg.get_ffmpeg_exe()
    return _ffmpeg_path_cache


def _ensure_output_path(file_extension: str, explicit_path: str | None = None) -> str:
    if explicit_path:
        Path(explicit_path).parent.mkdir(parents=True, exist_ok=True)
        return explicit_path

    output_dir = Path(tempfile.gettempdir()) / "ltx-agent-previews"
    output_dir.mkdir(parents=True, exist_ok=True)
    return str(output_dir / f"preview_{uuid.uuid4().hex[:12]}.{file_extension}")


def _normalize_frame_size(width: int, height: int) -> tuple[int, int]:
    return (max(64, round(width)), max(64, round(height)))


def _project_from_payload(project_payload: dict[str, Any]) -> "Project":
    from mcp_server.project_state import Project

    return Project.model_validate(project_payload)


def _build_session(project_payload: dict[str, Any], width: int, height: int) -> PreviewRenderSession:
    project = _project_from_payload(project_payload)
    timeline = resolve_active_timeline(project)
    asset_map = {asset.id: asset for asset in project.assets}
    for clip in timeline.clips:
        if clip.asset is None and clip.assetId is not None:
            clip.asset = asset_map.get(clip.assetId)
    return PreviewRenderSession(
        project=project,
        timeline=timeline,
        width=width,
        height=height,
        asset_map=asset_map,
    )


def _parse_color(color: str, opacity_multiplier: float = 1.0) -> tuple[int, int, int, int]:
    if not color or color == "transparent":
        return (0, 0, 0, 0)

    match = _RGBA_PATTERN.fullmatch(color.strip())
    if match:
        red = max(0, min(255, int(match.group(1))))
        green = max(0, min(255, int(match.group(2))))
        blue = max(0, min(255, int(match.group(3))))
        alpha_raw = match.group(4)
        alpha = 1.0 if alpha_raw is None else float(alpha_raw)
        alpha = max(0.0, min(1.0, alpha)) * max(0.0, min(1.0, opacity_multiplier))
        return (red, green, blue, round(alpha * 255))

    if color.startswith("#"):
        if len(color) == 9:
            red = int(color[1:3], 16)
            green = int(color[3:5], 16)
            blue = int(color[5:7], 16)
            alpha = int(color[7:9], 16)
            scaled_alpha = round(alpha * max(0.0, min(1.0, opacity_multiplier)))
            return (red, green, blue, scaled_alpha)
        rgb = ImageColor.getrgb(color)
        return (rgb[0], rgb[1], rgb[2], round(255 * max(0.0, min(1.0, opacity_multiplier))))

    rgb = ImageColor.getrgb(color)
    return (rgb[0], rgb[1], rgb[2], round(255 * max(0.0, min(1.0, opacity_multiplier))))


def _pick_font_file(primary_font_family: str, font_weight: str, font_style: str) -> str:
    bold = font_weight in {"bold", "600", "700", "800", "900"}
    italic = font_style == "italic"

    primary = primary_font_family.split(",")[0].strip().strip("'\"")
    candidates = [
        f"{primary}.ttf",
        f"{primary}.otf",
        f"{primary}.ttc",
    ]
    if bold and italic:
        candidates.extend(["DejaVuSans-BoldOblique.ttf", "Arial Bold Italic.ttf"])
    elif bold:
        candidates.extend(["DejaVuSans-Bold.ttf", "Arial Bold.ttf"])
    elif italic:
        candidates.extend(["DejaVuSans-Oblique.ttf", "Arial Italic.ttf"])
    else:
        candidates.extend(["DejaVuSans.ttf", "Arial.ttf"])

    for candidate in candidates:
        try:
            ImageFont.truetype(candidate, 24)
            return candidate
        except OSError:
            continue
    return "DejaVuSans.ttf"


def _load_font(
    session: PreviewRenderSession,
    font_family: str,
    font_size: int,
    font_weight: str,
    font_style: str,
) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    font_file = _pick_font_file(font_family, font_weight, font_style)
    cache_key = (font_file, font_size)
    cached = session.font_cache.get(cache_key)
    if cached is not None:
        return cached
    try:
        font = ImageFont.truetype(font_file, font_size)
    except OSError:
        font = ImageFont.load_default()
    session.font_cache[cache_key] = font
    return font


def _measure_text(
    session: PreviewRenderSession,
    text: str,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
) -> float:
    draw = ImageDraw.Draw(session.measure_image)
    return float(draw.textlength(text, font=font))


def _wrap_word_to_width(
    session: PreviewRenderSession,
    word: str,
    max_width_px: float,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
) -> list[str]:
    chunks: list[str] = []
    current = ""
    for char in word:
        candidate = current + char
        if current and _measure_text(session, candidate, font) > max_width_px:
            chunks.append(current)
            current = char
        else:
            current = candidate
    if current:
        chunks.append(current)
    return chunks


def _wrap_text_to_width(
    session: PreviewRenderSession,
    text: str,
    max_width_px: float,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
) -> str:
    paragraphs = text.splitlines() or [text]
    wrapped_paragraphs: list[str] = []
    for paragraph in paragraphs:
        words = paragraph.strip().split()
        if not words:
            wrapped_paragraphs.append("")
            continue
        lines: list[str] = []
        line = ""
        for raw_word in words:
            candidate = raw_word if not line else f"{line} {raw_word}"
            if _measure_text(session, candidate, font) <= max_width_px:
                line = candidate
                continue
            if line:
                lines.append(line)
                line = ""
            if _measure_text(session, raw_word, font) <= max_width_px:
                line = raw_word
            else:
                chunks = _wrap_word_to_width(session, raw_word, max_width_px, font)
                lines.extend(chunks[:-1])
                line = chunks[-1] if chunks else ""
        if line:
            lines.append(line)
        wrapped_paragraphs.append("\n".join(lines))
    return "\n".join(wrapped_paragraphs)


def _resolve_clip_asset(session: PreviewRenderSession, clip: "TimelineClip") -> "Asset | None":
    if clip.assetId:
        return session.asset_map.get(clip.assetId) or clip.asset
    return clip.asset


def _resolve_clip_path(session: PreviewRenderSession, clip: "TimelineClip") -> str:
    live_asset = _resolve_clip_asset(session, clip)
    if live_asset is None:
        return ""
    if live_asset.takes and clip.takeIndex is not None and len(live_asset.takes) > 0:
        take_index = max(0, min(clip.takeIndex, len(live_asset.takes) - 1))
        take = live_asset.takes[take_index]
        return str(take.get("path", "") or "")
    return live_asset.path or ""


def _get_clip_target_time(clip: "TimelineClip", media_duration: float, at_time: float) -> float:
    time_in_clip = at_time - clip.startTime
    usable_media_duration = media_duration - clip.trimStart - clip.trimEnd
    if clip.reversed:
        target = clip.trimStart + usable_media_duration - time_in_clip * clip.speed
    else:
        target = clip.trimStart + time_in_clip * clip.speed
    return max(0.0, min(media_duration, target))


def _composite_at(base: Image.Image, overlay: Image.Image, x: int, y: int) -> None:
    left = max(0, x)
    top = max(0, y)
    right = min(base.width, x + overlay.width)
    bottom = min(base.height, y + overlay.height)
    if right <= left or bottom <= top:
        return

    crop = overlay.crop((left - x, top - y, right - x, bottom - y))
    base.alpha_composite(crop, (left, top))


def _fit_media_to_frame(media: Image.Image, width: int, height: int) -> Image.Image:
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    media = media.convert("RGBA")
    scale = min(width / max(1, media.width), height / max(1, media.height))
    fitted_width = max(1, round(media.width * scale))
    fitted_height = max(1, round(media.height * scale))
    resized = media.resize((fitted_width, fitted_height), Image.Resampling.LANCZOS)
    paste_x = (width - fitted_width) // 2
    paste_y = (height - fitted_height) // 2
    layer.alpha_composite(resized, (paste_x, paste_y))
    return layer


def _extract_video_frame(path: str, target_time: float) -> Image.Image:
    ffmpeg = _get_ffmpeg_path()
    cmd = [
        ffmpeg,
        "-y",
        "-v",
        "error",
        "-i",
        path,
        "-ss",
        str(max(0.0, target_time)),
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "pipe:1",
    ]
    result = subprocess.run(
        cmd,
        capture_output=True,
        check=False,
        timeout=_DEFAULT_TIMEOUT_SECONDS,
    )
    if result.returncode != 0 or not result.stdout:
        detail = result.stderr.decode("utf-8", errors="replace")[-500:]
        raise RuntimeError(f"Failed to extract preview frame from video: {detail}")
    return Image.open(io.BytesIO(result.stdout)).convert("RGBA")


def _load_image(session: PreviewRenderSession, path: str) -> Image.Image:
    cached = session.image_cache.get(path)
    if cached is not None:
        return cached.copy()
    image = Image.open(path).convert("RGBA")
    session.image_cache[path] = image.copy()
    return image


def _apply_basic_color_correction(image: Image.Image, clip: "TimelineClip") -> Image.Image:
    corrected = image.convert("RGBA")
    color = clip.colorCorrection

    brightness_factor = 1 + color.brightness / 100 + color.exposure / 200 + color.highlights / 300
    if abs(brightness_factor - 1.0) > 0.001:
        corrected = ImageEnhance.Brightness(corrected).enhance(max(0.0, brightness_factor))

    contrast_factor = 1 + color.contrast / 100 + color.shadows / 300
    if abs(contrast_factor - 1.0) > 0.001:
        corrected = ImageEnhance.Contrast(corrected).enhance(max(0.0, contrast_factor))

    saturation_factor = 1 + color.saturation / 100
    if abs(saturation_factor - 1.0) > 0.001:
        corrected = ImageEnhance.Color(corrected).enhance(max(0.0, saturation_factor))

    if color.temperature != 0 or color.tint != 0:
        red_scale = 1.0 + max(0.0, color.temperature) / 250 + max(0.0, color.tint) / 500
        blue_scale = 1.0 + max(0.0, -color.temperature) / 250 + max(0.0, color.tint) / 700
        green_scale = 1.0 + max(0.0, -color.tint) / 400
        red, green, blue, alpha = corrected.split()
        red = red.point([max(0, min(255, round(value * red_scale))) for value in range(256)])
        green = green.point([max(0, min(255, round(value * green_scale))) for value in range(256)])
        blue = blue.point([max(0, min(255, round(value * blue_scale))) for value in range(256)])
        corrected = Image.merge("RGBA", (red, green, blue, alpha))

    return corrected


def _apply_clip_flips(image: Image.Image, clip: "TimelineClip") -> Image.Image:
    transformed = image
    if clip.flipH:
        transformed = ImageOps.mirror(transformed)
    if clip.flipV:
        transformed = ImageOps.flip(transformed)
    return transformed


def _apply_motion_transform(
    image: Image.Image,
    clip: "TimelineClip",
    time_in_clip: float,
    width: int,
    height: int,
) -> Image.Image:
    motion = clip.motion
    if motion is None or motion.type != "ken_burns" or clip.duration <= 0:
        return image

    t_raw = max(0.0, min(1.0, time_in_clip / clip.duration))
    if motion.easing == "easeInOut":
        t = t_raw * t_raw * (3 - 2 * t_raw)
    else:
        t = t_raw

    scale = max(0.01, motion.start.scale + (motion.end.scale - motion.start.scale) * t)
    focus_x = motion.start.focusX + (motion.end.focusX - motion.start.focusX) * t
    focus_y = motion.start.focusY + (motion.end.focusY - motion.start.focusY) * t

    fx = (focus_x / 100) * width
    fy = (focus_y / 100) * height

    dx = width / 2 - fx * scale
    dy = height / 2 - fy * scale

    if scale >= 1:
        min_dx = width - width * scale
        min_dy = height - height * scale
        dx = max(min_dx, min(0.0, dx))
        dy = max(min_dy, min(0.0, dy))

    scaled_width = max(1, round(width * scale))
    scaled_height = max(1, round(height * scale))
    scaled = image.resize((scaled_width, scaled_height), Image.Resampling.BICUBIC)
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    _composite_at(canvas, scaled, round(dx), round(dy))
    return canvas


def _apply_opacity(image: Image.Image, opacity: float) -> Image.Image:
    opacity = max(0.0, min(1.0, opacity))
    if opacity >= 0.999:
        return image
    layer = image.copy()
    alpha = layer.getchannel("A")
    alpha = alpha.point([max(0, min(255, round(value * opacity))) for value in range(256)])
    layer.putalpha(alpha)
    return layer


def _apply_wipe_mask(
    image: Image.Image,
    clip: "TimelineClip",
    time_in_clip: float,
) -> Image.Image:
    clip_path: tuple[float, float, float, float] | None = None

    transition_in = clip.transitionIn
    transition_out = clip.transitionOut
    if transition_in.type.startswith("wipe-") and transition_in.duration > 0 and time_in_clip < transition_in.duration:
        progress = time_in_clip / transition_in.duration
        clip_path = _wipe_visible_bounds(image.width, image.height, transition_in.type, progress, True)
    if transition_out.type.startswith("wipe-") and transition_out.duration > 0:
        time_from_end = clip.duration - time_in_clip
        if time_from_end < transition_out.duration:
            progress = time_from_end / transition_out.duration
            clip_path = _wipe_visible_bounds(image.width, image.height, transition_out.type, progress, False)

    if clip_path is None:
        return image

    left_pct, top_pct, right_pct, bottom_pct = clip_path
    mask = Image.new("L", image.size, 0)
    draw = ImageDraw.Draw(mask)
    left = round(left_pct * image.width)
    top = round(top_pct * image.height)
    right = round((1.0 - right_pct) * image.width)
    bottom = round((1.0 - bottom_pct) * image.height)
    if right > left and bottom > top:
        draw.rectangle((left, top, right, bottom), fill=255)
    wiped = image.copy()
    alpha = wiped.getchannel("A")
    alpha = Image.composite(alpha, Image.new("L", image.size, 0), mask)
    wiped.putalpha(alpha)
    return wiped


def _wipe_visible_bounds(
    width: int,
    height: int,
    transition_type: str,
    progress: float,
    is_in: bool,
) -> tuple[float, float, float, float]:
    del width, height
    p = max(0.0, min(1.0, progress))
    if transition_type == "wipe-left":
        return (0.0, 0.0, 1.0 - p, 0.0) if is_in else (1.0 - p, 0.0, 0.0, 0.0)
    if transition_type == "wipe-right":
        return (1.0 - p, 0.0, 0.0, 0.0) if is_in else (0.0, 0.0, 1.0 - p, 0.0)
    if transition_type == "wipe-up":
        return (0.0, 0.0, 0.0, 1.0 - p) if is_in else (0.0, 1.0 - p, 0.0, 0.0)
    if transition_type == "wipe-down":
        return (0.0, 1.0 - p, 0.0, 0.0) if is_in else (0.0, 0.0, 0.0, 1.0 - p)
    return (0.0, 0.0, 0.0, 0.0)


def _transition_background_color(clip: "TimelineClip", time: float) -> tuple[int, int, int, int] | None:
    transition_colors = {
        "fade-to-black": "black",
        "fade-to-white": "white",
    }
    color = transition_colors.get(clip.transitionIn.type) or transition_colors.get(clip.transitionOut.type)
    if color is None:
        return None
    opacity = max(0.0, 1.0 - clip_visual_opacity(clip, time))
    if opacity <= 0:
        return None
    return _parse_color(color, opacity)


def _render_media_clip(
    session: PreviewRenderSession,
    clip: "TimelineClip",
    at_time: float,
    opacity_override: float | None = None,
) -> Image.Image | None:
    source_path = _resolve_clip_path(session, clip)
    if not source_path or not os.path.exists(source_path):
        return None

    live_asset = _resolve_clip_asset(session, clip)
    if live_asset is None:
        return None

    if live_asset.type == "video":
        media_duration = float(live_asset.duration or (clip.trimStart + clip.duration + clip.trimEnd))
        target_time = _get_clip_target_time(clip, media_duration, at_time)
        media = _extract_video_frame(source_path, target_time)
    elif live_asset.type == "image":
        media = _load_image(session, source_path)
    else:
        return None

    layer = _fit_media_to_frame(media, session.width, session.height)
    layer = _apply_basic_color_correction(layer, clip)
    layer = _apply_clip_flips(layer, clip)
    layer = _apply_motion_transform(layer, clip, max(0.0, at_time - clip.startTime), session.width, session.height)
    layer = _apply_wipe_mask(layer, clip, max(0.0, at_time - clip.startTime))
    opacity = opacity_override if opacity_override is not None else clip_visual_opacity(clip, at_time)
    return _apply_opacity(layer, opacity)


def _draw_text_line(
    draw: ImageDraw.ImageDraw,
    text: str,
    x: int,
    y: int,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    fill: tuple[int, int, int, int],
    stroke_width: int,
    stroke_fill: tuple[int, int, int, int] | None,
) -> None:
    draw.text(
        (x, y),
        text,
        font=font,
        fill=fill,
        stroke_width=stroke_width,
        stroke_fill=stroke_fill,
    )


def _build_text_block(
    session: PreviewRenderSession,
    wrapped_text: str,
    width: int,
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
    text_style: "TextOverlayStyle",
    frame_scale: float,
) -> Image.Image:
    width = int(width)
    stroke_width = max(0, round(text_style.strokeWidth * frame_scale))
    stroke_fill = None if text_style.strokeColor == "transparent" else _parse_color(text_style.strokeColor)
    fill = _parse_color(text_style.color)
    background = _parse_color(text_style.backgroundColor)
    padding = max(0, round(text_style.padding * frame_scale))
    spacing = max(0, round(max(0.0, text_style.lineHeight - 1.0) * text_style.fontSize * frame_scale))

    measure_draw = ImageDraw.Draw(session.measure_image)
    bbox = measure_draw.multiline_textbbox(
        (0, 0),
        wrapped_text,
        font=font,
        spacing=spacing,
        align=text_style.textAlign,
        stroke_width=stroke_width,
    )
    text_height = int(max(1, bbox[3] - bbox[1]))
    block_height = int(max(1, text_height + padding * 2))
    block = Image.new("RGBA", (max(1, width), block_height), (0, 0, 0, 0))

    if background[3] > 0:
        block_draw = ImageDraw.Draw(block)
        radius = max(0, round(text_style.borderRadius * frame_scale))
        block_draw.rounded_rectangle(
            (0, 0, block.width - 1, block.height - 1),
            radius=radius,
            fill=background,
        )

    text_layer = Image.new("RGBA", block.size, (0, 0, 0, 0))
    text_draw = ImageDraw.Draw(text_layer)

    line_height = max(1, round(text_style.fontSize * frame_scale) + spacing)
    lines = wrapped_text.split("\n")
    current_y = int(padding)
    for line in lines:
        line_width = measure_draw.textlength(line, font=font)
        if text_style.textAlign == "left":
            line_x = padding
        elif text_style.textAlign == "right":
            line_x = max(padding, round(block.width - padding - line_width))
        else:
            line_x = round((block.width - line_width) / 2)
        _draw_text_line(
            text_draw,
            line,
            line_x,
            current_y,
            font,
            fill,
            stroke_width,
            stroke_fill,
        )
        current_y = int(current_y + line_height)

    if text_style.shadowBlur > 0 or text_style.shadowOffsetX != 0 or text_style.shadowOffsetY != 0:
        shadow_layer = Image.new("RGBA", block.size, (0, 0, 0, 0))
        shadow_draw = ImageDraw.Draw(shadow_layer)
        shadow_color = _parse_color(text_style.shadowColor)
        current_y = int(padding + round(text_style.shadowOffsetY * frame_scale))
        for line in lines:
            line_width = measure_draw.textlength(line, font=font)
            if text_style.textAlign == "left":
                line_x = padding + round(text_style.shadowOffsetX * frame_scale)
            elif text_style.textAlign == "right":
                line_x = max(
                    padding,
                    round(block.width - padding - line_width + text_style.shadowOffsetX * frame_scale),
                )
            else:
                line_x = round((block.width - line_width) / 2 + text_style.shadowOffsetX * frame_scale)
            _draw_text_line(
                shadow_draw,
                line,
                line_x,
                current_y,
                font,
                shadow_color,
                stroke_width,
                stroke_fill,
            )
            current_y = int(current_y + line_height)
        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=max(0, text_style.shadowBlur * frame_scale)))
        block.alpha_composite(shadow_layer)

    block.alpha_composite(text_layer)
    return block


def _render_text_clip_layer(
    session: PreviewRenderSession,
    text_style: "TextOverlayStyle",
) -> tuple[Image.Image, int, int]:
    frame_scale = min(session.width, session.height) / 1080
    font_size = max(1, round(text_style.fontSize * frame_scale))
    font = _load_font(session, text_style.fontFamily, font_size, text_style.fontWeight, text_style.fontStyle)

    safe_left = session.width * 0.15
    safe_right = session.width * 0.85
    safe_width = max(1.0, safe_right - safe_left)
    max_width_ratio = max(0.01, min(1.0, text_style.maxWidth / 100)) if text_style.maxWidth > 0 else 1.0
    wrap_width = max(1, round(min(safe_width, session.width * max_width_ratio)))

    wrapped_text = _wrap_text_to_width(session, text_style.text, wrap_width, font)
    block = _build_text_block(session, wrapped_text, wrap_width, font, text_style, frame_scale)

    half_wrap = wrap_width / 2
    unclamped_x = (max(0.0, min(100.0, text_style.positionX)) / 100) * session.width
    min_x = safe_left + half_wrap
    max_x = safe_right - half_wrap
    clamped_x = max(min_x, min(max_x, unclamped_x)) if min_x <= max_x else (safe_left + safe_right) / 2
    clamped_x_px = round(clamped_x - wrap_width / 2)
    top_px = round((text_style.positionY / 100) * session.height - block.height / 2)

    opacity = max(0.0, min(1.0, text_style.opacity / 100))
    return (_apply_opacity(block, opacity), clamped_x_px, top_px)


def _merge_subtitle_style(subtitle: "SubtitleClip", timeline: "Timeline") -> "SubtitleStyle":
    from mcp_server.project_state import SubtitleStyle

    track = timeline.tracks[subtitle.trackIndex] if 0 <= subtitle.trackIndex < len(timeline.tracks) else None
    merged = SubtitleStyle()
    if track is not None and track.subtitleStyle:
        for key, value in track.subtitleStyle.items():
            if hasattr(merged, key):
                setattr(merged, key, value)
    if subtitle.style is not None:
        for key, value in subtitle.style.model_dump(exclude_none=True).items():
            if hasattr(merged, key):
                setattr(merged, key, value)
    return merged


def _render_subtitle_layers(
    session: PreviewRenderSession,
    subtitles: list["SubtitleClip"],
    current_time: float,
) -> list[tuple[Image.Image, int, int]]:
    from mcp_server.project_state import TextOverlayStyle

    layers: list[tuple[Image.Image, int, int]] = []
    frame_font_size = round(min(session.width, session.height) * (0.08 if session.height > session.width else 0.05))
    for subtitle in subtitles:
        style = _merge_subtitle_style(subtitle, session.timeline)
        font = _load_font(
            session,
            style.fontFamily,
            max(1, frame_font_size),
            style.fontWeight,
            "italic" if style.italic else "normal",
        )
        wrapped_text = _wrap_text_to_width(session, subtitle.text, session.width * 0.9, font)
        text_style = TextOverlayStyle(
            text=wrapped_text,
            fontSize=frame_font_size,
            fontFamily=style.fontFamily,
            fontWeight=style.fontWeight,
            fontStyle="italic" if style.italic else "normal",
            color=style.highlightColor if style.highlightEnabled and current_time > subtitle.startTime else style.color,
            backgroundColor=style.backgroundColor,
            textAlign="center",
            strokeColor="transparent",
            strokeWidth=0,
            shadowColor="rgba(0,0,0,0.8)",
            shadowBlur=3,
            shadowOffsetX=1,
            shadowOffsetY=1,
            letterSpacing=0,
            lineHeight=1.2,
            maxWidth=90,
            padding=6,
            borderRadius=4,
            opacity=100,
        )
        block = _build_text_block(session, wrapped_text, max(1, round(session.width * 0.9)), font, text_style, 1.0)
        x = round((session.width - block.width) / 2)
        if style.position == "top":
            y = 12
        elif style.position == "center":
            y = round((session.height - block.height) / 2)
        else:
            y = max(0, session.height - block.height - 12)
        layers.append((block, x, y))
    return layers


def _render_letterbox(
    width: int,
    height: int,
    ratio: float,
    color: str,
    opacity: float,
) -> Image.Image:
    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    fill = _parse_color(color, opacity)
    container_ratio = width / max(1, height)
    if ratio >= container_ratio:
        bar_pct = ((1 - container_ratio / ratio) / 2) * 100
        bar_height = round((bar_pct / 100) * height)
        if bar_height > 0:
            draw.rectangle((0, 0, width, bar_height), fill=fill)
            draw.rectangle((0, height - bar_height, width, height), fill=fill)
    else:
        bar_pct = ((1 - ratio / container_ratio) / 2) * 100
        bar_width = round((bar_pct / 100) * width)
        if bar_width > 0:
            draw.rectangle((0, 0, bar_width, height), fill=fill)
            draw.rectangle((width - bar_width, 0, width, height), fill=fill)
    return overlay


def _render_frame_image(session: PreviewRenderSession, time: float) -> Image.Image:
    render_state = derive_render_state(session.timeline, time)
    frame = Image.new("RGBA", (session.width, session.height), (0, 0, 0, 255))

    for clip in render_state.compositing_stack:
        clip_layer = _render_media_clip(session, clip, time)
        if clip_layer is not None:
            frame.alpha_composite(clip_layer)

    if render_state.active_clip is not None:
        transition_background = _transition_background_color(render_state.active_clip, time)
        if transition_background is not None:
            frame.alpha_composite(Image.new("RGBA", frame.size, transition_background))

    if render_state.cross_dissolve is not None:
        outgoing = render_state.cross_dissolve.outgoing
        incoming = render_state.cross_dissolve.incoming
        outgoing_opacity = (1 - render_state.cross_dissolve_progress) * ((outgoing.opacity or 100) / 100)
        incoming_opacity = render_state.cross_dissolve_progress * ((incoming.opacity or 100) / 100)
        outgoing_layer = _render_media_clip(session, outgoing, time, opacity_override=outgoing_opacity)
        incoming_layer = _render_media_clip(session, incoming, time, opacity_override=incoming_opacity)
        if outgoing_layer is not None:
            frame.alpha_composite(outgoing_layer)
        if incoming_layer is not None:
            frame.alpha_composite(incoming_layer)
    elif render_state.active_clip is not None:
        active_layer = _render_media_clip(session, render_state.active_clip, time)
        if active_layer is not None:
            frame.alpha_composite(active_layer)

    for text_clip in render_state.active_text_clips:
        if text_clip.textStyle is None:
            continue
        layer, x, y = _render_text_clip_layer(session, text_clip.textStyle)
        _composite_at(frame, layer, x, y)

    for subtitle_layer, x, y in _render_subtitle_layers(session, render_state.active_subtitles, time):
        _composite_at(frame, subtitle_layer, x, y)

    if render_state.active_letterbox is not None:
        frame.alpha_composite(
            _render_letterbox(
                session.width,
                session.height,
                render_state.active_letterbox.ratio,
                render_state.active_letterbox.color,
                render_state.active_letterbox.opacity,
            )
        )

    return frame


def _encode_preview_frames(frame_pattern: str, fps: int, output_path: str) -> None:
    ffmpeg = _get_ffmpeg_path()
    cmd = [
        ffmpeg,
        "-y",
        "-framerate",
        str(fps),
        "-i",
        frame_pattern,
        "-vf",
        "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "24",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        output_path,
    ]
    result = subprocess.run(
        cmd,
        capture_output=True,
        check=False,
        timeout=_DEFAULT_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace")[-500:]
        raise RuntimeError(f"FFmpeg failed to encode preview clip: {detail}")


def render_preview_frame(
    *,
    project_payload: dict[str, Any],
    time: float,
    width: int,
    height: int,
    output_path: str | None = None,
) -> dict[str, Any]:
    normalized_width, normalized_height = _normalize_frame_size(width, height)
    with _RENDER_LOCK:
        session = _build_session(project_payload, normalized_width, normalized_height)
        frame = _render_frame_image(session, max(0.0, time))
        final_output_path = _ensure_output_path("png", output_path)
        frame.save(final_output_path, format="PNG")
    return {
        "imagePath": final_output_path,
        "time": max(0.0, time),
        "width": normalized_width,
        "height": normalized_height,
    }


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
    normalized_width, normalized_height = _normalize_frame_size(width, height)
    normalized_start = max(0.0, start_time)
    normalized_duration = max(0.1, duration)
    normalized_fps = max(1, fps)
    final_output_path = _ensure_output_path("mp4", output_path)

    with _RENDER_LOCK:
        session = _build_session(project_payload, normalized_width, normalized_height)
        frame_count = max(1, math.ceil(normalized_duration * normalized_fps))
        with tempfile.TemporaryDirectory(prefix="ltx-agent-preview-clip-") as tmp_dir:
            tmp_path = Path(tmp_dir)
            for frame_index in range(frame_count):
                frame_time = normalized_start + (frame_index / normalized_fps)
                frame = _render_frame_image(session, frame_time)
                frame_path = tmp_path / f"frame_{frame_index:04d}.png"
                frame.save(frame_path, format="PNG")
            _encode_preview_frames(str(tmp_path / "frame_%04d.png"), normalized_fps, final_output_path)

    return {
        "videoPath": final_output_path,
        "startTime": normalized_start,
        "duration": normalized_duration,
        "fps": normalized_fps,
        "frameCount": frame_count,
        "width": normalized_width,
        "height": normalized_height,
    }
