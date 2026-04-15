import React from 'react'
import { pathToFileUrl } from '../lib/file-url'
import { DEFAULT_SUBTITLE_STYLE, type Asset, type Project as ProjectState, type SubtitleClip, type Timeline, type TimelineClip } from '../types/project'
import { getClipEffectStyles, getClipMotionStyles, getTransitionBgColor } from './editor/video-editor-utils'
import { buildFrameRenderCache, deriveFrameRenderState } from './editor/timeline-render-state'
import { getClipTargetTime, pickPrimaryFontFamily, resolveClipPathFromAssets, wrapTextForSafeArea } from './editor/preview-render-utils'
import type { PreviewFrameRequest } from '../../shared/agent-preview-schema'

declare global {
  interface Window {
    __LTX_AGENT_PREVIEW_BRIDGE?: {
      renderFrame: (request: PreviewFrameRequest) => Promise<{ requestId: string }>
    }
  }
}

interface PendingPreviewRequest extends PreviewFrameRequest {
  requestId: string
}

interface PreviewSceneState {
  project: ProjectState
  timeline: Timeline
  renderState: ReturnType<typeof deriveFrameRenderState>
  frameSize: { width: number; height: number }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise(resolve => window.requestAnimationFrame(() => resolve()))
}

function resolveActiveTimeline(project: ProjectState): Timeline | null {
  if (!project.timelines || project.timelines.length === 0) return null
  return project.timelines.find(timeline => timeline.id === project.activeTimelineId) ?? project.timelines[0]
}

function hydrateTimeline(timeline: Timeline, assets: Asset[]): Timeline {
  const assetMap = new Map(assets.map(asset => [asset.id, asset]))
  return {
    ...timeline,
    clips: timeline.clips.map(clip => {
      if (clip.asset || !clip.assetId) return clip
      const asset = assetMap.get(clip.assetId)
      return asset ? { ...clip, asset } : clip
    }),
  }
}

function styleValue(value: string | number | undefined): string | number | undefined {
  if (value === undefined) return undefined
  return value
}

function buildClipLayerStyle(
  clip: TimelineClip,
  atTime: number,
  frameSize: { width: number; height: number },
  opacityOverride?: number,
): React.CSSProperties {
  const timeInClip = Math.max(0, atTime - clip.startTime)
  const effectStyle = getClipEffectStyles(clip, timeInClip)
  const motionStyle = getClipMotionStyles(clip, timeInClip, frameSize)
  const baseTransform = typeof effectStyle.transform === 'string' ? effectStyle.transform : ''
  const motionTransform = typeof motionStyle.transform === 'string' ? motionStyle.transform : ''

  return {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    pointerEvents: 'none',
    filter: typeof effectStyle.filter === 'string' ? effectStyle.filter : undefined,
    clipPath: typeof effectStyle.clipPath === 'string' ? effectStyle.clipPath : undefined,
    opacity: opacityOverride ?? (typeof effectStyle.opacity === 'number' ? effectStyle.opacity : 1),
    transform: [baseTransform, motionTransform].filter(Boolean).join(' ') || undefined,
    transformOrigin: typeof motionStyle.transformOrigin === 'string' ? motionStyle.transformOrigin : undefined,
  }
}

function PreviewVideoLayer({
  clip,
  sourcePath,
  atTime,
  requestToken,
  style,
}: {
  clip: TimelineClip
  sourcePath: string
  atTime: number
  requestToken: string
  style: React.CSSProperties
}) {
  const ref = React.useRef<HTMLVideoElement | null>(null)

  React.useEffect(() => {
    const video = ref.current
    if (!video) return

    let cancelled = false
    const sourceUrl = pathToFileUrl(sourcePath)
    video.dataset.ready = 'false'
    video.pause()

    const markReady = () => {
      if (cancelled) return
      video.pause()
      video.dataset.ready = 'true'
    }

    const syncVideo = () => {
      if (cancelled) return
      const mediaDuration = Number.isFinite(video.duration) ? video.duration : 0
      if (mediaDuration <= 0) {
        markReady()
        return
      }
      const targetTime = getClipTargetTime(clip, mediaDuration, atTime)
      if (Math.abs(video.currentTime - targetTime) <= 0.03) {
        markReady()
        return
      }
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked)
        markReady()
      }
      video.addEventListener('seeked', onSeeked)
      try {
        video.currentTime = targetTime
      } catch {
        video.removeEventListener('seeked', onSeeked)
        markReady()
      }
    }

    const onLoadedMetadata = () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      syncVideo()
    }

    if (video.dataset.sourceUrl !== sourceUrl) {
      video.dataset.sourceUrl = sourceUrl
      video.src = sourceUrl
      video.load()
    }

    if (video.readyState >= 1) {
      syncVideo()
    } else {
      video.addEventListener('loadedmetadata', onLoadedMetadata)
    }

    return () => {
      cancelled = true
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
    }
  }, [atTime, clip, requestToken, sourcePath])

  return (
    <video
      ref={ref}
      data-preview-media="true"
      data-ready="false"
      muted
      playsInline
      preload="auto"
      style={style}
    />
  )
}

function PreviewImageLayer({
  sourcePath,
  requestToken,
  style,
}: {
  sourcePath: string
  requestToken: string
  style: React.CSSProperties
}) {
  const ref = React.useRef<HTMLImageElement | null>(null)

  React.useEffect(() => {
    const image = ref.current
    if (!image) return

    let cancelled = false
    image.dataset.ready = 'false'
    const sourceUrl = pathToFileUrl(sourcePath)

    const markReady = () => {
      if (!cancelled) {
        image.dataset.ready = 'true'
      }
    }

    if (image.dataset.sourceUrl !== sourceUrl) {
      image.dataset.sourceUrl = sourceUrl
      image.src = sourceUrl
    }

    if (image.complete) {
      markReady()
      return () => {
        cancelled = true
      }
    }

    const onLoad = () => {
      image.removeEventListener('load', onLoad)
      markReady()
    }
    image.addEventListener('load', onLoad)
    return () => {
      cancelled = true
      image.removeEventListener('load', onLoad)
    }
  }, [requestToken, sourcePath])

  return (
    <img
      ref={ref}
      data-preview-media="true"
      data-ready="false"
      alt=""
      style={style}
    />
  )
}

function PreviewClipLayer({
  clip,
  assets,
  atTime,
  frameSize,
  requestToken,
  opacityOverride,
  zIndex,
}: {
  clip: TimelineClip
  assets: Asset[]
  atTime: number
  frameSize: { width: number; height: number }
  requestToken: string
  opacityOverride?: number
  zIndex: number
}) {
  const sourcePath = resolveClipPathFromAssets(assets, clip)
  if (!sourcePath) return null

  const style = {
    ...buildClipLayerStyle(clip, atTime, frameSize, opacityOverride),
    zIndex,
  } satisfies React.CSSProperties

  if (clip.asset?.type === 'video') {
    return (
      <PreviewVideoLayer
        clip={clip}
        sourcePath={sourcePath}
        atTime={atTime}
        requestToken={requestToken}
        style={style}
      />
    )
  }

  return <PreviewImageLayer sourcePath={sourcePath} requestToken={requestToken} style={style} />
}

function renderSubtitleText(subtitle: SubtitleClip, currentTime: number, frameSize: { width: number; height: number }, timeline: Timeline) {
  const track = timeline.tracks[subtitle.trackIndex]
  const style = { ...DEFAULT_SUBTITLE_STYLE, ...(track?.subtitleStyle || {}), ...subtitle.style }
  const fontSize = Math.round(Math.min(frameSize.width, frameSize.height) * (frameSize.height > frameSize.width ? 0.08 : 0.05))

  const content = style.highlightEnabled
    ? (() => {
        const segments = subtitle.text.split(/(\s+)/)
        const nonSpaceWords = segments.filter(word => word.trim())
        const totalChars = nonSpaceWords.reduce((sum, word) => sum + word.length, 0)
        const progress = totalChars > 0
          ? Math.max(0, Math.min(1, (currentTime - subtitle.startTime) / Math.max(0.001, subtitle.endTime - subtitle.startTime)))
          : 0
        const highlightedChars = progress * totalChars
        let charsSoFar = 0
        return segments.map((segment, index) => {
          if (!segment.trim()) return <React.Fragment key={index}>{segment}</React.Fragment>
          const wordStart = charsSoFar
          charsSoFar += segment.length
          const isHighlighted = wordStart < highlightedChars
          return (
            <span
              key={index}
              style={{
                color: isHighlighted ? (style.highlightColor || '#FFDD00') : style.color,
                opacity: isHighlighted ? 1 : 0.4,
              }}
            >
              {segment}
            </span>
          )
        })
      })()
    : subtitle.text

  const containerClass = style.position === 'top'
    ? 'self-start'
    : style.position === 'center'
      ? 'self-center absolute inset-0 flex items-center justify-center'
      : 'self-end'

  return (
    <div
      key={subtitle.id}
      className={`w-full flex ${containerClass}`}
      style={style.position !== 'center' ? { padding: style.position === 'top' ? '12px 16px 0' : '0 16px 12px' } : undefined}
    >
      <span
        className="inline-block max-w-[90%] text-center mx-auto rounded px-3 py-1.5 leading-snug whitespace-pre-wrap"
        style={{
          fontSize: `${fontSize}px`,
          fontFamily: style.fontFamily,
          fontWeight: style.fontWeight,
          fontStyle: style.italic ? 'italic' : 'normal',
          color: style.color,
          backgroundColor: style.backgroundColor,
          textShadow: '1px 1px 3px rgba(0,0,0,0.8)',
        }}
      >
        {content}
      </span>
    </div>
  )
}

export function AgentPreviewPage() {
  const [request, setRequest] = React.useState<PendingPreviewRequest | null>(null)
  const pendingResolversRef = React.useRef(new Map<string, {
    resolve: (value: { requestId: string }) => void
    reject: (error: Error) => void
  }>())
  const captureRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    window.__LTX_AGENT_PREVIEW_BRIDGE = {
      renderFrame: (nextRequest) => {
        const requestId = `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        return new Promise((resolve, reject) => {
          pendingResolversRef.current.set(requestId, { resolve, reject })
          setRequest({ ...nextRequest, requestId })
        })
      },
    }

    return () => {
      delete window.__LTX_AGENT_PREVIEW_BRIDGE
    }
  }, [])

  const scene = React.useMemo<PreviewSceneState | null>(() => {
    if (!request) return null
    const project = request.project as ProjectState
    const activeTimeline = resolveActiveTimeline(project)
    if (!activeTimeline) return null
    const timeline = hydrateTimeline(activeTimeline, project.assets || [])
    const renderState = deriveFrameRenderState(
      buildFrameRenderCache(timeline.clips, timeline.subtitles ?? []),
      timeline.tracks,
      request.time,
    )
    return {
      project,
      timeline,
      renderState,
      frameSize: { width: request.width, height: request.height },
    }
  }, [request])

  React.useEffect(() => {
    if (!request) return

    let cancelled = false

    const settle = async () => {
      const pending = pendingResolversRef.current.get(request.requestId)
      if (!pending) return
      try {
        if ('fonts' in document) {
          await document.fonts.ready
        }
        const deadline = Date.now() + 15000
        while (!cancelled) {
          await waitForAnimationFrame()
          const mediaNodes = Array.from(
            captureRef.current?.querySelectorAll<HTMLElement>('[data-preview-media="true"]') ?? [],
          )
          if (mediaNodes.every(node => node.dataset.ready === 'true')) {
            break
          }
          if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for preview media to finish loading.')
          }
          await wait(16)
        }
        await waitForAnimationFrame()
        await waitForAnimationFrame()
        if (!cancelled) {
          pending.resolve({ requestId: request.requestId })
          pendingResolversRef.current.delete(request.requestId)
        }
      } catch (error) {
        if (!cancelled) {
          pending.reject(error instanceof Error ? error : new Error(String(error)))
          pendingResolversRef.current.delete(request.requestId)
        }
      }
    }

    void settle()

    return () => {
      cancelled = true
    }
  }, [request, scene])

  const activeClip = scene?.renderState.activeClip ?? null
  const activeAssets = scene?.project.assets ?? []
  const frameSize = scene?.frameSize ?? { width: 1280, height: 720 }
  const currentTime = scene?.renderState.atTime ?? 0
  const requestToken = request?.requestId ?? 'idle'

  const transitionBackground = React.useMemo(() => {
    if (!activeClip || !scene) return null
    const transitionInColor = activeClip.transitionIn?.type !== 'none' ? getTransitionBgColor(activeClip.transitionIn.type) : null
    const transitionOutColor = activeClip.transitionOut?.type !== 'none' ? getTransitionBgColor(activeClip.transitionOut.type) : null
    const color = transitionInColor || transitionOutColor
    if (!color) return null
    const style = getClipEffectStyles(activeClip, Math.max(0, currentTime - activeClip.startTime))
    const opacity = typeof style.opacity === 'number' ? Math.max(0, 1 - style.opacity) : 0
    if (opacity <= 0) return null
    return { color, opacity }
  }, [activeClip, currentTime, scene])

  return (
    <div className="h-screen w-screen overflow-hidden bg-black text-white">
      <div
        ref={captureRef}
        className="relative h-full w-full overflow-hidden bg-black"
        style={{ width: `${frameSize.width}px`, height: `${frameSize.height}px` }}
      >
        {scene && (
          <>
            {scene.renderState.compositingStack.map((clip, index) => (
              <PreviewClipLayer
                key={`composite-${clip.id}-${requestToken}`}
                clip={clip}
                assets={activeAssets}
                atTime={currentTime}
                frameSize={frameSize}
                requestToken={requestToken}
                zIndex={1 + index}
              />
            ))}

            {transitionBackground && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  zIndex: 10,
                  backgroundColor: transitionBackground.color,
                  opacity: transitionBackground.opacity,
                }}
              />
            )}

            {scene.renderState.crossDissolve ? (
              <>
                <PreviewClipLayer
                  key={`outgoing-${scene.renderState.crossDissolve.outgoing.id}-${requestToken}`}
                  clip={scene.renderState.crossDissolve.outgoing}
                  assets={activeAssets}
                  atTime={currentTime}
                  frameSize={frameSize}
                  requestToken={requestToken}
                  opacityOverride={(1 - scene.renderState.crossDissolveProgress) * ((scene.renderState.crossDissolve.outgoing.opacity ?? 100) / 100)}
                  zIndex={20}
                />
                <PreviewClipLayer
                  key={`incoming-${scene.renderState.crossDissolve.incoming.id}-${requestToken}`}
                  clip={scene.renderState.crossDissolve.incoming}
                  assets={activeAssets}
                  atTime={currentTime}
                  frameSize={frameSize}
                  requestToken={requestToken}
                  opacityOverride={scene.renderState.crossDissolveProgress * ((scene.renderState.crossDissolve.incoming.opacity ?? 100) / 100)}
                  zIndex={21}
                />
              </>
            ) : activeClip ? (
              <PreviewClipLayer
                key={`active-${activeClip.id}-${requestToken}`}
                clip={activeClip}
                assets={activeAssets}
                atTime={currentTime}
                frameSize={frameSize}
                requestToken={requestToken}
                zIndex={20}
              />
            ) : null}

            {scene.renderState.activeTextClips.map(textClip => {
              const textStyle = textClip.textStyle
              if (!textStyle) return null

              const frameScale = Math.min(frameSize.width, frameSize.height) / 1080
              const fontSizePx = Math.max(1, Math.round(textStyle.fontSize * frameScale))
              const letterSpacingPx = (textStyle.letterSpacing || 0) * frameScale
              const letterSpacingCss = Math.abs(letterSpacingPx) > 0.001 ? `${letterSpacingPx.toFixed(2)}px` : undefined

              const safeLeft = frameSize.width * 0.15
              const safeRight = frameSize.width * 0.85
              const safeWidth = Math.max(1, safeRight - safeLeft)
              const maxWidthRatio = textStyle.maxWidth > 0 ? Math.max(0.01, Math.min(1, textStyle.maxWidth / 100)) : 1
              const wrapWidth = Math.max(1, Math.min(safeWidth, frameSize.width * maxWidthRatio))
              const halfWrap = wrapWidth / 2
              const unclampedX = (Math.max(0, Math.min(100, textStyle.positionX)) / 100) * frameSize.width
              const minX = safeLeft + halfWrap
              const maxX = safeRight - halfWrap
              const clampedX = minX <= maxX
                ? Math.max(minX, Math.min(maxX, unclampedX))
                : (safeLeft + safeRight) / 2
              const clampedXPct = (clampedX / frameSize.width) * 100
              const wrappedText = wrapTextForSafeArea(
                textStyle.text,
                wrapWidth,
                fontSizePx,
                Math.max(0, letterSpacingPx),
              )

              return (
                <div
                  key={`text-${textClip.id}`}
                  className="absolute z-[24]"
                  style={{
                    left: `${clampedXPct}%`,
                    top: `${textStyle.positionY}%`,
                    transform: 'translate(-50%, -50%)',
                    width: `${wrapWidth}px`,
                    maxWidth: `${wrapWidth}px`,
                    opacity: textStyle.opacity / 100,
                    pointerEvents: 'none',
                  }}
                >
                  <div
                    style={{
                      fontFamily: pickPrimaryFontFamily(textStyle.fontFamily),
                      fontSize: `${fontSizePx}px`,
                      fontWeight: textStyle.fontWeight,
                      fontStyle: textStyle.fontStyle,
                      color: textStyle.color,
                      backgroundColor: textStyle.backgroundColor,
                      textAlign: styleValue(textStyle.textAlign) as React.CSSProperties['textAlign'],
                      padding: textStyle.padding > 0 ? `${Math.max(0, textStyle.padding * frameScale)}px` : undefined,
                      borderRadius: textStyle.borderRadius > 0 ? `${Math.max(0, textStyle.borderRadius * frameScale)}px` : undefined,
                      letterSpacing: letterSpacingCss,
                      lineHeight: textStyle.lineHeight,
                      textShadow: textStyle.shadowBlur > 0 || textStyle.shadowOffsetX !== 0 || textStyle.shadowOffsetY !== 0
                        ? `${textStyle.shadowOffsetX * frameScale}px ${textStyle.shadowOffsetY * frameScale}px ${textStyle.shadowBlur * frameScale}px ${textStyle.shadowColor}`
                        : undefined,
                      WebkitTextStroke: textStyle.strokeWidth > 0 && textStyle.strokeColor !== 'transparent'
                        ? `${textStyle.strokeWidth * frameScale}px ${textStyle.strokeColor}`
                        : undefined,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      userSelect: 'none',
                    }}
                  >
                    {wrappedText}
                  </div>
                </div>
              )
            })}

            {scene.renderState.activeSubtitles.length > 0 && (
              <div className="absolute inset-0 z-[25] pointer-events-none flex flex-col justify-end">
                {scene.renderState.activeSubtitles.map(subtitle => renderSubtitleText(subtitle, currentTime, frameSize, scene.timeline))}
              </div>
            )}

            {scene.renderState.activeLetterbox && (() => {
              const containerRatio = frameSize.width / Math.max(1, frameSize.height)
              const targetRatio = scene.renderState.activeLetterbox.ratio
              if (targetRatio >= containerRatio) {
                const barPct = ((1 - containerRatio / targetRatio) / 2) * 100
                return barPct > 0 ? (
                  <React.Fragment>
                    <div
                      className="absolute left-0 right-0 top-0 z-[18] pointer-events-none"
                      style={{
                        height: `${barPct}%`,
                        backgroundColor: scene.renderState.activeLetterbox.color,
                        opacity: scene.renderState.activeLetterbox.opacity,
                      }}
                    />
                    <div
                      className="absolute left-0 right-0 bottom-0 z-[18] pointer-events-none"
                      style={{
                        height: `${barPct}%`,
                        backgroundColor: scene.renderState.activeLetterbox.color,
                        opacity: scene.renderState.activeLetterbox.opacity,
                      }}
                    />
                  </React.Fragment>
                ) : null
              }
              const barPct = ((1 - targetRatio / containerRatio) / 2) * 100
              return barPct > 0 ? (
                <React.Fragment>
                  <div
                    className="absolute top-0 bottom-0 left-0 z-[18] pointer-events-none"
                    style={{
                      width: `${barPct}%`,
                      backgroundColor: scene.renderState.activeLetterbox.color,
                      opacity: scene.renderState.activeLetterbox.opacity,
                    }}
                  />
                  <div
                    className="absolute top-0 bottom-0 right-0 z-[18] pointer-events-none"
                    style={{
                      width: `${barPct}%`,
                      backgroundColor: scene.renderState.activeLetterbox.color,
                      opacity: scene.renderState.activeLetterbox.opacity,
                    }}
                  />
                </React.Fragment>
              ) : null
            })()}
          </>
        )}
      </div>
    </div>
  )
}
