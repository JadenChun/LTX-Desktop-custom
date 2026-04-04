import path from 'path'
import fs from 'fs'
import os from 'os'
import { getAllowedRoots } from '../config'
import { logger } from '../logger'
import { validatePath, approvePath } from '../path-validation'
import { findFfmpegPath, runFfmpeg, stopExportProcess } from './ffmpeg-utils'
import { getMainWindow } from '../window'
import { flattenTimeline } from './timeline'
import type { ExportSubtitle, ExportTextOverlay } from './video-filter'
import { buildVideoFilterGraph, generateAssContent } from './video-filter'
import { mixAudioToPcm } from './audio-mix'
import { handle } from '../ipc/typed-handle'

export function registerExportHandlers(): void {
  handle('exportNative', async ({ clips, outputPath, codec, width, height, fps, quality, letterbox, subtitles, textOverlays }: {
    clips: Parameters<typeof flattenTimeline>[0]; outputPath: string; codec: string; width: number; height: number; fps: number; quality: number;
    letterbox?: { ratio: number; color: string; opacity: number };
    subtitles?: ExportSubtitle[];
    textOverlays?: ExportTextOverlay[];
  }) => {
    const ffmpegPath = findFfmpegPath()
    if (!ffmpegPath) return { success: false, error: 'FFmpeg not found' }

    // Approve clip source paths (they are trusted project references that may
    // have been approved in a prior session before the in-memory set was cleared)
    for (const clip of clips) {
      const fp = clip.path
      if (fp) approvePath(fp)
    }

    try {
      validatePath(outputPath, getAllowedRoots())
      for (const clip of clips) {
        const fp = clip.path
        if (fp) validatePath(fp, getAllowedRoots())
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }

    const segments = flattenTimeline(clips)
    if (segments.length === 0) return { success: false, error: 'No clips to export' }

    for (const seg of segments) {
      if (seg.filePath && !fs.existsSync(seg.filePath)) {
        return { success: false, error: `Source file not found: ${path.basename(seg.filePath)}` }
      }
    }

    const tmpDir = os.tmpdir()
    const ts = Date.now()
    const tmpVideo = path.join(tmpDir, `ltx-export-video-${ts}.mkv`)
    const tmpAudio = path.join(tmpDir, `ltx-export-audio-${ts}.wav`)

    // Generate ASS subtitle file for burn-in (libass handles text wrapping natively)
    let assFilePath: string | undefined
    if ((subtitles && subtitles.length > 0) || (textOverlays && textOverlays.length > 0)) {
      const assContent = generateAssContent(subtitles || [], textOverlays || [], width, height)
      assFilePath = path.join(tmpDir, `ltx-subs-${ts}.ass`)
      fs.writeFileSync(assFilePath, assContent, 'utf8')
    }

    const cleanup = () => {
      try { fs.unlinkSync(tmpVideo) } catch {}
      try { fs.unlinkSync(tmpAudio) } catch {}
      if (assFilePath) try { fs.unlinkSync(assFilePath) } catch {}
    }

    // Compute total duration for progress reporting
    let totalDurationForProgress = segments.reduce((max, s) => Math.max(max, s.startTime + s.duration), 0)
    for (const c of clips) {
      totalDurationForProgress = Math.max(totalDurationForProgress, c.startTime + c.duration)
    }

    const sendProgress = (percent: number) => {
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('export-progress', Math.min(99, Math.round(percent)))
      }
    }

    try {
      // STEP 1: Export video-only (simple concat, no audio complexity) — 0-70%
      logger.info(`[Export] Step 1: Video-only export (${segments.length} segments)`)
      {
        const { inputs, filterScript } = buildVideoFilterGraph(segments, { width, height, fps, letterbox, assFilePath })

        const filterFile = path.join(tmpDir, `ltx-filter-v-${ts}.txt`)
        fs.writeFileSync(filterFile, filterScript, 'utf8')

        const r = await runFfmpeg(ffmpegPath, [
          '-y', ...inputs, '-filter_complex_script', filterFile,
          '-map', '[outv]', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-pix_fmt', 'yuv420p', tmpVideo
        ], (timeSec) => {
          if (totalDurationForProgress > 0) {
            sendProgress((timeSec / totalDurationForProgress) * 70)
          }
        })
        try { fs.unlinkSync(filterFile) } catch {}
        if (!r.success) { cleanup(); return { success: false, error: r.error } }
      }

      // STEP 2: Audio mixdown (PCM buffer approach) — 70-85%
      sendProgress(70)
      logger.info('[Export] Step 2: Audio mixdown (PCM buffer approach)')
      let totalDuration = segments.reduce((max, s) => Math.max(max, s.startTime + s.duration), 0)
      for (const c of clips) {
        totalDuration = Math.max(totalDuration, c.startTime + c.duration)
      }

      const { pcmBuffer, sampleRate, channels: audioChannels } = await mixAudioToPcm(clips, totalDuration, ffmpegPath)

      const tmpRawPcm = path.join(tmpDir, `ltx-pcm-${ts}.raw`)
      fs.writeFileSync(tmpRawPcm, pcmBuffer)
      logger.info(`[Export] Wrote raw PCM: ${pcmBuffer.length} bytes (${totalDuration.toFixed(2)}s)`)

      {
        const r = await runFfmpeg(ffmpegPath, [
          '-y', '-f', 's16le', '-ar', String(sampleRate), '-ac', String(audioChannels),
          '-i', tmpRawPcm, '-c:a', 'pcm_s16le', tmpAudio,
        ], (timeSec) => {
          if (totalDurationForProgress > 0) {
            sendProgress(70 + (timeSec / totalDurationForProgress) * 15)
          }
        })
        try { fs.unlinkSync(tmpRawPcm) } catch {}
        if (!r.success) { cleanup(); return { success: false, error: r.error } }
      }

      // STEP 3: Combine video + audio (no re-encode of video) — 85-99%
      sendProgress(85)
      logger.info('[Export] Step 3: Combining video + audio')
      let videoCodecArgs: string[]
      let audioCodecArgs: string[]
      if (codec === 'h264') {
        videoCodecArgs = ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(quality || 18), '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
        audioCodecArgs = ['-c:a', 'aac', '-b:a', '192k']
      } else if (codec === 'prores') {
        videoCodecArgs = ['-c:v', 'prores_ks', '-profile:v', String(quality || 3), '-pix_fmt', 'yuva444p10le']
        audioCodecArgs = ['-c:a', 'pcm_s16le']
      } else if (codec === 'vp9') {
        videoCodecArgs = ['-c:v', 'libvpx-vp9', '-b:v', `${quality || 8}M`, '-pix_fmt', 'yuv420p']
        audioCodecArgs = ['-c:a', 'libopus', '-b:a', '128k']
      } else {
        cleanup()
        return { success: false, error: `Unknown codec: ${codec}` }
      }

      const canCopyVideo = codec === 'h264'
      const r = await runFfmpeg(ffmpegPath, [
        '-y', '-i', tmpVideo, '-i', tmpAudio,
        '-map', '0:v', '-map', '1:a',
        ...(canCopyVideo ? ['-c:v', 'copy'] : videoCodecArgs),
        ...audioCodecArgs, '-shortest', outputPath
      ], (timeSec) => {
        if (totalDurationForProgress > 0) {
          sendProgress(85 + (timeSec / totalDurationForProgress) * 14)
        }
      })

      cleanup()
      if (!r.success) return { success: false, error: r.error }
      sendProgress(100)
      logger.info(`[Export] Done: ${outputPath}`)
      return { success: true }
    } catch (err) {
      cleanup()
      return { success: false, error: String(err) }
    }
  })

  handle('exportCancel', () => {
    stopExportProcess()
    return { success: true }
  })
}
