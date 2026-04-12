import { z } from 'zod'

export const previewFrameRequestSchema = z.object({
  project: z.unknown(),
  time: z.number().min(0),
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
  outputPath: z.string().optional(),
})

export const previewClipRequestSchema = z.object({
  project: z.unknown(),
  startTime: z.number().min(0),
  duration: z.number().positive().max(10),
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
  fps: z.number().int().min(1).max(24),
  outputPath: z.string().optional(),
})

export const previewFrameResponseSchema = z.object({
  imagePath: z.string(),
  time: z.number(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})

export const previewClipResponseSchema = z.object({
  videoPath: z.string(),
  startTime: z.number(),
  duration: z.number(),
  fps: z.number().int().positive(),
  frameCount: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})

export type PreviewFrameRequest = z.infer<typeof previewFrameRequestSchema>
export type PreviewClipRequest = z.infer<typeof previewClipRequestSchema>
export type PreviewFrameResponse = z.infer<typeof previewFrameResponseSchema>
export type PreviewClipResponse = z.infer<typeof previewClipResponseSchema>
