"""Standalone stdio MCP entrypoint for LTX Desktop."""

from __future__ import annotations

import logging
import os
import platform
import sys

import torch

from app_data_dir import resolve_app_data_dir
from state.app_settings import AppSettings
from state import build_initial_state
from app_handler import build_default_service_bundle
from mcp_server import create_mcp_server
from runtime_config.model_download_specs import (
    DEFAULT_MODEL_DOWNLOAD_SPECS,
    DEFAULT_REQUIRED_MODEL_TYPES,
)
from runtime_config.runtime_config import RuntimeConfig
from runtime_config.runtime_policy import decide_force_api_generations
from services.gpu_info.gpu_info_impl import GpuInfoImpl

logging.basicConfig(level=logging.INFO, handlers=[logging.StreamHandler(sys.stderr)])
logger = logging.getLogger(__name__)

LTX_API_BASE_URL = "https://api.ltx.video"
CAMERA_MOTION_PROMPTS = {
    "none": "",
    "static": ", static camera, locked off shot, no camera movement",
    "focus_shift": ", focus shift, rack focus, changing focal point",
    "dolly_in": ", dolly in, camera pushing forward, smooth forward movement",
    "dolly_out": ", dolly out, camera pulling back, smooth backward movement",
    "dolly_left": ", dolly left, camera tracking left, lateral movement",
    "dolly_right": ", dolly right, camera tracking right, lateral movement",
    "jib_up": ", jib up, camera rising up, upward crane movement",
    "jib_down": ", jib down, camera lowering down, downward crane movement",
}
DEFAULT_NEGATIVE_PROMPT = (
    "blurry, out of focus, overexposed, underexposed, low contrast, washed out colors, "
    "excessive noise, grainy texture, poor lighting, flickering, motion blur, distorted proportions, "
    "unnatural skin tones, deformed facial features, asymmetrical face, missing facial features, "
    "extra limbs, disfigured hands, wrong hand count, artifacts around text, inconsistent perspective, "
    "camera shake, incorrect depth of field"
)


def _get_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def _resolve_force_api_generations() -> bool:
    gpu_info = GpuInfoImpl()
    return decide_force_api_generations(
        system=platform.system(),
        cuda_available=gpu_info.get_cuda_available(),
        vram_gb=gpu_info.get_vram_total_gb(),
    )


def _build_handler():
    app_data_dir = resolve_app_data_dir()
    default_models_dir = app_data_dir / "models"
    outputs_dir = app_data_dir / "outputs"
    default_models_dir.mkdir(parents=True, exist_ok=True)
    outputs_dir.mkdir(parents=True, exist_ok=True)

    config = RuntimeConfig(
        device=_get_device(),
        default_models_dir=default_models_dir,
        model_download_specs=DEFAULT_MODEL_DOWNLOAD_SPECS,
        required_model_types=DEFAULT_REQUIRED_MODEL_TYPES,
        outputs_dir=outputs_dir,
        settings_file=app_data_dir / "settings.json",
        ltx_api_base_url=LTX_API_BASE_URL,
        force_api_generations=_resolve_force_api_generations(),
        use_sage_attention=os.environ.get("USE_SAGE_ATTENTION", "1") == "1",
        camera_motion_prompts=CAMERA_MOTION_PROMPTS,
        default_negative_prompt=DEFAULT_NEGATIVE_PROMPT,
        dev_mode=os.environ.get("LTX_DEV_MODE") == "1",
    )

    handler = build_initial_state(
        config,
        AppSettings(),
        service_bundle=build_default_service_bundle(config),
    )
    return handler


def main() -> None:
    logger.info("Starting LTX Desktop MCP over stdio")
    handler = _build_handler()
    server = create_mcp_server(handler, transport="stdio")
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
