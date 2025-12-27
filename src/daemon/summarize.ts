import { createLinkPreviewClient } from '@steipete/summarize-core/content'
import { countTokens } from 'gpt-tokenizer'

import { buildLinkSummaryPrompt } from '../prompts/index.js'
import { resolveTwitterCookies } from '../run/cookies/twitter.js'
import { buildFinishLineText, buildLengthPartsForFinishLine } from '../run/finish-line.js'

import { countWords, formatInputSummary } from './meta.js'
import { formatProgress } from './summarize-progress.js'
import { createDaemonRunContext, runPrompt } from './summarize-run.js'

export type VisiblePageInput = {
  url: string
  title: string | null
  text: string
  truncated: boolean
}

export type UrlModeInput = {
  url: string
  title: string | null
  maxCharacters: number | null
}

export type StreamSink = {
  writeChunk: (text: string) => void
  onModelChosen: (modelId: string) => void
  writeStatus?: ((text: string) => void) | null
  writeMeta?: ((data: { inputSummary: string | null }) => void) | null
}

export type VisiblePageMetrics = {
  elapsedMs: number
  summary: string
  details: string | null
  summaryDetailed: string
  detailsDetailed: string | null
}

function guessSiteName(url: string): string | null {
  try {
    const { hostname } = new URL(url)
    return hostname || null
  } catch {
    return null
  }
}

export async function streamSummaryForVisiblePage({
  env,
  fetchImpl,
  input,
  modelOverride,
  promptOverride,
  lengthRaw,
  languageRaw,
  sink,
}: {
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
  input: VisiblePageInput
  modelOverride: string | null
  promptOverride: string | null
  lengthRaw: unknown
  languageRaw: unknown
  sink: StreamSink
}): Promise<{ usedModel: string; metrics: VisiblePageMetrics }> {
  const startedAt = Date.now()
  const ctx = createDaemonRunContext({
    env,
    fetchImpl,
    modelOverride,
    lengthRaw,
    languageRaw,
    sink,
  })

  const inputSummary = formatInputSummary({
    kindLabel: null,
    durationSeconds: null,
    words: countWords(input.text),
    characters: input.text.length,
  })
  sink.writeMeta?.({ inputSummary })

  const lengthInstruction =
    promptOverride && typeof ctx.summaryLength !== 'string'
      ? `Output is ${ctx.summaryLength.maxCharacters.toLocaleString()} characters.`
      : null
  const languageExplicit =
    typeof languageRaw === 'string' &&
    languageRaw.trim().length > 0 &&
    languageRaw.trim().toLowerCase() !== 'auto'
  const languageInstruction =
    promptOverride && languageExplicit && ctx.outputLanguage.kind === 'fixed'
      ? `Output should be ${ctx.outputLanguage.label}.`
      : null

  const prompt = buildLinkSummaryPrompt({
    url: input.url,
    title: input.title,
    siteName: guessSiteName(input.url),
    description: null,
    content: input.text,
    truncated: input.truncated,
    hasTranscript: false,
    summaryLength: ctx.summaryLength,
    outputLanguage: ctx.outputLanguage,
    shares: [],
    promptOverride,
    lengthInstruction,
    languageInstruction,
  })
  const promptTokens = countTokens(prompt)

  const { usedModel } = await runPrompt({
    ctx,
    prompt,
    promptTokens,
    kind: 'website',
    requiresVideoUnderstanding: false,
    sink,
  })

  const report = await ctx.metrics.buildReport()
  const costUsd = await ctx.metrics.estimateCostUsd()
  const elapsedMs = Date.now() - startedAt

  const label = guessSiteName(input.url)
  const compact = buildFinishLineText({
    elapsedMs,
    label,
    model: usedModel,
    report,
    costUsd,
    detailed: false,
    extraParts: null,
  })
  const extended = buildFinishLineText({
    elapsedMs,
    label,
    model: usedModel,
    report,
    costUsd,
    detailed: true,
    extraParts: null,
  })

  return {
    usedModel,
    metrics: {
      elapsedMs,
      summary: compact.line,
      details: compact.details,
      summaryDetailed: extended.line,
      detailsDetailed: extended.details,
    },
  }
}

export async function streamSummaryForUrl({
  env,
  fetchImpl,
  input,
  modelOverride,
  promptOverride,
  lengthRaw,
  languageRaw,
  sink,
}: {
  env: Record<string, string | undefined>
  fetchImpl: typeof fetch
  input: UrlModeInput
  modelOverride: string | null
  promptOverride: string | null
  lengthRaw: unknown
  languageRaw: unknown
  sink: StreamSink
}): Promise<{ usedModel: string; metrics: VisiblePageMetrics }> {
  const startedAt = Date.now()
  const ctx = createDaemonRunContext({
    env,
    fetchImpl,
    modelOverride,
    lengthRaw,
    languageRaw,
    sink,
  })

  const writeStatus = typeof sink.writeStatus === 'function' ? sink.writeStatus : null
  writeStatus?.('Extracting…')

  const client = createLinkPreviewClient({
    fetch: fetchImpl,
    apifyApiToken: ctx.apifyApiToken,
    ytDlpPath: ctx.ytDlpPath,
    falApiKey: ctx.falApiKey,
    openaiApiKey: ctx.openaiTranscriptionKey,
    scrapeWithFirecrawl: null,
    resolveTwitterCookies: async (_args) => {
      const res = await resolveTwitterCookies({ env })
      return {
        cookieHeader: res.cookies.cookieHeader,
        ct0: res.cookies.ct0,
        source: res.cookies.source,
        warnings: res.warnings,
      }
    },
    onProgress: (event) => {
      const msg = formatProgress(event)
      if (msg) writeStatus?.(msg)
    },
  })

  const maxCharacters =
    input.maxCharacters && input.maxCharacters > 0 ? input.maxCharacters : 120_000

  const extracted = await client.fetchLinkContent(input.url, {
    timeoutMs: 120_000,
    maxCharacters,
    cacheMode: 'default',
    youtubeTranscript: 'auto',
    firecrawl: 'off',
    format: 'text',
    markdownMode: 'readability',
  })

  const isYouTube =
    extracted.siteName === 'YouTube' || /youtube\.com|youtu\.be/i.test(extracted.url)
  const transcriptChars =
    typeof extracted.transcriptCharacters === 'number' && extracted.transcriptCharacters > 0
      ? extracted.transcriptCharacters
      : null
  const hasTranscript = transcriptChars != null

  const transcriptWords =
    hasTranscript && transcriptChars != null
      ? (extracted.transcriptWordCount ?? Math.max(0, Math.round(transcriptChars / 6)))
      : null

  const exactDurationSeconds =
    typeof extracted.mediaDurationSeconds === 'number' && extracted.mediaDurationSeconds > 0
      ? extracted.mediaDurationSeconds
      : null
  const estimatedDurationSeconds =
    transcriptWords != null && transcriptWords > 0
      ? Math.max(60, Math.max(1, Math.round(transcriptWords / 160)) * 60)
      : null

  const durationSeconds = hasTranscript ? (exactDurationSeconds ?? estimatedDurationSeconds) : null
  const isDurationApproximate =
    hasTranscript && durationSeconds != null && exactDurationSeconds == null

  const kindLabel = (() => {
    if (isYouTube) return 'YouTube'
    if (!hasTranscript) return null
    if (extracted.isVideoOnly || extracted.video) return 'video'
    return 'podcast'
  })()

  const inputSummary = formatInputSummary({
    kindLabel,
    durationSeconds,
    words: hasTranscript ? transcriptWords : extracted.wordCount,
    characters: hasTranscript ? transcriptChars : extracted.totalCharacters,
    isDurationApproximate,
  })
  sink.writeMeta?.({ inputSummary })

  writeStatus?.('Summarizing…')

  const hasTranscriptSource =
    extracted.siteName === 'YouTube' ||
    (extracted.transcriptSource !== null && extracted.transcriptSource !== 'unavailable')

  const lengthInstruction =
    promptOverride && typeof ctx.summaryLength !== 'string'
      ? `Output is ${ctx.summaryLength.maxCharacters.toLocaleString()} characters.`
      : null
  const languageExplicit =
    typeof languageRaw === 'string' &&
    languageRaw.trim().length > 0 &&
    languageRaw.trim().toLowerCase() !== 'auto'
  const languageInstruction =
    promptOverride && languageExplicit && ctx.outputLanguage.kind === 'fixed'
      ? `Output should be ${ctx.outputLanguage.label}.`
      : null

  const prompt = buildLinkSummaryPrompt({
    url: extracted.url,
    title: extracted.title ?? input.title,
    siteName: extracted.siteName ?? guessSiteName(extracted.url),
    description: extracted.description,
    content: extracted.content,
    truncated: extracted.truncated,
    hasTranscript: hasTranscriptSource,
    summaryLength: ctx.summaryLength,
    outputLanguage: ctx.outputLanguage,
    shares: [],
    promptOverride,
    lengthInstruction,
    languageInstruction,
  })
  const promptTokens = countTokens(prompt)

  const kind = extracted.video?.kind === 'youtube' ? 'youtube' : 'website'
  const { usedModel } = await runPrompt({
    ctx,
    prompt,
    promptTokens,
    kind,
    requiresVideoUnderstanding: extracted.isVideoOnly,
    sink,
  })

  const report = await ctx.metrics.buildReport()
  const costUsd = await ctx.metrics.estimateCostUsd()
  const elapsedMs = Date.now() - startedAt

  const label = extracted.siteName ?? guessSiteName(extracted.url)
  const compactExtraParts = buildLengthPartsForFinishLine(extracted, false)
  const detailedExtraParts = buildLengthPartsForFinishLine(extracted, true)

  const compact = buildFinishLineText({
    elapsedMs,
    label,
    model: usedModel,
    report,
    costUsd,
    detailed: false,
    extraParts: compactExtraParts,
  })
  const extended = buildFinishLineText({
    elapsedMs,
    label,
    model: usedModel,
    report,
    costUsd,
    detailed: true,
    extraParts: detailedExtraParts,
  })

  return {
    usedModel,
    metrics: {
      elapsedMs,
      summary: compact.line,
      details: compact.details,
      summaryDetailed: extended.line,
      detailsDetailed: extended.details,
    },
  }
}
