import type { Asset, TimelineClip } from '../../types/project'

export function pickPrimaryFontFamily(fontFamily: string): string {
  const first = fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '')
  return first || 'Arial'
}

function estimateCharWidthPx(ch: string, fontSizePx: number): number {
  if (ch === ' ') return fontSizePx * 0.33
  if (/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(ch)) return fontSizePx * 1.0
  if (/[A-Z]/.test(ch)) return fontSizePx * 0.62
  if (/[a-z0-9]/.test(ch)) return fontSizePx * 0.54
  if (/[.,;:!?'"`]/.test(ch)) return fontSizePx * 0.30
  return fontSizePx * 0.55
}

function estimateTextWidthPx(text: string, fontSizePx: number, letterSpacingPx: number): number {
  if (!text) return 0
  let width = 0
  for (let i = 0; i < text.length; i += 1) {
    width += estimateCharWidthPx(text[i], fontSizePx)
  }
  width += Math.max(0, text.length - 1) * Math.max(0, letterSpacingPx)
  return width
}

function wrapWordToWidth(word: string, maxWidthPx: number, fontSizePx: number, letterSpacingPx: number): string[] {
  const chunks: string[] = []
  let current = ''
  for (const ch of word) {
    const candidate = current + ch
    if (current && estimateTextWidthPx(candidate, fontSizePx, letterSpacingPx) > maxWidthPx) {
      chunks.push(current)
      current = ch
    } else {
      current = candidate
    }
  }
  if (current) chunks.push(current)
  return chunks
}

export function wrapTextForSafeArea(
  text: string,
  maxWidthPx: number,
  fontSizePx: number,
  letterSpacingPx: number,
): string {
  const paragraphs = text.split(/\r?\n/)
  const wrappedParagraphs = paragraphs.map(paragraph => {
    const words = paragraph.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) return ''

    const lines: string[] = []
    let line = ''
    for (const rawWord of words) {
      const candidate = line ? `${line} ${rawWord}` : rawWord
      if (estimateTextWidthPx(candidate, fontSizePx, letterSpacingPx) <= maxWidthPx) {
        line = candidate
        continue
      }
      if (line) {
        lines.push(line)
        line = ''
      }
      if (estimateTextWidthPx(rawWord, fontSizePx, letterSpacingPx) <= maxWidthPx) {
        line = rawWord
      } else {
        const chunks = wrapWordToWidth(rawWord, maxWidthPx, fontSizePx, letterSpacingPx)
        lines.push(...chunks.slice(0, -1))
        line = chunks[chunks.length - 1] || ''
      }
    }
    if (line) lines.push(line)
    return lines.join('\n')
  })
  return wrappedParagraphs.join('\n')
}

export function resolveClipPathFromAssets(assets: Asset[], clip: TimelineClip): string {
  const liveAsset = clip.assetId
    ? assets.find(asset => asset.id === clip.assetId) || clip.asset
    : clip.asset
  if (!liveAsset) return ''
  if (liveAsset.takes && liveAsset.takes.length > 0 && clip.takeIndex !== undefined) {
    const idx = Math.max(0, Math.min(clip.takeIndex, liveAsset.takes.length - 1))
    return liveAsset.takes[idx].path || ''
  }
  return liveAsset.path || ''
}

export function getClipTargetTime(clip: TimelineClip, mediaDuration: number, atTime: number): number {
  const timeInClip = atTime - clip.startTime
  const usableMediaDuration = mediaDuration - clip.trimStart - clip.trimEnd
  return clip.reversed
    ? Math.max(0, Math.min(mediaDuration, clip.trimStart + usableMediaDuration - timeInClip * clip.speed))
    : Math.max(0, Math.min(mediaDuration, clip.trimStart + timeInClip * clip.speed))
}
