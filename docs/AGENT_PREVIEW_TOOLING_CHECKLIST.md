# Agent Preview Tooling Checklist

Use this checklist to implement agent-facing timeline preview support in a low-risk order.

## Phase 1. Contracts and shared logic

- [ ] Finalize tool names and payloads for `inspect_timeline`, `preview_frame`, and `preview_clip`.
- [ ] Decide whether `inspect_timeline` extends the existing timeline tool or ships as a new tool.
- [ ] Extract pure render-state functions from `ProgramMonitor.tsx`.
- [ ] Create a shared render-state module with no React or DOM dependencies.
- [ ] Switch `ProgramMonitor` to use the shared render-state module.
- [ ] active clip selection
- [ ] dissolve detection
- [ ] subtitle visibility
- [ ] compositing stack selection
- [ ] letterbox selection

## Phase 2. Timeline inspection tool

- [ ] Add time-specific render-state output to the backend tool surface.
- [ ] Return active clip, text clips, subtitles, compositing stack, and dissolve state when `time` is provided.
- [ ] Document intended usage: agents should call this before visual preview tools.
- [ ] Add backend tests for `inspect_timeline` responses.

## Phase 3. Hidden preview worker

- [ ] Create a hidden renderer entrypoint for preview-only rendering.
- [ ] Ensure it can receive a full project snapshot plus a target time.
- [ ] Mount only the program preview surface, not the full editor UI.
- [ ] Confirm it does not mutate the visible editor state.
- [ ] Add a ready signal so Electron main knows when a frame is stable.

## Phase 4. Electron preview service

- [ ] Add Electron main preview service files.
- [ ] Create and manage the hidden preview worker window lifecycle.
- [ ] Implement `renderPreviewFrame(...)`.
- [ ] Save still images to a temp output path.
- [ ] Return output metadata with path, width, height, time, and project version.
- [ ] Add cleanup policy for temporary preview outputs.

## Phase 5. Frame preview tool

- [ ] Add a backend-to-Electron bridge for preview requests.
- [ ] Add MCP tool exposure for `preview_frame`.
- [ ] Add validation for project id, time, and output parameters.
- [ ] Add error handling for missing assets or failed render readiness.
- [ ] Add integration coverage for a frame preview request.

## Phase 6. Short preview clip tool

- [ ] Decide clip output format and encoding path.
- [ ] Reuse the hidden preview worker for repeated frame rendering.
- [ ] Implement `renderPreviewClip(...)` with conservative defaults.
- [ ] Encode a short preview clip from rendered frames.
- [ ] Return output metadata with video path, duration, fps, and frame count.
- [ ] Add integration coverage for a preview clip request.

## Phase 7. Quality alignment

- [ ] Verify text overlay placement matches the visible editor.
- [ ] Verify subtitle placement matches the visible editor.
- [ ] Verify dissolve timing matches the visible editor.
- [ ] Verify opacity and compositing behavior matches the visible editor.
- [ ] Verify letterbox output matches the visible editor.
- [ ] Record known differences between preview worker output and full export, if any.

## Phase 8. Documentation

- [ ] Update `backend/mcp_server/README.md` with the new tools.
- [ ] Add usage guidance describing tool cost and when agents should use each one.
- [ ] Link plan and checklist docs from the repo README.
- [ ] Add troubleshooting notes for stale project state, missing media, and preview failures.

## Default Usage Guidance

- [ ] Agents use `inspect_timeline` first.
- [ ] Agents use `preview_frame` second.
- [ ] Agents use `preview_clip` only when motion or timing ambiguity remains.

## Done Definition

- [ ] A user can keep editing while previews are generated offscreen.
- [ ] An agent can inspect timeline state without rendering.
- [ ] An agent can request a reliable still image preview.
- [ ] An agent can request a short motion preview.
- [ ] The preview worker stays aligned with the visible editor behavior.
