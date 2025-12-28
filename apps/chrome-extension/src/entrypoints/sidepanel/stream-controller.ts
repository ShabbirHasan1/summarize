import { mergeStreamingChunk } from '../../../../../src/shared/streaming-merge.js'
import { parseSseStream } from '../../lib/sse'
import type { RunStart } from './types'

type StreamMeta = {
  model?: string | null
  modelLabel?: string | null
  inputSummary?: string | null
  summaryFromCache?: boolean | null
}

export type StreamController = {
  start: (run: RunStart) => Promise<void>
  abort: () => void
  isStreaming: () => boolean
}

export function createStreamController({
  getToken,
  onReset,
  onStatus,
  onBaseTitle,
  onBaseSubtitle,
  onStreamStateChange,
  onRememberUrl,
  onMeta,
  onSummaryFromCache,
  onMetrics,
  onRender,
  onSyncWithActiveTab,
  onError,
  fetchImpl,
}: {
  getToken: () => Promise<string>
  onReset: () => void
  onStatus: (text: string) => void
  onBaseTitle: (text: string) => void
  onBaseSubtitle: (text: string) => void
  onStreamStateChange: (streaming: boolean) => void
  onRememberUrl: (url: string) => void
  onMeta: (meta: StreamMeta) => void
  onSummaryFromCache: (value: boolean | null) => void
  onMetrics: (summary: string) => void
  onRender: (markdown: string) => void
  onSyncWithActiveTab: () => Promise<void>
  onError?: ((error: unknown) => string) | null
  fetchImpl?: typeof fetch
}): StreamController {
  let controller: AbortController | null = null
  let markdown = ''
  let renderQueued = 0
  let streamedAnyNonWhitespace = false
  let rememberedUrl = false
  let streaming = false

  const queueRender = () => {
    if (renderQueued) return
    renderQueued = window.setTimeout(() => {
      renderQueued = 0
      onRender(markdown)
    }, 80)
  }

  const abort = () => {
    if (!controller) return
    controller.abort()
    controller = null
    if (streaming) {
      streaming = false
      onStreamStateChange(false)
    }
  }

  const start = async (run: RunStart) => {
    const token = (await getToken()).trim()
    if (!token) {
      onStatus('Setup required (missing token)')
      return
    }

    abort()
    const nextController = new AbortController()
    controller = nextController
    streaming = true
    streamedAnyNonWhitespace = false
    rememberedUrl = false
    markdown = ''
    onStreamStateChange(true)
    onSummaryFromCache(null)
    onReset()

    onBaseTitle(run.title || run.url)
    onBaseSubtitle('')
    onStatus('Connecting…')

    try {
      const res = await (fetchImpl ?? fetch)(
        `http://127.0.0.1:8787/v1/summarize/${run.id}/events`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: nextController.signal,
        }
      )
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      if (!res.body) throw new Error('Missing stream body')

      onStatus('Summarizing…')

      for await (const msg of parseSseStream(res.body)) {
        if (nextController.signal.aborted) return

        if (msg.event === 'chunk') {
          const data = JSON.parse(msg.data) as { text: string }
          const merged = mergeStreamingChunk(markdown, data.text).next
          if (merged !== markdown) {
            markdown = merged
            queueRender()
          }

          if (!streamedAnyNonWhitespace && data.text.trim().length > 0) {
            streamedAnyNonWhitespace = true
            if (!rememberedUrl) {
              rememberedUrl = true
              onRememberUrl(run.url)
            }
          }
        } else if (msg.event === 'meta') {
          const data = JSON.parse(msg.data) as StreamMeta
          onMeta(data)
          if (typeof data.summaryFromCache === 'boolean') {
            onSummaryFromCache(data.summaryFromCache)
          }
        } else if (msg.event === 'status') {
          const data = JSON.parse(msg.data) as { text: string }
          if (!streamedAnyNonWhitespace) onStatus(data.text)
        } else if (msg.event === 'metrics') {
          const data = JSON.parse(msg.data) as { summary: string }
          onMetrics(data.summary)
        } else if (msg.event === 'error') {
          const data = JSON.parse(msg.data) as { message: string }
          throw new Error(data.message)
        } else if (msg.event === 'done') {
          break
        }
      }

      if (!streamedAnyNonWhitespace) {
        throw new Error('Model returned no output.')
      }

      onStatus('')
    } catch (err) {
      if (nextController.signal.aborted) return
      const message = onError ? onError(err) : err instanceof Error ? err.message : String(err)
      onStatus(`Error: ${message}`)
    } finally {
      if (controller === nextController) {
        streaming = false
        onStreamStateChange(false)
        await onSyncWithActiveTab()
      }
    }
  }

  return {
    start,
    abort,
    isStreaming: () => streaming,
  }
}
