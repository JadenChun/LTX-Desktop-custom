import type { FlatSegment, KenBurnsMotion } from './timeline'

/**
 * Convert a CSS color string to { hex: '0xRRGGBB', alpha: '0.60' }
 * Handles: #RGB, #RRGGBB, #RRGGBBAA, rgb(...), rgba(...).
 * Falls back to opaque black on unknown formats.
 */
function parseCssColorToFfmpeg(css: string): { hex: string; alpha: string } {
  const s = css.trim()
  if (!s || s.toLowerCase() === 'transparent') {
    return { hex: '0x000000', alpha: '0.00' }
  }

  // rgba(r, g, b, a)
  const rgbaMatch = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/)
  if (rgbaMatch) {
    const r = Math.round(Number(rgbaMatch[1])).toString(16).padStart(2, '0')
    const g = Math.round(Number(rgbaMatch[2])).toString(16).padStart(2, '0')
    const b = Math.round(Number(rgbaMatch[3])).toString(16).padStart(2, '0')
    const a = rgbaMatch[4] !== undefined ? Number(rgbaMatch[4]).toFixed(2) : '1.00'
    return { hex: `0x${r}${g}${b}`, alpha: a }
  }

  // Strip leading #
  const raw = s.replace(/^#/, '')

  if (raw.length === 3) {
    // #RGB → #RRGGBB
    const r = raw[0] + raw[0]
    const g = raw[1] + raw[1]
    const b = raw[2] + raw[2]
    return { hex: `0x${r}${g}${b}`, alpha: '1.00' }
  }
  if (raw.length === 6) {
    return { hex: `0x${raw}`, alpha: '1.00' }
  }
  if (raw.length === 8) {
    // #RRGGBBAA
    const alpha = (parseInt(raw.slice(6), 16) / 255).toFixed(2)
    return { hex: `0x${raw.slice(0, 6)}`, alpha }
  }

  // Fallback: semi-opaque black
  return { hex: '0x000000', alpha: '0.60' }
}

/**
 * Convert a CSS color to ASS color format: &HAABBGGRR
 * AA: alpha (00=opaque, FF=transparent — inverted from CSS)
 */
function cssColorToAss(css: string, opacityMultiplier = 1): string {
  const { hex, alpha } = parseCssColorToFfmpeg(css)
  const rrggbb = hex.replace('0x', '')
  const rr = rrggbb.slice(0, 2)
  const gg = rrggbb.slice(2, 4)
  const bb = rrggbb.slice(4, 6)
  const clampedOpacity = Math.max(0, Math.min(1, parseFloat(alpha) * opacityMultiplier))
  const assAlpha = Math.round((1 - clampedOpacity) * 255).toString(16).padStart(2, '0').toUpperCase()
  return `&H${assAlpha}${bb}${gg}${rr}`
}

function pickPrimaryFontFamily(fontFamily: string | undefined): string {
  const first = (fontFamily || 'Arial').split(',')[0].trim().replace(/^['"]|['"]$/g, '')
  return first || 'Arial'
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\N')
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
  for (let i = 0; i < text.length; i++) {
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

function wrapTextForSafeArea(
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

/** Format seconds to ASS timestamp: H:MM:SS.CC */
function formatAssTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const cs = Math.round((seconds % 1) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}


/**
 * Build the Ken Burns (zoom+pan) filter chain for a single segment.
 *
 * Instead of relying on the crop filter's `iw`/`ih` variables (which are set
 * once during filter init and become stale when the preceding scale filter
 * produces variable-size frames with eval=frame), we compute the scaled
 * dimensions explicitly using the zoom expression. This ensures the crop
 * position is correct at every frame, matching the CSS preview.
 */
function buildKenBurnsChain(motion: KenBurnsMotion, segDuration: number, w: number, h: number): string {
  const startScale = Math.max(1, motion.start.scale)
  const endScale = Math.max(1, motion.end.scale)
  const startFx = Math.max(0, Math.min(100, motion.start.focusX))
  const endFx = Math.max(0, Math.min(100, motion.end.focusX))
  const startFy = Math.max(0, Math.min(100, motion.start.focusY))
  const endFy = Math.max(0, Math.min(100, motion.end.focusY))

  const durExpr = Math.max(0.001, segDuration).toFixed(6)
  const tExpr = `min(1,max(0,t/${durExpr}))`
  const easedT = motion.easing === 'easeInOut' ? `(${tExpr})*(${tExpr})*(3-2*(${tExpr}))` : tExpr

  const zExpr = `${startScale.toFixed(6)}+(${(endScale - startScale).toFixed(6)})*(${easedT})`
  const fxExpr = `${startFx.toFixed(6)}+(${(endFx - startFx).toFixed(6)})*(${easedT})`
  const fyExpr = `${startFy.toFixed(6)}+(${(endFy - startFy).toFixed(6)})*(${easedT})`

  // Compute the actual scaled dimensions explicitly (not relying on iw/ih)
  // After pad, input is always w×h. After scale by zoom: scaledW = w*zoom, scaledH = h*zoom.
  const scaledW = `${w}*(${zExpr})`
  const scaledH = `${h}*(${zExpr})`

  const cropX = `max(0,min((${scaledW})-${w},(${scaledW})*(${fxExpr})/100-${w}/2))`
  const cropY = `max(0,min((${scaledH})-${h},(${scaledH})*(${fyExpr})/100-${h}/2))`

  let chain = `,scale=w='ceil(iw*(${zExpr}))':h='ceil(ih*(${zExpr}))':eval=frame`
  chain += `,crop=${w}:${h}:x='${cropX}':y='${cropY}'`
  return chain
}


export interface ExportSubtitle {
  text: string; startTime: number; endTime: number;
  style: { fontSize: number; fontFamily: string; fontWeight: string; color: string; backgroundColor: string; position: string; italic: boolean; highlightEnabled?: boolean; highlightColor?: string };
}

export interface ExportTextOverlay {
  text: string
  startTime: number
  endTime: number
  trackIndex: number
  style: {
    fontFamily: string
    fontSize: number
    fontWeight: string
    fontStyle: string
    color: string
    backgroundColor: string
    textAlign: string
    positionX: number
    positionY: number
    strokeColor: string
    strokeWidth: number
    shadowColor: string
    shadowBlur: number
    shadowOffsetX: number
    shadowOffsetY: number
    letterSpacing: number
    lineHeight: number
    maxWidth: number
    padding: number
    borderRadius: number
    opacity: number
  }
}

/**
 * Generate ASS subtitle file content. ASS handles text wrapping natively via
 * margins and WrapStyle, matching the CSS preview's max-w-[90%] behaviour.
 */
export function generateAssContent(
  subtitles: ExportSubtitle[],
  textOverlays: ExportTextOverlay[],
  width: number,
  height: number,
): string {
  const marginLR = Math.round(width * 0.05) // 5% each side → 90% usable width (matches preview max-w-[90%])
  const marginV_bottom = Math.round(height * 0.08)
  const marginV_top = Math.round(height * 0.05)
  const frameScale = Math.min(width, height) / 1080

  const lines: string[] = []

  lines.push('[Script Info]')
  lines.push('ScriptType: v4.00+')
  lines.push(`PlayResX: ${width}`)
  lines.push(`PlayResY: ${height}`)
  lines.push('WrapStyle: 0')
  lines.push('')

  lines.push('[V4+ Styles]')
  lines.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding')

  for (let i = 0; i < subtitles.length; i++) {
    const sub = subtitles[i]
    const s = sub.style

    const fontName = pickPrimaryFontFamily(s.fontFamily)
    // Fixed font size based on orientation: 8% for vertical, 5% for horizontal
    const isVertical = height > width
    const fontSize = Math.round(Math.min(width, height) * (isVertical ? 0.08 : 0.05))
    const primaryColor = cssColorToAss(s.color)
    const bold = s.fontWeight === 'bold' ? -1 : 0
    const italic = s.italic ? -1 : 0

    // Position → ASS alignment (numpad layout: 1-3=bottom, 4-6=middle, 7-9=top)
    let alignment: number
    let marginV: number
    if (s.position === 'top') {
      alignment = 8 // top-center
      marginV = marginV_top
    } else if (s.position === 'center') {
      alignment = 5 // middle-center
      marginV = 0
    } else {
      alignment = 2 // bottom-center
      marginV = marginV_bottom
    }

    // Background style
    let borderStyle: number
    let backColor: string
    let outline: number
    const shadowDist = Math.max(1, Math.round(2 * (height / 1080)))

    if (s.backgroundColor && s.backgroundColor !== 'transparent') {
      borderStyle = 3 // opaque box background
      backColor = cssColorToAss(s.backgroundColor)
      outline = Math.max(4, Math.round(height / 120)) // box padding
    } else {
      borderStyle = 1 // outline + shadow
      backColor = '&H80000000'
      outline = Math.max(1, Math.round(2 * (height / 1080)))
    }

    // For highlight-enabled subtitles, SecondaryColour is the dimmed (pre-highlight) color used by \kf karaoke fill
    const secondaryColor = s.highlightEnabled ? cssColorToAss(s.color, 0.4) : '&H000000FF'

    lines.push(`Style: Sub${i},${fontName},${fontSize},${primaryColor},${secondaryColor},&H00000000,${backColor},${bold},${italic},${borderStyle},${outline},${shadowDist},${alignment},${marginLR},${marginLR},${marginV},1`)
  }

  for (let i = 0; i < textOverlays.length; i++) {
    const textOverlay = textOverlays[i]
    const style = textOverlay.style
    const opacity = Math.max(0, Math.min(1, (style.opacity ?? 100) / 100))
    const fontName = pickPrimaryFontFamily(style.fontFamily)
    const fontSize = Math.max(1, Math.round((style.fontSize || 64) * frameScale))
    const bold = (() => {
      const fw = style.fontWeight || 'normal'
      if (fw === 'bold') return -1
      const numeric = Number(fw)
      return Number.isFinite(numeric) && numeric >= 600 ? -1 : 0
    })()
    const italic = (style.fontStyle || 'normal') === 'italic' ? -1 : 0
    const primaryColor = cssColorToAss(style.color || '#FFFFFF', opacity)
    const hasStroke = (style.strokeWidth || 0) > 0 && style.strokeColor && style.strokeColor !== 'transparent'
    const outlineColor = hasStroke ? cssColorToAss(style.strokeColor, opacity) : '&H00000000'
    const outline = hasStroke ? Math.max(0, (style.strokeWidth || 0) * frameScale) : 0
    const hasShadowColor = style.shadowColor && style.shadowColor !== 'transparent'
    const shadowColor = hasShadowColor ? cssColorToAss(style.shadowColor, opacity) : '&H00000000'
    const shadowOffsetX = (style.shadowOffsetX || 0) * frameScale
    const shadowOffsetY = (style.shadowOffsetY || 0) * frameScale
    const shadowDist = hasShadowColor
      ? Math.max(0, Math.round(Math.sqrt(shadowOffsetX * shadowOffsetX + shadowOffsetY * shadowOffsetY)))
      : 0
    const hasBackground = style.backgroundColor && style.backgroundColor !== 'transparent'
    const backColor = hasBackground ? cssColorToAss(style.backgroundColor, opacity) : shadowColor
    const borderStyle = hasBackground ? 3 : 1
    const boxPadding = hasBackground ? Math.max(0, Math.round((style.padding || 0) * frameScale)) : 0

    lines.push(`Style: Txt${i},${fontName},${fontSize},${primaryColor},&H000000FF,${outlineColor},${backColor},${bold},${italic},${borderStyle},${Math.max(outline, boxPadding)},${shadowDist},5,0,0,0,1`)
  }

  lines.push('')
  lines.push('[Events]')
  lines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text')

  for (let i = 0; i < subtitles.length; i++) {
    const sub = subtitles[i]
    const start = formatAssTime(sub.startTime)
    const end = formatAssTime(sub.endTime)

    if (sub.style.highlightEnabled) {
      // Karaoke-style progressive word highlight using \kf tags
      const highlightColorAss = cssColorToAss(sub.style.highlightColor || '#FFDD00')
      const words = sub.text.trim().split(/\s+/).filter(Boolean)
      const totalChars = words.reduce((sum, w) => sum + w.length, 0)
      const totalCs = Math.round((sub.endTime - sub.startTime) * 100)

      let karaokeText = `{\\1c${highlightColorAss}}`
      for (let w = 0; w < words.length; w++) {
        const wordCs = w === words.length - 1
          ? totalCs - words.slice(0, w).reduce((sum, wd) => sum + Math.round(totalCs * (wd.length / totalChars)), 0)
          : Math.round(totalCs * (words[w].length / totalChars))
        const escapedWord = escapeAssText(words[w])
        karaokeText += `{\\kf${wordCs}}${escapedWord}${w < words.length - 1 ? ' ' : ''}`
      }

      lines.push(`Dialogue: 20,${start},${end},Sub${i},,0,0,0,,${karaokeText}`)
    } else {
      const text = escapeAssText(sub.text)
      lines.push(`Dialogue: 20,${start},${end},Sub${i},,0,0,0,,${text}`)
    }
  }

  for (let i = 0; i < textOverlays.length; i++) {
    const textOverlay = textOverlays[i]
    const start = formatAssTime(textOverlay.startTime)
    const end = formatAssTime(textOverlay.endTime)
    const safeLeft = Math.round(width * 0.15)
    const safeRight = Math.round(width * 0.85)
    const unclampedX = Math.round((Math.max(0, Math.min(100, textOverlay.style.positionX ?? 50)) / 100) * width)
    const safeWidthPx = Math.max(1, safeRight - safeLeft)
    const maxWidthRatio = textOverlay.style.maxWidth > 0
      ? Math.max(0.01, Math.min(1, textOverlay.style.maxWidth / 100))
      : 1
    const effectiveWrapWidthPx = Math.max(1, Math.min(safeWidthPx, width * maxWidthRatio))
    const halfWrap = effectiveWrapWidthPx / 2
    const minX = safeLeft + halfWrap
    const maxX = safeRight - halfWrap
    const x = minX <= maxX
      ? Math.max(minX, Math.min(maxX, unclampedX))
      : Math.round((safeLeft + safeRight) / 2)
    const y = Math.round((Math.max(0, Math.min(100, textOverlay.style.positionY ?? 50)) / 100) * height)
    const layer = 10 + Math.max(0, textOverlay.trackIndex)
    const letterSpacing = (textOverlay.style.letterSpacing || 0) * frameScale
    const spacingTag = Math.abs(letterSpacing) > 0.001 ? `\\fsp${letterSpacing.toFixed(2)}` : ''
    const textPx = Math.max(1, Math.round((textOverlay.style.fontSize || 64) * frameScale))
    const wrappedText = wrapTextForSafeArea(
      textOverlay.text,
      effectiveWrapWidthPx,
      textPx,
      Math.max(0, letterSpacing),
    )
    const text = escapeAssText(wrappedText)
    lines.push(`Dialogue: ${layer},${start},${end},Txt${i},,0,0,0,,{\\pos(${x},${y})${spacingTag}}${text}`)
  }

  return lines.join('\n')
}


/**
 * Build the ffmpeg filter_complex script and input arguments for the video-only pass.
 * Pure string building — zero I/O.
 */
export function buildVideoFilterGraph(
  segments: FlatSegment[],
  opts: {
    width: number; height: number; fps: number;
    letterbox?: { ratio: number; color: string; opacity: number };
    assFilePath?: string;
  },
): { inputs: string[]; filterScript: string } {
  const { width, height, fps, letterbox } = opts
  const inputs: string[] = []
  const filterParts: string[] = []
  let idx = 0

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]

    if (seg.type === 'gap') {
      // Gap: generate black frames at target fps (synthetic input)
      inputs.push('-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${seg.duration.toFixed(6)}`)
      filterParts.push(`[${idx}:v]setsar=1[v${i}]`)
      idx++
    } else if (seg.type === 'image') {
      // Image: loop for exact duration, use target fps for frame generation
      inputs.push('-loop', '1', '-framerate', String(fps), '-t', seg.duration.toFixed(6), '-i', seg.filePath)
      let chain = `[${idx}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:-1:-1:color=black`

      if (seg.motion?.type === 'ken_burns') {
        chain += buildKenBurnsChain(seg.motion, seg.duration, width, height)
      }

      if (seg.flipH) chain += ',hflip'
      if (seg.flipV) chain += ',vflip'

      // Opacity & Color Correction via 'eq' filter
      const opacity = (seg.opacity ?? 100) / 100
      const cc = seg.colorCorrection
      if (opacity < 1 || (cc && (cc.brightness !== 0 || cc.contrast !== 0 || cc.saturation !== 0))) {
        const brightness = (cc?.brightness ?? 0) / 100 + (opacity - 1) * 0.5
        const contrast = (1 + (cc?.contrast ?? 0) / 100) * opacity
        const saturation = 1 + (cc?.saturation ?? 0) / 100
        chain += `,eq=brightness=${brightness.toFixed(4)}:contrast=${contrast.toFixed(4)}:saturation=${saturation.toFixed(4)}`
      }

      chain += ',setsar=1'
      chain += `[v${i}]`
      filterParts.push(chain)
      idx++
    } else {
      // Video: trim -> speed -> scale, NO per-segment fps conversion
      // (fps is applied ONCE after concat to avoid per-segment duration quantization)
      const trimEnd = seg.trimStart + seg.duration * seg.speed
      inputs.push('-i', seg.filePath)
      let chain = `[${idx}:v]trim=start=${seg.trimStart.toFixed(6)}:end=${trimEnd.toFixed(6)},setpts=PTS-STARTPTS`
      if (seg.speed !== 1) chain += `,setpts=PTS/${seg.speed.toFixed(6)}`
      if (seg.reversed) chain += ',reverse'
      chain += `,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:-1:-1:color=black`

      if (seg.motion?.type === 'ken_burns') {
        chain += buildKenBurnsChain(seg.motion, seg.duration, width, height)
      }

      if (seg.flipH) chain += ',hflip'
      if (seg.flipV) chain += ',vflip'

      // Opacity & Color Correction via 'eq' filter
      const opacity = (seg.opacity ?? 100) / 100
      const cc = seg.colorCorrection
      if (opacity < 1 || (cc && (cc.brightness !== 0 || cc.contrast !== 0 || cc.saturation !== 0))) {
        const brightness = (cc?.brightness ?? 0) / 100 + (opacity - 1) * 0.5
        const contrast = (1 + (cc?.contrast ?? 0) / 100) * opacity
        const saturation = 1 + (cc?.saturation ?? 0) / 100
        chain += `,eq=brightness=${brightness.toFixed(4)}:contrast=${contrast.toFixed(4)}:saturation=${saturation.toFixed(4)}`
      }

      chain += ',setsar=1'
      chain += `[v${i}]`
      filterParts.push(chain)
      idx++
    }
  }

  const concatInputs = segments.map((_, i) => `[v${i}]`).join('')

  // Concat all segments, then apply fps ONCE to the entire output.
  // This is how real NLEs work: frame rate conversion happens globally,
  // not per-clip, so per-segment duration quantization doesn't accumulate.
  let lastLabel = 'fpsout'
  filterParts.push(`${concatInputs}concat=n=${segments.length}:v=1:a=0[concatraw]`)
  filterParts.push(`[concatraw]fps=${fps}[${lastLabel}]`)

  // Letterbox overlay (drawbox)
  if (letterbox) {
    const containerRatio = width / height
    const targetRatio = letterbox.ratio
    const hexColor = letterbox.color.replace('#', '')
    const alphaHex = Math.round(letterbox.opacity * 255).toString(16).padStart(2, '0')
    const colorStr = `0x${hexColor}${alphaHex}`
    const nextLabel = 'lbout'

    if (targetRatio >= containerRatio) {
      // Letterbox: bars on top and bottom
      const visibleH = Math.round(width / targetRatio)
      const barH = Math.round((height - visibleH) / 2)
      if (barH > 0) {
        filterParts.push(`[${lastLabel}]drawbox=x=0:y=0:w=iw:h=${barH}:c=${colorStr}:t=fill,drawbox=x=0:y=ih-${barH}:w=iw:h=${barH}:c=${colorStr}:t=fill[${nextLabel}]`)
        lastLabel = nextLabel
      }
    } else {
      // Pillarbox: bars on left and right
      const visibleW = Math.round(height * targetRatio)
      const barW = Math.round((width - visibleW) / 2)
      if (barW > 0) {
        filterParts.push(`[${lastLabel}]drawbox=x=0:y=0:w=${barW}:h=ih:c=${colorStr}:t=fill,drawbox=x=iw-${barW}:y=0:w=${barW}:h=ih:c=${colorStr}:t=fill[${nextLabel}]`)
        lastLabel = nextLabel
      }
    }
  }

  // Subtitle burn-in via ASS file (libass handles text wrapping natively)
  if (opts.assFilePath) {
    const nextLabel = 'subout'
    // Escape path for FFmpeg filter syntax: forward slashes, escape colons and backslashes
    const escapedPath = opts.assFilePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''")
    filterParts.push(`[${lastLabel}]ass=filename='${escapedPath}'[${nextLabel}]`)
    lastLabel = nextLabel
  }

  // Rename final label to outv
  if (lastLabel !== 'outv') {
    filterParts.push(`[${lastLabel}]null[outv]`)
  }

  return { inputs, filterScript: filterParts.join(';\n') }
}
