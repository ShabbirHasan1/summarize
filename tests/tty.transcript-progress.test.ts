import { describe, expect, it, vi } from 'vitest'

import { createTranscriptProgressRenderer } from '../src/tty/progress/transcript.js'

describe('tty transcript progress renderer', () => {
  it('renders download line with total + rate and throttles rapid updates', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    const setText = vi.fn()
    const { onProgress, stop } = createTranscriptProgressRenderer({ spinner: { setText } })

    onProgress({
      kind: 'transcript-media-download-start',
      url: 'https://example.com',
      service: 'podcast',
      mediaUrl: 'https://cdn.example/episode.mp3',
      totalBytes: 4096,
    })
    expect(setText).toHaveBeenLastCalledWith('Downloading audio…')

    vi.setSystemTime(3_000)
    onProgress({
      kind: 'transcript-media-download-progress',
      url: 'https://example.com',
      service: 'podcast',
      downloadedBytes: 2048,
      totalBytes: 4096,
    })
    expect(setText).toHaveBeenLastCalledWith(expect.stringContaining('2.0 KB/4.0 KB'))
    expect(setText).toHaveBeenLastCalledWith(expect.stringContaining('2.0s'))
    expect(setText).toHaveBeenLastCalledWith(expect.stringContaining('KB/s'))

    // Throttle: <100ms should skip spinner updates.
    const callsBefore = setText.mock.calls.length
    vi.setSystemTime(3_050)
    onProgress({
      kind: 'transcript-media-download-progress',
      url: 'https://example.com',
      service: 'podcast',
      downloadedBytes: 3072,
      totalBytes: 4096,
    })
    expect(setText.mock.calls.length).toBe(callsBefore)

    stop()
    vi.useRealTimers()
  })

  it('renders whisper line with duration-only and part counters', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)

    const setText = vi.fn()
    const { onProgress } = createTranscriptProgressRenderer({ spinner: { setText } })

    onProgress({
      kind: 'transcript-whisper-start',
      url: 'https://example.com',
      service: 'podcast',
      providerHint: 'openai->fal',
      modelId: 'whisper-1->fal-ai/wizper'
      totalDurationSeconds: 44,
      parts: 3,
    })

    const first = setText.mock.calls.at(-1)?.[0] ?? ''
    expect(first).toContain('Whisper/OpenAI→FAL, whisper-1->fal-ai/wizper')
    expect(first).toContain('44s')

    vi.setSystemTime(12_000)
    onProgress({
      kind: 'transcript-whisper-progress',
      url: 'https://example.com',
      service: 'podcast',
      processedDurationSeconds: 10,
      totalDurationSeconds: 44,
      partIndex: 1,
      parts: 3,
    })
    const next = setText.mock.calls.at(-1)?.[0] ?? ''
    expect(next).toContain('10s/44s')
    expect(next).toContain('1/3')
    expect(next).toContain('2.0s')

    vi.useRealTimers()
  })

  it('handles progress events before start (elapsed=0, no rate) and service variants', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    const setText = vi.fn()
    const { onProgress } = createTranscriptProgressRenderer({ spinner: { setText } })

    onProgress({
      kind: 'transcript-media-download-progress',
      url: 'https://example.com',
      service: 'youtube',
      downloadedBytes: 0,
      totalBytes: null,
    })
    const download = setText.mock.calls.at(-1)?.[0] ?? ''
    expect(download).toContain('Downloading audio (youtube, 0 B')
    expect(download).toContain('0.0s')
    expect(download).not.toContain('B/s')

    vi.setSystemTime(2_000)
    onProgress({
      kind: 'transcript-whisper-progress',
      url: 'https://example.com',
      service: 'generic',
      processedDurationSeconds: null,
      totalDurationSeconds: null,
      partIndex: null,
      parts: null,
    })
    const whisper = setText.mock.calls.at(-1)?.[0] ?? ''
    expect(whisper).toContain('Transcribing (media, Whisper')
    expect(whisper).toContain('0.0s')

    vi.useRealTimers()
  })

  it('prefers whisper.cpp label without model suffix', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5_000)

    const setText = vi.fn()
    const { onProgress } = createTranscriptProgressRenderer({ spinner: { setText } })

    onProgress({
      kind: 'transcript-whisper-start',
      url: 'https://example.com',
      service: 'podcast',
      providerHint: 'cpp',
      modelId: 'whisper.cpp',
      totalDurationSeconds: 10,
      parts: null,
    })
    const line = setText.mock.calls.at(-1)?.[0] ?? ''
    expect(line).toContain('Whisper.cpp')
    expect(line).not.toContain('whisper.cpp,')

    vi.useRealTimers()
  })
})
