# LTX Desktop MCP Server

An MCP (Model Context Protocol) server that exposes the LTX Desktop video editing
lifecycle as agentic tool calls.

## Transport

When LTX Desktop is running, the backend exposes:

- Streamable HTTP at `http://127.0.0.1:8765/mcp`
- SSE at `http://127.0.0.1:8765/mcp-sse`

MCP endpoints are localhost-only and currently do not require auth.

## Tools

By default, the MCP server registers the editing-focused tool set and leaves AI
generation MCP tools disabled. Module- and tool-level availability is controlled
by the app settings `mcp_modules` and `mcp_tools`.

| Group | Tools |
|-------|-------|
| **Project** (5) | `create_project`, `open_project`, `save_project`, `get_project_state`, `list_projects` |
| **Assets** (3) | `import_asset`, `list_assets`, `get_asset_info` |
| **Timeline** (23) | `add_clip`, `remove_clip`, `move_clip`, `trim_clip`, `split_clip`, `get_timeline_state`, `inspect_timeline`, `preview_frame`, `preview_clip`, `set_clip_speed`, `set_clip_volume`, `set_clip_muted`, `reverse_clip`, `set_clip_opacity`, `flip_clip`, `set_clip_motion`, `set_clip_color_correction`, `set_clip_transition`, `add_clip_effect`, `remove_clip_effect`, `update_clip_effect`, `update_clip`, `retake_clip` |
| **Tracks** (4) | `add_track`, `remove_track`, `reorder_track`, `set_track_properties` |
| **Text clips** (2) | `add_text_clip`, `update_text_clip_style` |
| **Subtitles** (8) | `add_subtitle`, `update_subtitle`, `remove_subtitle`, `set_subtitle_style`, `set_subtitle_track_style`, `split_subtitle_progressive`, `split_all_subtitles_progressive`, `list_subtitles` |
| **AI generation** (5, optional) | `generate_video`, `ai_retake_clip`, `fill_gap`, `get_generation_status`, `cancel_generation` |
| **Export** (2) | `export_timeline`, `get_export_status` |

## Supported Effects and Transitions

**Effects** (`add_clip_effect` — `effect_type`):
- Filters: `blur` (amount 0–50), `sharpen` (0–100), `glow` (amount + radius 0–50), `vignette` (0–100), `grain` (0–100)
- LUT presets: `lut-cinematic`, `lut-vintage`, `lut-bw`, `lut-cool`, `lut-warm`, `lut-muted`, `lut-vivid` (intensity 0–100)

**Transitions** (`set_clip_transition` — `transition_type`):
`none`, `dissolve`, `fade-to-black`, `fade-to-white`, `wipe-left`, `wipe-right`, `wipe-up`, `wipe-down`

**Color correction** (`set_clip_color_correction`):
All fields -100 to 100: `brightness`, `contrast`, `saturation`, `temperature`, `tint`, `exposure`, `highlights`, `shadows`

**Motion** (`set_clip_motion`):
Ken Burns-style pan/zoom for **image and video** clips (focus X/Y in 0–100% of frame, scale >= 1).

**Subtitle style** (`set_subtitle_style`, `set_subtitle_track_style`):
`font_size`, `font_family`, `font_weight`, `color`, `background_color`, `position` (top/center/bottom), `italic`

**Text clip style** (`add_text_clip` / `update_text_clip_style`):
Full rich styling: position X/Y (0–100%), font, size, weight, style, color, background, stroke, shadow, letter spacing, line height, max width, padding, border radius, opacity.

## Tool Selection Guidance

- Use subtitle tools for spoken captions, transcript text, karaoke/progressive captions, and anything that should live on a subtitle track.
- Use `add_text_clip` for designed editorial text such as titles, lower thirds, labels, and callouts.
- Do not use text clips to emulate ordinary subtitles unless the user explicitly asks for a graphic overlay treatment instead of subtitle behavior.

## End-to-End Agent Workflow

```python
# 1. Create a project
project = mcp.create_project("My Scene")

# 2. Generate a video
result = mcp.generate_video("a cat walking through a sunlit park", duration="6")
# result["video_path"] -> "/path/to/generated.mp4"

# 3. Import the generated video as an asset
asset = mcp.import_asset(result["video_path"], prompt="a cat walking through a sunlit park")

# 4. Add the asset to the timeline
clip = mcp.add_clip(asset["id"], track_index=0, start_time=0.0)

# 5. Add a color grade
mcp.add_clip_effect(clip["id"], "lut-cinematic", intensity=80)

# 6. Add a subtitle
mcp.add_subtitle("A beautiful sunny day", start_time=1.0, end_time=4.0,
                 position="bottom", background_color="rgba(0,0,0,0.6)")

# 7. Export (basic ffmpeg concat)
job = mcp.export_timeline()
while True:
  status = mcp.get_export_status(job["job_id"])
  if status["status"] in ("complete", "error"):
    break
```

## Viewing MCP Projects in LTX Desktop UI

MCP projects are saved as JSON to `{outputs_dir}/mcp_projects/{id}.json`.

The frontend lists MCP projects via `GET /api/mcp/projects` and fetches
`GET /api/mcp/projects/{id}` when the backend project updates.

## Hidden Preview Rendering

`preview_frame` and `preview_clip` use a localhost-only Electron bridge plus a
hidden preview window inside the desktop app. They do not depend on the visible
editor UI being open, but they do require the backend to be launched by LTX
Desktop so the bridge URL/token are available.

## Project State Directory

Projects are stored at: `{handler.config.outputs_dir}/mcp_projects/`

## Connecting with MCP Inspector

```bash
npx @modelcontextprotocol/inspector http://127.0.0.1:8765/mcp
```
