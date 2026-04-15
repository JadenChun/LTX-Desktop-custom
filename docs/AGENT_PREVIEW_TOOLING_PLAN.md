# Agent Preview Tooling Plan

This document describes the recommended architecture for agent-facing timeline inspection and preview tools in LTX Desktop.

## Goals

- Give agents a cheap way to understand current timeline state.
- Give agents a reliable single-frame preview tool for crop, placement, subtitles, and overlays.
- Give agents a short motion preview tool for timing, transitions, and animation checks.
- Avoid interrupting the user's visible editor while previews are generated.
- Avoid duplicating the timeline compositor in Python.

## Desired Tool Set

We want three tools with different cost profiles so an agent can choose the cheapest useful option first.

### 1. `inspect_timeline`

Purpose:
- Fast structural inspection.
- Used before any visual render.

Suggested output:
- project id
- timeline id
- total duration
- tracks
- clips
- subtitles
- if `time` is provided:
  - active clip
  - active compositing stack
  - active text clips
  - active subtitles
  - dissolve state
  - audio-only clips
  - letterbox state

Expected cost:
- Very low

### 2. `preview_frame`

Purpose:
- Single still image preview at a timeline time.
- Used to verify composition, crop, text, subtitle placement, and frame-level state.

Suggested input:
- `project_id`
- `time`
- `width` optional, default `640`
- `height` optional

Suggested output:
- `image_path`
- `time`
- `width`
- `height`
- `project_id`
- `timeline_id`

Expected cost:
- Medium

### 3. `preview_clip`

Purpose:
- Short motion preview for timing, transitions, and motion checks.
- Used only when `inspect_timeline` and `preview_frame` are insufficient.

Suggested input:
- `project_id`
- `start_time`
- `duration` optional, default `1.5`
- `width` optional, default `640`
- `fps` optional, default `8`

Suggested output:
- `video_path`
- `start_time`
- `duration`
- `width`
- `height`
- `fps`
- `frame_count`
- `project_id`
- `timeline_id`

Expected cost:
- Highest of the three

## Recommended Architecture

Use a four-part flow:

1. Python backend MCP remains the public tool surface.
2. Electron main becomes the preview orchestration layer.
3. A hidden preview worker window renders timeline previews offscreen.
4. Shared render-state logic is extracted from the editor so the visible preview and hidden preview use the same rules.

## Why This Architecture

### Why not Python backend only

The Python backend already owns project and timeline state, but it does not currently own the preview compositor. Rebuilding preview rendering in Python would create a second implementation for:

- active clip selection
- dissolve timing
- compositing stack rules
- text layout
- subtitle layout
- letterbox state
- visual effect semantics

That would be expensive to build and difficult to keep in sync with the actual editor.

### Why not use the visible editor directly

The visible editor already renders the preview, but using it for agent preview generation can:

- interfere with the user's current editing session
- create UI focus and timing issues
- make tool output depend on current UI state

### Why a hidden preview worker window

A hidden renderer gives us:

- the same web rendering stack as the editor
- no interruption to the visible UI
- a stable surface for frame capture and short preview capture
- a path to reuse existing React and timeline logic

## Main Components

### A. Shared Render-State Module

Extract the pure preview-selection logic from `frontend/views/editor/ProgramMonitor.tsx` into a shared module.

This module should own:

- active clip selection
- dissolve detection
- active text clip selection
- active subtitle selection
- compositing stack derivation
- active letterbox derivation
- active video contributor selection
- render-state assembly for a given time

Suggested location:
- `frontend/lib/timeline-render-state.ts`

Requirements:
- React-free
- no DOM access
- deterministic input/output
- usable by both the editor and hidden preview worker

### B. Hidden Preview Worker

Create a lightweight hidden renderer page that mounts only the program preview surface.

Responsibilities:
- load project state
- seek to one timeline time or a sequence of times
- render with the shared render-state logic
- notify Electron main when a frame is ready to capture

Suggested location:
- `frontend/views/AgentPreviewWorker.tsx`

Important constraint:
- This worker must not depend on the visible editor session state.

### C. Electron Main Preview Service

Electron main should:

- create and manage the hidden preview worker window
- send project data and render requests to the worker
- wait for render completion
- capture stills or short clips
- save output files
- return metadata to the caller

Suggested responsibilities:
- `renderPreviewFrame(...)`
- `renderPreviewClip(...)`
- preview worker lifecycle management
- temp output cleanup policy

Suggested location:
- `electron/preview/preview-service.ts`
- `electron/preview/preview-ipc.ts`

### D. Backend MCP Bridge

The MCP tools should stay in Python, but they should forward preview requests to Electron rather than implementing rendering in Python.

Responsibilities:
- validate tool inputs
- ensure the target project is available
- call the Electron preview service
- return output metadata

Possible bridge approaches:
- local HTTP route exposed by Electron
- internal IPC bridge if backend startup already has a communication channel
- a small loopback request service owned by Electron main

Preferred rule:
- Python should not become the preview compositor.

## Implementation Phases

### Phase 1. Tool contracts and shared state

Deliverables:
- finalize tool names and payloads
- extract shared render-state module
- update `ProgramMonitor` to consume shared logic

Exit criteria:
- editor preview still behaves the same
- shared module has unit coverage for selection rules

### Phase 2. `inspect_timeline`

Deliverables:
- add or expand backend tool output for time-specific render state

Notes:
- this is the cheapest tool
- agents should use it before requesting preview images or video

Exit criteria:
- an agent can tell what should be visible at a given time without rendering

### Phase 3. `preview_frame`

Deliverables:
- hidden preview worker
- Electron main frame capture
- backend bridge
- MCP tool exposure

Exit criteria:
- an agent can request a frame at a timeline time and receive an image path
- visible editor is not disturbed

### Phase 4. `preview_clip`

Deliverables:
- repeated frame capture or lightweight timed playback capture
- encoding to a short MP4 or GIF-like preview output
- MCP tool exposure

Exit criteria:
- an agent can request a short motion preview without full export

### Phase 5. Documentation and usage guidance

Deliverables:
- MCP README updates
- agent usage recommendations
- troubleshooting notes

Exit criteria:
- tool users know when to use each tool

## Recommended Agent Usage Policy

Agents should use tools in this order:

1. `inspect_timeline`
2. `preview_frame`
3. `preview_clip`

Suggested heuristics:

- Use `inspect_timeline` for trim, overlap, selection, and subtitle timing checks.
- Use `preview_frame` for crop, placement, text, subtitle, and compositing checks.
- Use `preview_clip` only for motion, dissolve timing, or ambiguous frame-to-frame behavior.

## Risks and Mitigations

### Drift between visible editor and hidden preview

Risk:
- hidden preview and editor preview diverge over time

Mitigation:
- one shared render-state module
- keep visual rules in shared code where possible
- add regression cases for known tricky timelines

### Cross-platform font and layout differences

Risk:
- text and subtitle placement may differ by OS

Mitigation:
- use the same renderer stack as the app
- prefer installed or bundled fonts already used by the app

### Preview clip cost

Risk:
- repeated frame capture or encoding could be slow

Mitigation:
- keep duration short by default
- keep fps low by default
- keep output resolution modest by default

### State sync issues

Risk:
- preview worker renders stale project data

Mitigation:
- send full project snapshot per request or use explicit versioning
- include `updatedAt` in requests and responses

## Default Output Policy

Suggested defaults:

- preview frame width: `640`
- preview clip duration: `1.5s`
- preview clip fps: `8`
- preview output path: temp directory owned by app

Suggested cleanup policy:

- keep recent preview outputs briefly for agent inspection
- prune old preview temp files on app startup or on a fixed retention window

## Suggested File Layout

- `docs/AGENT_PREVIEW_TOOLING_PLAN.md`
- `docs/AGENT_PREVIEW_TOOLING_CHECKLIST.md`
- `frontend/lib/timeline-render-state.ts`
- `frontend/views/AgentPreviewWorker.tsx`
- `electron/preview/preview-service.ts`
- `electron/preview/preview-ipc.ts`
- `backend/mcp_server/tools/preview.py`

## Success Criteria

The project is successful when:

- the agent can inspect timeline state cheaply
- the agent can request one still preview without disturbing the user
- the agent can request a short motion preview without full export
- the visible editor and preview worker stay visually aligned
