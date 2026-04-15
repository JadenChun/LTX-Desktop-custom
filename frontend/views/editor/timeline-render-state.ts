import type { SubtitleClip, TimelineClip, Track } from '../../types/project'
import { getClipEffectStyles } from './video-editor-utils'

export type SyncTarget = 'active' | 'incoming' | 'compositing'
export type VideoContributorRole = 'primary' | 'dissolveIncoming' | 'compositing'

export interface ActiveLetterboxState {
  ratio: number
  color: string
  opacity: number
  key: string
}

export interface DissolvePair {
  outgoing: TimelineClip
  incoming: TimelineClip
}

export interface ActiveVideoContributor {
  clip: TimelineClip
  target: SyncTarget
  role: VideoContributorRole
  opacity: number
}

export interface TimelineFrameOverlayState {
  activeClip: TimelineClip | null
  crossDissolve: DissolvePair | null
  compositingStack: TimelineClip[]
  activeTextClips: TimelineClip[]
  activeSubtitles: SubtitleClip[]
  activeLetterbox: ActiveLetterboxState | null
  audioOnlyClips: TimelineClip[]
}

export interface TimelineFrameRenderState extends TimelineFrameOverlayState {
  atTime: number
  crossDissolveProgress: number
  activeVideoContributors: ActiveVideoContributor[]
}

export interface FrameRenderCache {
  mediaClips: TimelineClip[]
  videoClips: TimelineClip[]
  textClips: TimelineClip[]
  adjustmentClips: TimelineClip[]
  audioClips: TimelineClip[]
  subtitles: SubtitleClip[]
}

const LETTERBOX_RATIO_MAP: Record<string, number> = {
  '2.35:1': 2.35,
  '2.39:1': 2.39,
  '2.76:1': 2.76,
  '1.85:1': 1.85,
  '4:3': 4 / 3,
}

export function buildFrameRenderCache(clips: TimelineClip[], subtitles: SubtitleClip[]): FrameRenderCache {
  return {
    mediaClips: clips.filter(clip => clip.type !== 'audio' && clip.type !== 'adjustment' && clip.type !== 'text'),
    videoClips: clips.filter(clip => clip.asset?.type === 'video' && clip.type !== 'audio' && clip.type !== 'adjustment' && clip.type !== 'text'),
    textClips: clips.filter(clip => clip.type === 'text' && Boolean(clip.textStyle)),
    adjustmentClips: clips.filter(clip => clip.type === 'adjustment'),
    audioClips: clips.filter(clip => clip.type === 'audio'),
    subtitles,
  }
}

function getTopVisibleClipAtTime(mediaClips: TimelineClip[], tracks: Track[], time: number): TimelineClip | null {
  let best: { clip: TimelineClip; arrayIndex: number } | null = null

  for (let arrayIndex = 0; arrayIndex < mediaClips.length; arrayIndex += 1) {
    const clip = mediaClips[arrayIndex]
    if (tracks[clip.trackIndex]?.enabled === false) continue
    if (time < clip.startTime || time >= clip.startTime + clip.duration) continue
    if (!best) {
      best = { clip, arrayIndex }
      continue
    }
    if (clip.trackIndex > best.clip.trackIndex || (clip.trackIndex === best.clip.trackIndex && arrayIndex > best.arrayIndex)) {
      best = { clip, arrayIndex }
    }
  }

  return best?.clip ?? null
}

function getDissolveAtTime(mediaClips: TimelineClip[], tracks: Track[], time: number): { pair: DissolvePair; progress: number } | null {
  for (const clipA of mediaClips) {
    if (tracks[clipA.trackIndex]?.enabled === false) continue
    if (clipA.transitionOut?.type !== 'dissolve' || clipA.transitionOut.duration <= 0) continue
    const clipAEnd = clipA.startTime + clipA.duration
    const dissolveStart = clipAEnd - clipA.transitionOut.duration
    if (time < dissolveStart || time >= clipAEnd) continue
    const clipB = mediaClips.find(candidate =>
      candidate.id !== clipA.id &&
      tracks[candidate.trackIndex]?.enabled !== false &&
      candidate.trackIndex === clipA.trackIndex &&
      candidate.transitionIn?.type === 'dissolve' &&
      Math.abs(candidate.startTime - clipAEnd) < 0.05,
    )
    if (!clipB) continue
    const progress = Math.max(0, Math.min(1, (time - dissolveStart) / clipA.transitionOut.duration))
    return { pair: { outgoing: clipA, incoming: clipB }, progress }
  }
  return null
}

function getActiveTextClips(textClips: TimelineClip[], tracks: Track[], time: number): TimelineClip[] {
  return textClips
    .filter(clip =>
      tracks[clip.trackIndex]?.enabled !== false &&
      time >= clip.startTime &&
      time < clip.startTime + clip.duration,
    )
    .sort((a, b) => a.trackIndex - b.trackIndex)
}

function getActiveSubtitles(subtitles: SubtitleClip[], tracks: Track[], time: number): SubtitleClip[] {
  return subtitles.filter(subtitle => {
    const track = tracks[subtitle.trackIndex]
    return Boolean(track) && !track.muted && time >= subtitle.startTime && time < subtitle.endTime
  })
}

function getActiveLetterbox(adjustmentClips: TimelineClip[], tracks: Track[], time: number): ActiveLetterboxState | null {
  const activeAdjustments = adjustmentClips
    .filter(clip =>
      tracks[clip.trackIndex]?.enabled !== false &&
      time >= clip.startTime &&
      time < clip.startTime + clip.duration,
    )
    .sort((a, b) => b.trackIndex - a.trackIndex)

  for (const clip of activeAdjustments) {
    if (!clip.letterbox?.enabled) continue
    const ratio = clip.letterbox.aspectRatio === 'custom'
      ? (clip.letterbox.customRatio || 2.35)
      : (LETTERBOX_RATIO_MAP[clip.letterbox.aspectRatio] || 2.35)
    return {
      ratio,
      color: clip.letterbox.color || '#000000',
      opacity: (clip.letterbox.opacity ?? 100) / 100,
      key: `${clip.id}:${ratio}:${clip.letterbox.color || '#000000'}:${clip.letterbox.opacity ?? 100}`,
    }
  }

  return null
}

function getCompositingStack(mediaClips: TimelineClip[], tracks: Track[], activeClip: TimelineClip | null, time: number): TimelineClip[] {
  if (!activeClip || (activeClip.opacity ?? 100) >= 100) return []

  return mediaClips
    .filter(clip =>
      clip.id !== activeClip.id &&
      tracks[clip.trackIndex]?.enabled !== false &&
      clip.trackIndex < activeClip.trackIndex &&
      time >= clip.startTime &&
      time < clip.startTime + clip.duration,
    )
    .sort((a, b) => a.trackIndex - b.trackIndex)
}

function getStyleOpacity(style: { opacity?: number | string }): number {
  if (typeof style.opacity === 'number') return style.opacity
  if (typeof style.opacity === 'string') {
    const parsed = Number(style.opacity)
    return Number.isFinite(parsed) ? parsed : 1
  }
  return 1
}

function getActiveVideoContributors(
  activeClip: TimelineClip | null,
  crossDissolve: DissolvePair | null,
  crossDissolveProgress: number,
  compositingStack: TimelineClip[],
  time: number,
): ActiveVideoContributor[] {
  const contributors: ActiveVideoContributor[] = []
  const primaryClip = crossDissolve?.outgoing ?? activeClip

  if (primaryClip?.asset?.type === 'video') {
    const primaryOpacity = crossDissolve
      ? (1 - crossDissolveProgress) * ((crossDissolve.outgoing.opacity ?? 100) / 100)
      : getStyleOpacity(getClipEffectStyles(primaryClip, Math.max(0, time - primaryClip.startTime)))
    contributors.push({
      clip: primaryClip,
      target: 'active',
      role: 'primary',
      opacity: primaryOpacity,
    })
  }

  if (crossDissolve?.incoming.asset?.type === 'video') {
    contributors.push({
      clip: crossDissolve.incoming,
      target: 'incoming',
      role: 'dissolveIncoming',
      opacity: crossDissolveProgress * ((crossDissolve.incoming.opacity ?? 100) / 100),
    })
  }

  for (const clip of compositingStack) {
    if (clip.asset?.type !== 'video') continue
    contributors.push({
      clip,
      target: 'compositing',
      role: 'compositing',
      opacity: getStyleOpacity(getClipEffectStyles(clip, Math.max(0, time - clip.startTime))),
    })
  }

  return contributors
}

export function deriveFrameRenderState(cache: FrameRenderCache, tracks: Track[], time: number): TimelineFrameRenderState {
  const activeClip = getTopVisibleClipAtTime(cache.mediaClips, tracks, time)
  const dissolve = getDissolveAtTime(cache.mediaClips, tracks, time)
  const compositingStack = getCompositingStack(cache.mediaClips, tracks, activeClip, time)

  return {
    atTime: time,
    activeClip,
    crossDissolve: dissolve?.pair ?? null,
    crossDissolveProgress: dissolve?.progress ?? 0,
    compositingStack,
    activeTextClips: getActiveTextClips(cache.textClips, tracks, time),
    activeSubtitles: getActiveSubtitles(cache.subtitles, tracks, time),
    activeLetterbox: getActiveLetterbox(cache.adjustmentClips, tracks, time),
    audioOnlyClips: cache.audioClips.filter(clip => time >= clip.startTime && time < clip.startTime + clip.duration),
    activeVideoContributors: getActiveVideoContributors(activeClip, dissolve?.pair ?? null, dissolve?.progress ?? 0, compositingStack, time),
  }
}

function sameClipList(a: TimelineClip[], b: TimelineClip[]): boolean {
  if (a.length !== b.length) return false
  return a.every((clip, index) => clip === b[index])
}

function sameSubtitleList(a: SubtitleClip[], b: SubtitleClip[]): boolean {
  if (a.length !== b.length) return false
  return a.every((subtitle, index) => subtitle === b[index])
}

function sameLetterbox(a: ActiveLetterboxState | null, b: ActiveLetterboxState | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.key === b.key
}

function sameDissolve(a: DissolvePair | null, b: DissolvePair | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.outgoing === b.outgoing && a.incoming === b.incoming
}

export function sameFrameOverlayState(a: TimelineFrameOverlayState, b: TimelineFrameOverlayState): boolean {
  return (
    a.activeClip === b.activeClip &&
    sameDissolve(a.crossDissolve, b.crossDissolve) &&
    sameClipList(a.compositingStack, b.compositingStack) &&
    sameClipList(a.activeTextClips, b.activeTextClips) &&
    sameSubtitleList(a.activeSubtitles, b.activeSubtitles) &&
    sameLetterbox(a.activeLetterbox, b.activeLetterbox) &&
    sameClipList(a.audioOnlyClips, b.audioOnlyClips)
  )
}

function sameVideoContributors(a: ActiveVideoContributor[], b: ActiveVideoContributor[]): boolean {
  if (a.length !== b.length) return false
  return a.every((contributor, index) => {
    const candidate = b[index]
    return (
      contributor.clip === candidate.clip &&
      contributor.target === candidate.target &&
      contributor.role === candidate.role &&
      contributor.opacity === candidate.opacity
    )
  })
}

export function sameFrameRenderState(a: TimelineFrameRenderState, b: TimelineFrameRenderState): boolean {
  return (
    a.atTime === b.atTime &&
    a.crossDissolveProgress === b.crossDissolveProgress &&
    sameFrameOverlayState(a, b) &&
    sameVideoContributors(a.activeVideoContributors, b.activeVideoContributors)
  )
}
