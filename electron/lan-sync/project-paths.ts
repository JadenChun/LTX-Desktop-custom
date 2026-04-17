/**
 * Shared project path-field specification.
 * A single mapper visits every file-path field in the project tree.
 * Used by project-bundler (relativize/collect) and project-extractor (absolutize).
 */

export type PathMapper = (value: unknown) => unknown

function mapGenerationParams(gp: unknown, map: PathMapper): unknown {
  if (!gp || typeof gp !== 'object' || Array.isArray(gp)) return gp
  const g = gp as Record<string, unknown>
  return {
    ...g,
    inputImageUrl: map(g['inputImageUrl']),
    inputAudioUrl: map(g['inputAudioUrl']),
    retakeVideoPath: map(g['retakeVideoPath']),
    icLoraVideoPath: map(g['icLoraVideoPath']),
  }
}

function mapAsset(asset: unknown, map: PathMapper): unknown {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return asset
  const a = asset as Record<string, unknown>
  return {
    ...a,
    path: map(a['path']),
    bigThumbnailPath: map(a['bigThumbnailPath']),
    smallThumbnailPath: map(a['smallThumbnailPath']),
    thumbnail: map(a['thumbnail']),
    generationParams: mapGenerationParams(a['generationParams'], map),
    takes: Array.isArray(a['takes'])
      ? a['takes'].map((take) => {
          const t = take as Record<string, unknown>
          return {
            ...t,
            path: map(t['path']),
            bigThumbnailPath: map(t['bigThumbnailPath']),
            smallThumbnailPath: map(t['smallThumbnailPath']),
            thumbnail: map(t['thumbnail']),
            generationParams: mapGenerationParams(t['generationParams'], map),
          }
        })
      : a['takes'],
  }
}

/**
 * Visit every file-path field in the project tree, applying `map` to each value.
 * Non-path fields are passed through unchanged.
 */
export function mapProjectPaths(
  project: Record<string, unknown>,
  map: PathMapper,
): Record<string, unknown> {
  return {
    ...project,
    thumbnail: map(project['thumbnail']),
    assets: Array.isArray(project['assets'])
      ? project['assets'].map((asset) => mapAsset(asset, map))
      : project['assets'],
    timelines: Array.isArray(project['timelines'])
      ? project['timelines'].map((timeline) => {
          if (!timeline || typeof timeline !== 'object') return timeline
          const tl = timeline as Record<string, unknown>
          return {
            ...tl,
            clips: Array.isArray(tl['clips'])
              ? tl['clips'].map((clip) => {
                  if (!clip || typeof clip !== 'object') return clip
                  const c = clip as Record<string, unknown>
                  return {
                    ...c,
                    importedUrl: map(c['importedUrl']),
                    asset: c['asset'] ? mapAsset(c['asset'], map) : c['asset'],
                  }
                })
              : tl['clips'],
          }
        })
      : project['timelines'],
  }
}
