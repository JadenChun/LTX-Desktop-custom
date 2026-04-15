import { DEFAULT_SUBTITLE_STYLE } from '../../types/project'
import type { SubtitleClip, SubtitleStyle } from '../../types/project'

function normalizeWordsPerChunk(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_SUBTITLE_STYLE.wordsPerChunk
  return Math.max(1, Math.round(value as number))
}

export function resolveSubtitleProgressiveSettings(
  subtitleStyle?: Partial<SubtitleStyle>,
  trackStyle?: Partial<SubtitleStyle>,
): { progressiveMode: boolean; wordsPerChunk: number } {
  return {
    progressiveMode: subtitleStyle?.progressiveMode ?? trackStyle?.progressiveMode ?? DEFAULT_SUBTITLE_STYLE.progressiveMode,
    wordsPerChunk: normalizeWordsPerChunk(subtitleStyle?.wordsPerChunk ?? trackStyle?.wordsPerChunk),
  }
}

export function createSubtitleEntriesWithProgressiveStyle(
  subtitle: SubtitleClip,
  trackStyle: Partial<SubtitleStyle> | undefined,
  makeId: (prefix: string) => string,
  forceProgressive = false,
): SubtitleClip[] {
  const resolved = resolveSubtitleProgressiveSettings(subtitle.style, trackStyle)
  if (!forceProgressive && !resolved.progressiveMode) {
    return [subtitle]
  }

  const subtitleWithProgressiveStyle: SubtitleClip = {
    ...subtitle,
    style: {
      ...(subtitle.style || {}),
      progressiveMode: true,
      wordsPerChunk: resolved.wordsPerChunk,
    },
  }

  return splitSubtitleIntoProgressiveChunks(subtitleWithProgressiveStyle, makeId, resolved.wordsPerChunk)
}

export function splitSubtitleIntoProgressiveChunks(
  subtitle: SubtitleClip,
  makeId: (prefix: string) => string,
  wordsPerChunk: number,
): SubtitleClip[] {
  const normalizedWordsPerChunk = normalizeWordsPerChunk(wordsPerChunk)
  const words = subtitle.text.trim().split(/\s+/).filter(Boolean)
  if (words.length <= normalizedWordsPerChunk) return [subtitle]

  const chunks: string[] = []
  for (let i = 0; i < words.length; i += normalizedWordsPerChunk) {
    chunks.push(words.slice(i, i + normalizedWordsPerChunk).join(' '))
  }

  const totalDuration = subtitle.endTime - subtitle.startTime
  const totalChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0) || 1

  const newSubs: SubtitleClip[] = []
  let cursor = subtitle.startTime

  for (let i = 0; i < chunks.length; i++) {
    const chunkDuration = totalDuration * (chunks[i].length / totalChars)
    const endTime = i === chunks.length - 1 ? subtitle.endTime : cursor + chunkDuration
    newSubs.push({
      id: makeId('sub'),
      text: chunks[i],
      startTime: parseFloat(cursor.toFixed(3)),
      endTime: parseFloat(endTime.toFixed(3)),
      trackIndex: subtitle.trackIndex,
      style: subtitle.style,
    })
    cursor = endTime
  }

  return newSubs
}
