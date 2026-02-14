import type { CliProvider } from '../config.js'
import type {
  FirecrawlMode,
  LengthArg,
  MarkdownMode,
  PreprocessMode,
  VideoMode,
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
  parseVideoMode,
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
  videoMode: VideoMode | null
  transcriptTimestamps: boolean | null
  forceSummary: boolean | null
  timeoutMs: number | null
  retries: number | null
  maxOutputTokensArg: number | null
  transcriber: 'auto' | 'whisper' | 'parakeet' | 'canary' | null
  autoCliFallbackEnabled: boolean | null
  autoCliOrder: CliProvider[] | null
}

export type RunOverridesInput = {
  firecrawl?: unknown
  markdownMode?: unknown
  preprocess?: unknown
  youtube?: unknown
  videoMode?: unknown
  timestamps?: unknown
  forceSummary?: unknown
  timeout?: unknown
  retries?: unknown
  maxOutputTokens?: unknown
  transcriber?: unknown
  autoCliFallback?: unknown
  autoCliOrder?: unknown
  autoCliRememberLastSuccess?: unknown
  // Legacy aliases (kept for compatibility with older extensions).
  magicCliAuto?: unknown
  magicCliOrder?: unknown
  magicCliRememberLastSuccess?: unknown
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
  const strictOverrides = resolveRunOverrides(
    {
      firecrawl,
      markdownMode:
        format === 'markdown' ? ((markdownMode ?? markdown ?? 'readability') as string) : 'off',
      preprocess,
      youtube,
      timeout,
      retries,
      maxOutputTokens,
    },
    { strict: true }
  )
  const requireOverride = <T>(value: T | null, label: string): T => {
    if (value == null) {
      throw new Error(`Missing ${label} override value.`)
    }
    return value
  }

  return {
    lengthArg: parseLengthArg(length),
    firecrawlMode: requireOverride(strictOverrides.firecrawlMode, '--firecrawl'),
    markdownMode: requireOverride(strictOverrides.markdownMode, '--markdown-mode'),
    preprocessMode: requireOverride(strictOverrides.preprocessMode, '--preprocess'),
    youtubeMode: requireOverride(strictOverrides.youtubeMode, '--youtube'),
    timeoutMs: requireOverride(strictOverrides.timeoutMs, '--timeout'),
    retries: requireOverride(strictOverrides.retries, '--retries'),
    maxOutputTokensArg: strictOverrides.maxOutputTokensArg,
  }
}

const parseOptionalSetting = <T>(
  raw: unknown,
  parse: (value: string) => T,
  strict: boolean
): T | null => {
  if (typeof raw !== 'string') return null
  try {
    return parse(raw)
  } catch (error) {
    if (strict) throw error
    return null
  }
}

const parseOptionalBoolean = (
  raw: unknown,
  strict: boolean,
  label = '--timestamps'
): boolean | null => {
  if (typeof raw === 'boolean') return raw
  if (typeof raw !== 'string') return null
  const normalized = raw.trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false
  }
  if (strict) {
    throw new Error(`Unsupported ${label}: ${raw}`)
  }
  return null
}

const parseCliProvider = (raw: string): CliProvider | null => {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'claude') return 'claude'
  if (normalized === 'gemini') return 'gemini'
  if (normalized === 'codex') return 'codex'
  if (normalized === 'agent') return 'agent'
  return null
}

const parseOptionalCliProviderOrder = (raw: unknown, strict: boolean): CliProvider[] | null => {
  if (typeof raw === 'undefined' || raw === null) return null
  const items: string[] = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : typeof raw === 'string'
      ? raw
          .split(/[,\s]+/)
          .map((entry) => entry.trim())
          .filter(Boolean)
      : []
  if (items.length === 0) {
    if (strict) throw new Error(`Unsupported --auto-cli-order: ${String(raw)}`)
    return null
  }
  const out: CliProvider[] = []
  for (const item of items) {
    const provider = parseCliProvider(item)
    if (!provider) {
      if (strict) throw new Error(`Unsupported --auto-cli-order provider: ${item}`)
      return null
    }
    if (!out.includes(provider)) out.push(provider)
  }
  return out.length > 0 ? out : null
}

export function resolveRunOverrides(
  {
    firecrawl,
    markdownMode,
    preprocess,
    youtube,
    videoMode,
    timestamps,
    forceSummary,
    timeout,
    retries,
    maxOutputTokens,
    transcriber,
    autoCliFallback,
    autoCliOrder,
    autoCliRememberLastSuccess,
    magicCliAuto,
    magicCliOrder,
    magicCliRememberLastSuccess,
  }: RunOverridesInput,
  options: { strict?: boolean } = {}
): RunOverrides {
  const strict = options.strict ?? false
  const timeoutMs = (() => {
    if (typeof timeout === 'number') {
      if (Number.isFinite(timeout) && timeout > 0) {
        return Math.floor(timeout)
      }
      if (strict) {
        throw new Error(`Unsupported --timeout: ${String(timeout)}`)
      }
      return null
    }
    if (typeof timeout !== 'string') return null
    try {
      return parseDurationMs(timeout)
    } catch (error) {
      if (strict) throw error
      return null
    }
  })()

  const retriesResolved = (() => {
    if (typeof retries === 'number') {
      if (Number.isFinite(retries) && Number.isInteger(retries)) {
        try {
          return parseRetriesArg(String(retries))
        } catch (error) {
          if (strict) throw error
          return null
        }
      }
      if (strict) {
        throw new Error(`Unsupported --retries: ${String(retries)}`)
      }
      return null
    }
    if (typeof retries !== 'string') return null
    try {
      return parseRetriesArg(retries)
    } catch (error) {
      if (strict) throw error
      return null
    }
  })()

  const maxOutputTokensArg = (() => {
    if (typeof maxOutputTokens === 'number') {
      if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
        try {
          return parseMaxOutputTokensArg(String(maxOutputTokens))
        } catch (error) {
          if (strict) throw error
          return null
        }
      }
      if (strict) {
        throw new Error(`Unsupported --max-output-tokens: ${String(maxOutputTokens)}`)
      }
      return null
    }
    if (typeof maxOutputTokens !== 'string') return null
    try {
      return parseMaxOutputTokensArg(maxOutputTokens)
    } catch (error) {
      if (strict) throw error
      return null
    }
  })()

  const transcriberOverride = (() => {
    if (typeof transcriber !== 'string') return null
    const normalized = transcriber.trim().toLowerCase()
    if (
      normalized === 'auto' ||
      normalized === 'whisper' ||
      normalized === 'parakeet' ||
      normalized === 'canary'
    ) {
      return normalized
    }
    if (strict) {
      throw new Error(`Unsupported transcriber: ${transcriber}`)
    }
    return null
  })()

  const forceSummaryResolved = parseOptionalBoolean(forceSummary, strict, '--force-summary')
  const autoCliFallbackEnabled = parseOptionalBoolean(
    typeof autoCliFallback !== 'undefined' ? autoCliFallback : magicCliAuto,
    strict,
    '--auto-cli-fallback'
  )
  // Kept for backward compatibility with older extension payloads. Ignored now.
  void autoCliRememberLastSuccess
  // Kept for backward compatibility with older extension payloads. Ignored now.
  void magicCliRememberLastSuccess
  const autoCliOrderResolved = parseOptionalCliProviderOrder(
    typeof autoCliOrder !== 'undefined' ? autoCliOrder : magicCliOrder,
    strict
  )

  return {
    firecrawlMode: parseOptionalSetting(firecrawl, parseFirecrawlMode, strict),
    markdownMode: parseOptionalSetting(markdownMode, parseMarkdownMode, strict),
    preprocessMode: parseOptionalSetting(preprocess, parsePreprocessMode, strict),
    youtubeMode: parseOptionalSetting(youtube, parseYoutubeMode, strict),
    videoMode: parseOptionalSetting(videoMode, parseVideoMode, strict),
    transcriptTimestamps: parseOptionalBoolean(timestamps, strict, '--timestamps'),
    forceSummary: forceSummaryResolved,
    timeoutMs,
    retries: retriesResolved,
    maxOutputTokensArg,
    transcriber: transcriberOverride,
    autoCliFallbackEnabled,
    autoCliOrder: autoCliOrderResolved,
  }
}
