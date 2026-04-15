export type McpModuleId =
  | 'project'
  | 'assets'
  | 'timeline'
  | 'tracks'
  | 'subtitle'
  | 'text_overlay'
  | 'export'
  | 'ai_generation'

export interface McpToolDefinition {
  id: string
  label: string
  description: string
}

export interface McpModuleDefinition {
  id: McpModuleId
  label: string
  description: string
  defaultEnabled: boolean
  tools: McpToolDefinition[]
}

export const MCP_MODULES: McpModuleDefinition[] = [
  {
    id: 'project',
    label: 'Project',
    description: 'Project lifecycle tools for creating, opening, saving, and inspecting MCP projects.',
    defaultEnabled: true,
    tools: [
      { id: 'create_project', label: 'create_project', description: 'Create a new MCP project.' },
      { id: 'open_project', label: 'open_project', description: 'Open an existing MCP project by id.' },
      { id: 'save_project', label: 'save_project', description: 'Persist the active project to disk.' },
      { id: 'get_project_state', label: 'get_project_state', description: 'Inspect the full active project state.' },
      { id: 'list_projects', label: 'list_projects', description: 'List saved MCP projects.' },
    ],
  },
  {
    id: 'assets',
    label: 'Assets',
    description: 'Asset import and inspection tools for project media.',
    defaultEnabled: true,
    tools: [
      { id: 'import_asset', label: 'import_asset', description: 'Import a media file into the active project.' },
      { id: 'list_assets', label: 'list_assets', description: 'List imported assets in the active project.' },
      { id: 'get_asset_info', label: 'get_asset_info', description: 'Inspect one asset in detail.' },
    ],
  },
  {
    id: 'timeline',
    label: 'Timeline',
    description: 'Timeline editing, inspection, preview, clip property, and take-management tools.',
    defaultEnabled: true,
    tools: [
      { id: 'add_clip', label: 'add_clip', description: 'Place an asset on the timeline.' },
      { id: 'remove_clip', label: 'remove_clip', description: 'Remove a clip from the timeline.' },
      { id: 'move_clip', label: 'move_clip', description: 'Move a clip to a new track or start time.' },
      { id: 'trim_clip', label: 'trim_clip', description: 'Trim clip in/out points.' },
      { id: 'split_clip', label: 'split_clip', description: 'Split a clip at a timeline position.' },
      { id: 'get_timeline_state', label: 'get_timeline_state', description: 'Inspect the active timeline state.' },
      { id: 'inspect_timeline', label: 'inspect_timeline', description: 'Inspect clips, tracks, and layout with MCP-friendly detail.' },
      { id: 'preview_frame', label: 'preview_frame', description: 'Render a preview frame from the timeline.' },
      { id: 'preview_clip', label: 'preview_clip', description: 'Render a preview of one clip.' },
      { id: 'set_clip_speed', label: 'set_clip_speed', description: 'Adjust clip playback speed.' },
      { id: 'set_clip_volume', label: 'set_clip_volume', description: 'Adjust clip audio volume.' },
      { id: 'set_clip_muted', label: 'set_clip_muted', description: 'Mute or unmute clip audio.' },
      { id: 'reverse_clip', label: 'reverse_clip', description: 'Toggle reverse playback on a clip.' },
      { id: 'set_clip_opacity', label: 'set_clip_opacity', description: 'Adjust visual clip opacity.' },
      { id: 'flip_clip', label: 'flip_clip', description: 'Flip a clip horizontally or vertically.' },
      { id: 'set_clip_motion', label: 'set_clip_motion', description: 'Apply motion or pan/zoom settings.' },
      { id: 'set_clip_color_correction', label: 'set_clip_color_correction', description: 'Adjust clip color correction.' },
      { id: 'set_clip_transition', label: 'set_clip_transition', description: 'Configure clip transitions.' },
      { id: 'add_clip_effect', label: 'add_clip_effect', description: 'Add a clip effect.' },
      { id: 'remove_clip_effect', label: 'remove_clip_effect', description: 'Remove a clip effect.' },
      { id: 'update_clip_effect', label: 'update_clip_effect', description: 'Update an existing clip effect.' },
      { id: 'update_clip', label: 'update_clip', description: 'Patch general clip fields.' },
      { id: 'retake_clip', label: 'retake_clip', description: 'Switch a timeline clip to a different take.' },
    ],
  },
  {
    id: 'tracks',
    label: 'Tracks',
    description: 'Track creation, ordering, and property controls.',
    defaultEnabled: true,
    tools: [
      { id: 'add_track', label: 'add_track', description: 'Add a track to the active timeline.' },
      { id: 'remove_track', label: 'remove_track', description: 'Remove a track from the active timeline.' },
      { id: 'reorder_track', label: 'reorder_track', description: 'Move a track to a new position.' },
      { id: 'set_track_properties', label: 'set_track_properties', description: 'Update track mute, lock, enable, or naming state.' },
    ],
  },
  {
    id: 'subtitle',
    label: 'Subtitles',
    description: 'Subtitle-track tools for captions, styling, and progressive subtitle behavior.',
    defaultEnabled: true,
    tools: [
      { id: 'add_subtitle', label: 'add_subtitle', description: 'Add a subtitle cue.' },
      { id: 'update_subtitle', label: 'update_subtitle', description: 'Update an existing subtitle cue.' },
      { id: 'remove_subtitle', label: 'remove_subtitle', description: 'Remove a subtitle cue.' },
      { id: 'set_subtitle_style', label: 'set_subtitle_style', description: 'Style one subtitle cue.' },
      { id: 'set_subtitle_track_style', label: 'set_subtitle_track_style', description: 'Style a whole subtitle track.' },
      { id: 'split_subtitle_progressive', label: 'split_subtitle_progressive', description: 'Split one subtitle into progressive words or beats.' },
      { id: 'split_all_subtitles_progressive', label: 'split_all_subtitles_progressive', description: 'Apply progressive splitting to all subtitles.' },
      { id: 'list_subtitles', label: 'list_subtitles', description: 'List subtitle cues on the active timeline.' },
    ],
  },
  {
    id: 'text_overlay',
    label: 'Text Clips',
    description: 'Designed on-screen text clip tools for titles, hooks, labels, and callouts.',
    defaultEnabled: true,
    tools: [
      { id: 'add_text_clip', label: 'add_text_clip', description: 'Add a text clip to the timeline.' },
      { id: 'update_text_clip_style', label: 'update_text_clip_style', description: 'Update an existing text clip style.' },
    ],
  },
  {
    id: 'export',
    label: 'Export',
    description: 'Timeline export and export job status tools.',
    defaultEnabled: true,
    tools: [
      { id: 'export_timeline', label: 'export_timeline', description: 'Start a timeline export job.' },
      { id: 'get_export_status', label: 'get_export_status', description: 'Check export job progress and result.' },
    ],
  },
  {
    id: 'ai_generation',
    label: 'AI Generation',
    description: 'Optional AI generation tools for creating or regenerating media from the MCP surface.',
    defaultEnabled: false,
    tools: [
      { id: 'generate_video', label: 'generate_video', description: 'Generate a new video through the AI pipeline.' },
      { id: 'ai_retake_clip', label: 'ai_retake_clip', description: 'Regenerate a portion of a source video with AI.' },
      { id: 'fill_gap', label: 'fill_gap', description: 'Suggest an AI prompt for filling a timeline gap.' },
      { id: 'get_generation_status', label: 'get_generation_status', description: 'Check active AI generation progress.' },
      { id: 'cancel_generation', label: 'cancel_generation', description: 'Cancel a running AI generation job.' },
    ],
  },
]

export function createDefaultMcpModules(): Record<McpModuleId, boolean> {
  return Object.fromEntries(
    MCP_MODULES.map((module) => [module.id, module.defaultEnabled]),
  ) as Record<McpModuleId, boolean>
}

export function createDefaultMcpTools(): Record<McpModuleId, Record<string, boolean>> {
  return Object.fromEntries(
    MCP_MODULES.map((module) => [
      module.id,
      Object.fromEntries(module.tools.map((tool) => [tool.id, true])),
    ]),
  ) as Record<McpModuleId, Record<string, boolean>>
}
