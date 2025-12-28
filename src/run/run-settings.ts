import type {
  FirecrawlMode,
  LengthArg,
  MarkdownMode,
  PreprocessMode,
  YoutubeMode,
} from '../flags.js'
import {
  parseDurationMs,
  parseFirecrawlMode,
  parseLengthArg,
  parseMarkdownMode,
  parseMaxOutputTokensArg,
  parsePreprocessMode,
  parseRetriesArg,
  parseYoutubeMode,
} from '../flags.js'
import type { OutputLanguage } from '../language.js'
import { resolveOutputLanguage } from '../language.js'
import type { SummaryLengthTarget } from '../prompts/index.js'

export type ResolvedRunSettings = {
  lengthArg: LengthArg
  firecrawlMode: FirecrawlMode
  markdownMode: MarkdownMode
  preprocessMode: PreprocessMode
  youtubeMode: YoutubeMode
  timeoutMs: number
  retries: number
  maxOutputTokensArg: number | null
}

export type RunOverrides = {
  firecrawlMode: FirecrawlMode | null
  markdownMode: MarkdownMode | null
  preprocessMode: PreprocessMode | null
  youtubeMode: YoutubeMode | null
  timeoutMs: number | null
  retries: number | null
  maxOutputTokensArg: number | null
}

export function resolveSummaryLength(
  raw: unknown,
  fallback = 'xl'
): {
  lengthArg: LengthArg
  summaryLength: SummaryLengthTarget
} {
  const value = typeof raw === 'string' ? raw.trim() : ''
  const lengthArg = parseLengthArg(value || fallback)
  const summaryLength =
    lengthArg.kind === 'preset' ? lengthArg.preset : { maxCharacters: lengthArg.maxCharacters }
  return { lengthArg, summaryLength }
}

export function resolveOutputLanguageSetting({
  raw,
  fallback,
}: {
  raw: unknown
  fallback: OutputLanguage
}): OutputLanguage {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return fallback
  return resolveOutputLanguage(value)
}

export function resolveCliRunSettings({
  length,
  firecrawl,
  markdownMode,
  markdown,
  format,
  preprocess,
  youtube,
  timeout,
  retries,
  maxOutputTokens,
}: {
  length: string
  firecrawl: string
  markdownMode?: string | undefined
  markdown?: string | undefined
  format: 'text' | 'markdown'
  preprocess: string
  youtube: string
  timeout: string
  retries: string
  maxOutputTokens?: string | undefined
}): ResolvedRunSettings {
  return {
    lengthArg: parseLengthArg(length),
    firecrawlMode: parseFirecrawlMode(firecrawl),
    markdownMode:
      format === 'markdown'
        ? parseMarkdownMode((markdownMode ?? markdown ?? 'readability') as string)
        : 'off',
    preprocessMode: parsePreprocessMode(preprocess),
    youtubeMode: parseYoutubeMode(youtube),
    timeoutMs: parseDurationMs(timeout),
    retries: parseRetriesArg(retries),
    maxOutputTokensArg: parseMaxOutputTokensArg(maxOutputTokens),
  }
}

const parseOptionalSetting = <T>(raw: unknown, parse: (value: string) => T): T | null => {
  if (typeof raw !== 'string') return null
  try {
    return parse(raw)
  } catch {
    return null
  }
}

export function resolveRunOverrides({
  firecrawl,
  markdownMode,
  preprocess,
  youtube,
  timeout,
  retries,
  maxOutputTokens,
}: {
  firecrawl?: unknown
  markdownMode?: unknown
  preprocess?: unknown
  youtube?: unknown
  timeout?: unknown
  retries?: unknown
  maxOutputTokens?: unknown
}): RunOverrides {
  const timeoutMs = (() => {
    if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) {
      return Math.floor(timeout)
    }
    if (typeof timeout !== 'string') return null
    try {
      return parseDurationMs(timeout)
    } catch {
      return null
    }
  })()

  const retriesResolved = (() => {
    if (typeof retries === 'number' && Number.isFinite(retries) && Number.isInteger(retries)) {
      return retries
    }
    if (typeof retries !== 'string') return null
    try {
      return parseRetriesArg(retries)
    } catch {
      return null
    }
  })()

  const maxOutputTokensArg = (() => {
    if (
      typeof maxOutputTokens === 'number' &&
      Number.isFinite(maxOutputTokens) &&
      maxOutputTokens > 0
    ) {
      return Math.floor(maxOutputTokens)
    }
    if (typeof maxOutputTokens !== 'string') return null
    try {
      return parseMaxOutputTokensArg(maxOutputTokens)
    } catch {
      return null
    }
  })()

  return {
    firecrawlMode: parseOptionalSetting(firecrawl, parseFirecrawlMode),
    markdownMode: parseOptionalSetting(markdownMode, parseMarkdownMode),
    preprocessMode: parseOptionalSetting(preprocess, parsePreprocessMode),
    youtubeMode: parseOptionalSetting(youtube, parseYoutubeMode),
    timeoutMs,
    retries: retriesResolved,
    maxOutputTokensArg,
  }
}
