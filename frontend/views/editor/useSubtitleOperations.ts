import { useState, useRef, useCallback } from 'react'
import type { SubtitleClip, Track, TimelineClip } from '../../types/project'
import { parseSrt, exportSrt } from '../../lib/srt'

/** Default max words per chunk for progressive subtitle splitting */
const DEFAULT_WORDS_PER_CHUNK = 4

export interface UseSubtitleOperationsParams {
  subtitles: SubtitleClip[]
  setSubtitles: React.Dispatch<React.SetStateAction<SubtitleClip[]>>
  tracks: Track[]
  setTracks: React.Dispatch<React.SetStateAction<Track[]>>
  setClips: React.Dispatch<React.SetStateAction<TimelineClip[]>>
  currentTime: number
  setSelectedClipIds: React.Dispatch<React.SetStateAction<Set<string>>>
  activeTimelineName: string | undefined
}

export function useSubtitleOperations({
  subtitles,
  setSubtitles,
  tracks,
  setTracks,
  setClips,
  currentTime,
  setSelectedClipIds,
  activeTimelineName,
}: UseSubtitleOperationsParams) {
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string | null>(null)
  const [editingSubtitleId, setEditingSubtitleId] = useState<string | null>(null)
  const [subtitleTrackStyleIdx, setSubtitleTrackStyleIdx] = useState<number | null>(null)
  const subtitleFileInputRef = useRef<HTMLInputElement>(null)

  const addSubtitleTrack = () => {
    const subCount = tracks.filter(t => t.type === 'subtitle').length
    const newTrack: Track = {
      id: `track-sub-${Date.now()}`,
      name: subCount > 0 ? `Subtitles ${subCount + 1}` : 'Subtitles',
      muted: false,
      locked: false,
      type: 'subtitle',
    }
    setClips(prev => prev.map(c => ({ ...c, trackIndex: c.trackIndex + 1 })))
    setSubtitles(prev => prev.map(s => ({ ...s, trackIndex: s.trackIndex + 1 })))
    setTracks([newTrack, ...tracks])
  }

  const addSubtitleClip = (trackIndex: number) => {
    const sub: SubtitleClip = {
      id: `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      text: 'New subtitle',
      startTime: currentTime,
      endTime: currentTime + 3,
      trackIndex,
    }
    setSubtitles(prev => [...prev, sub])
    setSelectedSubtitleId(sub.id)
    setEditingSubtitleId(sub.id)
    setSelectedClipIds(new Set())
  }

  const updateSubtitle = (id: string, updates: Partial<SubtitleClip>) => {
    setSubtitles(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s))
  }

  const deleteSubtitle = (id: string) => {
    setSubtitles(prev => prev.filter(s => s.id !== id))
    if (selectedSubtitleId === id) setSelectedSubtitleId(null)
    if (editingSubtitleId === id) setEditingSubtitleId(null)
  }

  const handleImportSrt = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    let subtitleTrackIdx = tracks.findIndex(t => t.type === 'subtitle')
    if (subtitleTrackIdx === -1) {
      addSubtitleTrack()
      subtitleTrackIdx = 0
    }

    const reader = new FileReader()
    reader.onload = (ev) => {
      const content = ev.target?.result as string
      if (!content) return
      const cues = parseSrt(content)
      const newSubs: SubtitleClip[] = cues.map(cue => ({
        id: `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${cue.index}`,
        text: cue.text,
        startTime: cue.startTime,
        endTime: cue.endTime,
        trackIndex: subtitleTrackIdx,
        ...(cue.color ? { style: { color: cue.color } } : {}),
      }))
      setSubtitles(prev => [...prev.filter(s => s.trackIndex !== subtitleTrackIdx), ...newSubs])
    }
    reader.readAsText(file)

    if (subtitleFileInputRef.current) subtitleFileInputRef.current.value = ''
  }

  /**
   * Split a single subtitle into progressive chunks (e.g. 4 words each).
   * Each chunk gets a proportional time slice of the original subtitle's duration,
   * so text appears progressively as the voiceover plays — like TikTok/Reels captions.
   */
  const splitSubtitleProgressive = useCallback((subId: string, wordsPerChunk = DEFAULT_WORDS_PER_CHUNK) => {
    setSubtitles(prev => {
      const idx = prev.findIndex(s => s.id === subId)
      if (idx === -1) return prev

      const sub = prev[idx]
      const words = sub.text.trim().split(/\s+/).filter(Boolean)
      if (words.length <= wordsPerChunk) return prev // Already short enough

      // Build chunks of N words
      const chunks: string[] = []
      for (let i = 0; i < words.length; i += wordsPerChunk) {
        chunks.push(words.slice(i, i + wordsPerChunk).join(' '))
      }

      const totalDuration = sub.endTime - sub.startTime
      // Distribute time proportionally by character count (longer chunks get more time)
      const totalChars = chunks.reduce((sum, c) => sum + c.length, 0)

      const newSubs: SubtitleClip[] = []
      let cursor = sub.startTime

      for (let i = 0; i < chunks.length; i++) {
        const chunkDuration = totalDuration * (chunks[i].length / totalChars)
        const endTime = i === chunks.length - 1 ? sub.endTime : cursor + chunkDuration
        newSubs.push({
          id: `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${i}`,
          text: chunks[i],
          startTime: parseFloat(cursor.toFixed(3)),
          endTime: parseFloat(endTime.toFixed(3)),
          trackIndex: sub.trackIndex,
          style: sub.style,
        })
        cursor = endTime
      }

      // Replace original with chunks
      const result = [...prev]
      result.splice(idx, 1, ...newSubs)

      // Select the first new chunk
      setSelectedSubtitleId(newSubs[0].id)
      return result
    })
  }, [setSubtitles, setSelectedSubtitleId])

  /**
   * Split ALL subtitles on a track into progressive chunks.
   */
  const splitAllSubtitlesProgressive = useCallback((trackIndex: number, wordsPerChunk = DEFAULT_WORDS_PER_CHUNK) => {
    setSubtitles(prev => {
      const result: SubtitleClip[] = []

      for (const sub of prev) {
        if (sub.trackIndex !== trackIndex) {
          result.push(sub)
          continue
        }

        const words = sub.text.trim().split(/\s+/).filter(Boolean)
        if (words.length <= wordsPerChunk) {
          result.push(sub)
          continue
        }

        const chunks: string[] = []
        for (let i = 0; i < words.length; i += wordsPerChunk) {
          chunks.push(words.slice(i, i + wordsPerChunk).join(' '))
        }

        const totalDuration = sub.endTime - sub.startTime
        const totalChars = chunks.reduce((sum, c) => sum + c.length, 0)
        let cursor = sub.startTime

        for (let i = 0; i < chunks.length; i++) {
          const chunkDuration = totalDuration * (chunks[i].length / totalChars)
          const endTime = i === chunks.length - 1 ? sub.endTime : cursor + chunkDuration
          result.push({
            id: `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}-${i}`,
            text: chunks[i],
            startTime: parseFloat(cursor.toFixed(3)),
            endTime: parseFloat(endTime.toFixed(3)),
            trackIndex: sub.trackIndex,
            style: sub.style,
          })
          cursor = endTime
        }
      }

      return result
    })
  }, [setSubtitles])

  const handleExportSrt = () => {
    const cues = subtitles
      .filter(s => s.text.trim())
      .sort((a, b) => a.startTime - b.startTime)

    if (cues.length === 0) {
      alert('No subtitles to export')
      return
    }

    const srtContent = exportSrt(cues)

    if (window.electronAPI?.showSaveDialog) {
      window.electronAPI.showSaveDialog({
        title: 'Export Subtitles',
        defaultPath: `subtitles_${activeTimelineName || 'timeline'}.srt`,
        filters: [{ name: 'SRT Files', extensions: ['srt'] }]
      }).then(filePath => {
        if (filePath) {
          window.electronAPI!.saveFile(filePath, srtContent)
        }
      })
    } else {
      const blob = new Blob([srtContent], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `subtitles_${activeTimelineName || 'timeline'}.srt`
      a.click()
      URL.revokeObjectURL(url)
    }
  }

  return {
    selectedSubtitleId,
    setSelectedSubtitleId,
    editingSubtitleId,
    setEditingSubtitleId,
    subtitleTrackStyleIdx,
    setSubtitleTrackStyleIdx,
    subtitleFileInputRef,
    addSubtitleTrack,
    addSubtitleClip,
    updateSubtitle,
    deleteSubtitle,
    splitSubtitleProgressive,
    splitAllSubtitlesProgressive,
    handleImportSrt,
    handleExportSrt,
  }
}
