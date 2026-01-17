import { createMarkdownStreamer, render as renderMarkdownAnsi } from 'markdansi'
import { promises as fs } from 'node:fs'

import type { ExtractedLinkContent } from '../../../content/index.js'
import type { SummaryLength } from '../../../shared/contracts.js'
import type { SlideExtractionResult, SlideImage, SlideSourceKind } from '../../../slides/index.js'
import { prepareMarkdownForTerminalStreaming } from '../../markdown.js'
import { createSlidesInlineRenderer } from '../../slides-render.js'
import { createStreamOutputGate, type StreamOutputMode } from '../../stream-output.js'
import type { SummaryStreamHandler } from '../../summary-engine.js'
import { isRichTty, markdownRenderWidth, supportsColor } from '../../terminal.js'
import {
  buildTimestampUrl,
  formatOsc8Link,
  formatTimestamp,
  type SlideTimelineEntry,
} from './slides-text.js'

type SlideState = SlideTimelineEntry & { imagePath: string | null }

function createSlideOutputState(initialSlides: SlideExtractionResult | null | undefined) {
  const slidesByIndex = new Map<number, SlideState>()
  const pending = new Map<number, Array<(value: SlideState | null) => void>>()
  let order: number[] = []
  let slidesDir = initialSlides?.slidesDir ?? ''
  let sourceUrl = initialSlides?.sourceUrl ?? ''
  let done = false

  const updateSlideEntry = (slide: SlideImage) => {
    const existing = slidesByIndex.get(slide.index)
    const next: SlideState = {
      index: slide.index,
      timestamp:
        Number.isFinite(slide.timestamp) && slide.timestamp >= 0
          ? slide.timestamp
          : (existing?.timestamp ?? 0),
      imagePath: slide.imagePath ? slide.imagePath : (existing?.imagePath ?? null),
    }
    slidesByIndex.set(slide.index, next)
    if (slide.imagePath) {
      const waiters = pending.get(slide.index)
      if (waiters && waiters.length > 0) {
        pending.delete(slide.index)
        for (const resolve of waiters) {
          resolve(next)
        }
      }
    }
  }

  const setMeta = (meta: { slidesDir?: string | null; sourceUrl?: string | null }) => {
    if (meta.slidesDir) slidesDir = meta.slidesDir
    if (meta.sourceUrl) sourceUrl = meta.sourceUrl
  }

  const updateFromSlides = (slides: SlideExtractionResult) => {
    slidesDir = slides.slidesDir
    sourceUrl = slides.sourceUrl
    const ordered = slides.slides
      .filter((slide) => Number.isFinite(slide.timestamp))
      .map((slide) => ({ index: slide.index, timestamp: slide.timestamp }))
      .sort((a, b) => a.timestamp - b.timestamp)
    order = ordered.map((slide) => slide.index)
    for (const slide of slides.slides) {
      updateSlideEntry(slide)
    }
  }

  if (initialSlides) updateFromSlides(initialSlides)

  const markDone = () => {
    if (done) return
    done = true
    for (const [index, waiters] of pending.entries()) {
      const entry = slidesByIndex.get(index) ?? null
      for (const resolve of waiters) {
        resolve(entry)
      }
    }
    pending.clear()
  }

  const waitForSlide = (index: number): Promise<SlideState | null> => {
    const existing = slidesByIndex.get(index)
    if (existing?.imagePath) return Promise.resolve(existing)
    if (done) return Promise.resolve(existing ?? null)
    return new Promise((resolve) => {
      const list = pending.get(index) ?? []
      list.push(resolve)
      pending.set(index, list)
    })
  }

  return {
    setMeta,
    updateFromSlides,
    updateSlideEntry,
    waitForSlide,
    markDone,
    getSlides: () => order.map((index) => slidesByIndex.get(index)).filter(Boolean) as SlideState[],
    getSlide: (index: number) => slidesByIndex.get(index) ?? null,
    getOrder: () => order.slice(),
    getSlidesDir: () => slidesDir,
    getSourceUrl: () => sourceUrl,
    isDone: () => done,
  }
}

export type SlidesTerminalOutput = {
  onSlidesExtracted: (slides: SlideExtractionResult) => void
  onSlidesDone: (result: { ok: boolean; error?: string | null }) => void
  onSlideChunk: (chunk: {
    slide: SlideImage
    meta: {
      slidesDir: string
      sourceUrl: string
      sourceId: string
      sourceKind: SlideSourceKind
      ocrAvailable: boolean
    }
  }) => void
  streamHandler: SummaryStreamHandler
  renderFromText: (summary: string) => Promise<void>
}

export function createSlidesTerminalOutput({
  io,
  flags,
  extracted,
  slides,
  enabled,
  outputMode,
  clearProgressForStdout,
  restoreProgressAfterStdout,
  onProgressText,
}: {
  io: {
    env: Record<string, string | undefined>
    envForRun: Record<string, string | undefined>
    stdout: NodeJS.WritableStream
    stderr: NodeJS.WritableStream
  }
  flags: {
    plain: boolean
    lengthArg: { kind: 'preset'; preset: SummaryLength } | { kind: 'chars'; maxCharacters: number }
    slidesDebug?: boolean
  }
  extracted: ExtractedLinkContent
  slides: SlideExtractionResult | null | undefined
  enabled: boolean
  outputMode?: StreamOutputMode | null
  clearProgressForStdout: () => void
  restoreProgressAfterStdout?: (() => void) | null
  onProgressText?: ((text: string) => void) | null
}): SlidesTerminalOutput | null {
  if (!enabled) return null
  const inlineRenderer = !flags.plain
    ? createSlidesInlineRenderer({ mode: 'auto', env: io.envForRun, stdout: io.stdout })
    : null
  const inlineProtocol = inlineRenderer?.protocol ?? 'none'
  const inlineEnabled = inlineProtocol !== 'none'
  const inlineNoticeEnabled = !flags.plain && !inlineEnabled
  let inlineNoticeShown = false

  const state = createSlideOutputState(slides)
  state.setMeta({ sourceUrl: extracted.url })
  const noteInlineUnsupported = (nextSlides: SlideExtractionResult) => {
    if (!inlineNoticeEnabled || inlineNoticeShown) return
    if (!nextSlides.slidesDir) return
    inlineNoticeShown = true
    const reason = isRichTty(io.stdout)
      ? 'terminal does not support inline images'
      : 'stdout is not a TTY'
    clearProgressForStdout()
    io.stderr.write(
      `Slides saved to ${nextSlides.slidesDir}. Inline images unavailable (${reason}).\n`
    )
    const urlArg = JSON.stringify(nextSlides.sourceUrl)
    const dirArg = JSON.stringify(nextSlides.slidesDir)
    io.stderr.write(`Use summarize slides ${urlArg} --output ${dirArg} to export only.\n`)
    restoreProgressAfterStdout?.()
  }

  const onSlidesExtracted = (nextSlides: SlideExtractionResult) => {
    state.updateFromSlides(nextSlides)
    noteInlineUnsupported(nextSlides)
  }

  const onSlideChunk = (chunk: {
    slide: SlideImage
    meta: { slidesDir: string; sourceUrl: string }
  }) => {
    state.setMeta({ slidesDir: chunk.meta?.slidesDir, sourceUrl: chunk.meta?.sourceUrl })
    state.updateSlideEntry(chunk.slide)
  }

  const onSlidesDone = (_result: { ok: boolean; error?: string | null }) => {
    state.markDone()
  }

  let renderedCount = 0
  const renderSlide = async (index: number) => {
    if (index <= 0) return
    const total = state.getOrder().length || (slides?.slides.length ?? 0)
    const slide = state.getSlide(index)
    let imagePath = slide?.imagePath ?? null
    if (inlineEnabled) {
      const ready = await state.waitForSlide(index)
      imagePath = ready?.imagePath ?? imagePath
    }
    const timestamp = slide?.timestamp
    const timestampLabel =
      typeof timestamp === 'number' && Number.isFinite(timestamp)
        ? formatTimestamp(timestamp)
        : null
    const timestampUrl =
      typeof timestamp === 'number' && Number.isFinite(timestamp)
        ? buildTimestampUrl(state.getSourceUrl(), timestamp)
        : null
    const timeLink = timestampLabel
      ? formatOsc8Link(timestampLabel, timestampUrl, isRichTty(io.stdout) && !flags.plain)
      : null
    const label = timeLink ? `Slide ${index} · ${timeLink}` : `Slide ${index}`

    clearProgressForStdout()
    io.stdout.write('\n')
    if (inlineEnabled && imagePath && inlineRenderer && !flags.slidesDebug) {
      await inlineRenderer.renderSlide({ index, timestamp: timestamp ?? 0, imagePath }, null)
    }
    if (flags.slidesDebug) {
      let resolvedPath = imagePath ?? '(missing image path)'
      if (imagePath) {
        const exists = await fs
          .stat(imagePath)
          .then(() => true)
          .catch(() => false)
        resolvedPath = exists ? imagePath : `${imagePath} (missing)`
      }
      io.stdout.write(`${label}\n${resolvedPath}\n\n`)
    } else {
      io.stdout.write(`${label}\n\n`)
    }
    restoreProgressAfterStdout?.()

    if (onProgressText && total > 0) {
      renderedCount = Math.min(total, renderedCount + 1)
      onProgressText(`Slides ${renderedCount}/${total}`)
    }
  }

  const streamHandler: SummaryStreamHandler = createSlidesSummaryStreamHandler({
    stdout: io.stdout,
    env: io.env,
    envForRun: io.envForRun,
    plain: flags.plain,
    outputMode: outputMode ?? 'line',
    clearProgressForStdout,
    restoreProgressAfterStdout,
    renderSlide,
    getSlideIndexOrder: () => state.getOrder(),
  })

  const renderFromText = async (text: string) => {
    await streamHandler.onChunk({ streamed: text, prevStreamed: '', appended: text })
    await streamHandler.onDone?.(text)
  }

  return {
    onSlidesExtracted,
    onSlidesDone,
    onSlideChunk,
    streamHandler,
    renderFromText,
  }
}

export function createSlidesSummaryStreamHandler({
  stdout,
  env,
  envForRun,
  plain,
  outputMode,
  clearProgressForStdout,
  restoreProgressAfterStdout,
  renderSlide,
  getSlideIndexOrder,
}: {
  stdout: NodeJS.WritableStream
  env: Record<string, string | undefined>
  envForRun: Record<string, string | undefined>
  plain: boolean
  outputMode: StreamOutputMode
  clearProgressForStdout: () => void
  restoreProgressAfterStdout?: (() => void) | null
  renderSlide: (index: number) => Promise<void>
  getSlideIndexOrder: () => number[]
}): SummaryStreamHandler {
  const shouldRenderMarkdown = !plain && isRichTty(stdout)
  const outputGate = !shouldRenderMarkdown
    ? createStreamOutputGate({
        stdout,
        clearProgressForStdout,
        restoreProgressAfterStdout: restoreProgressAfterStdout ?? null,
        outputMode,
        richTty: isRichTty(stdout),
      })
    : null
  const streamer = shouldRenderMarkdown
    ? createMarkdownStreamer({
        render: (markdown) =>
          renderMarkdownAnsi(prepareMarkdownForTerminalStreaming(markdown), {
            width: markdownRenderWidth(stdout, env),
            wrap: true,
            color: supportsColor(stdout, envForRun),
            hyperlinks: true,
          }),
        spacing: 'single',
      })
    : null

  let wroteLeadingBlankLine = false
  let buffered = ''
  const renderedSlides = new Set<number>()
  let visible = ''
  const slideTagRegex = /\[slide:(\d+)\]/i
  const slideLabelRegex = /(^|\n)[\t ]*slide\s+(\d+)(?:\s*[\u00b7:-].*)?(?=\n|$)/i

  const handleMarkdownChunk = (nextVisible: string, prevVisible: string) => {
    if (!streamer) return
    const appended = nextVisible.slice(prevVisible.length)
    if (!appended) return
    const out = streamer.push(appended)
    if (!out) return
    clearProgressForStdout()
    if (!wroteLeadingBlankLine) {
      stdout.write(`\n${out.replace(/^\n+/, '')}`)
      wroteLeadingBlankLine = true
    } else {
      stdout.write(out)
    }
    restoreProgressAfterStdout?.()
  }

  const appendVisible = (segment: string) => {
    if (!segment) return
    const prevVisible = visible
    visible += segment
    if (outputGate) {
      outputGate.handleChunk(visible, prevVisible)
      return
    }
    handleMarkdownChunk(visible, prevVisible)
  }

  const renderSlideBlock = async (index: number) => {
    if (renderedSlides.has(index)) return
    renderedSlides.add(index)
    await renderSlide(index)
  }

  const flushBuffered = async ({ final }: { final: boolean }) => {
    while (buffered.length > 0) {
      const tagMatch = slideTagRegex.exec(buffered)
      const labelMatch = slideLabelRegex.exec(buffered)
      const nextMatch =
        tagMatch && labelMatch
          ? (tagMatch.index ?? 0) <= (labelMatch.index ?? 0)
            ? { kind: 'tag' as const, match: tagMatch }
            : { kind: 'label' as const, match: labelMatch }
          : tagMatch
            ? { kind: 'tag' as const, match: tagMatch }
            : labelMatch
              ? { kind: 'label' as const, match: labelMatch }
              : null

      if (!nextMatch) {
        if (final) {
          appendVisible(buffered)
          buffered = ''
          return
        }
        const lower = buffered.toLowerCase()
        const start = lower.lastIndexOf('[slide:')
        if (start === -1) {
          appendVisible(buffered)
          buffered = ''
          return
        }
        const head = buffered.slice(0, start)
        appendVisible(head)
        buffered = buffered.slice(start)
        return
      }
      const rawIndex =
        nextMatch.kind === 'tag' ? nextMatch.match[1] : nextMatch.match[2] ?? nextMatch.match[1]
      const index = Number.parseInt(rawIndex ?? '', 10)
      const matchIndex = nextMatch.match.index ?? 0
      const before = buffered.slice(0, matchIndex)
      const after = buffered.slice(matchIndex + nextMatch.match[0].length)
      appendVisible(before)
      buffered = after
      if (Number.isFinite(index) && index > 0) {
        await renderSlideBlock(index)
      }
    }
  }

  return {
    onChunk: async ({ appended }) => {
      if (!appended) return
      buffered += appended
      await flushBuffered({ final: false })
    },
    onDone: async () => {
      await flushBuffered({ final: true })
      const ordered = getSlideIndexOrder()
      for (const index of ordered) {
        if (!renderedSlides.has(index)) {
          await renderSlideBlock(index)
        }
      }
      if (outputGate) {
        outputGate.finalize(visible)
        return
      }
      const out = streamer?.finish()
      if (out) {
        clearProgressForStdout()
        if (!wroteLeadingBlankLine) {
          stdout.write(`\n${out.replace(/^\n+/, '')}`)
          wroteLeadingBlankLine = true
        } else {
          stdout.write(out)
        }
        restoreProgressAfterStdout?.()
      } else if (visible && !wroteLeadingBlankLine) {
        clearProgressForStdout()
        stdout.write(`\n${visible.trim()}\n`)
        restoreProgressAfterStdout?.()
      }
    },
  }
}
