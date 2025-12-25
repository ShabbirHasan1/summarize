import type { FirecrawlScrapeResult, LinkPreviewDeps } from '../deps.js'
import { resolveTranscriptForLink } from '../transcript/index.js'
import { extractYouTubeVideoId, isYouTubeUrl, isYouTubeVideoUrl } from '../transcript/utils.js'
import type { FirecrawlDiagnostics, MarkdownDiagnostics } from '../types.js'
import {
  extractArticleContent,
  extractPlainText,
  sanitizeHtmlForMarkdownConversion,
} from './article.js'
import { normalizeForPrompt } from './cleaner.js'
import { fetchHtmlDocument, fetchWithFirecrawl } from './fetcher.js'
import { extractJsonLdContent } from './jsonld.js'
import { extractMetadataFromFirecrawl, extractMetadataFromHtml } from './parsers.js'
import { extractReadabilityFromHtml, toReadabilityHtml } from './readability.js'
import type { ExtractedLinkContent, FetchLinkContentOptions, MarkdownMode } from './types.js'
import {
  appendNote,
  ensureTranscriptDiagnostics,
  finalizeExtractedLinkContent,
  pickFirstText,
  resolveCacheMode,
  resolveFirecrawlMode,
  resolveMaxCharacters,
  resolveTimeoutMs,
  safeHostname,
  selectBaseContent,
} from './utils.js'
import { detectPrimaryVideoFromHtml } from './video.js'
import { extractYouTubeShortDescription } from './youtube.js'

const LEADING_CONTROL_PATTERN = /^[\\s\\p{Cc}]+/u
const BLOCKED_HTML_HINT_PATTERN =
  /access denied|attention required|captcha|cloudflare|enable javascript|forbidden|please turn javascript on|verify you are human/i
const TWITTER_BLOCKED_TEXT_PATTERN =
  /something went wrong|try again|privacy related extensions|please disable them and try again/i
const MIN_HTML_CONTENT_CHARACTERS = 200
const MIN_READABILITY_CONTENT_CHARACTERS = 200
const MIN_METADATA_DESCRIPTION_CHARACTERS = 120
const READABILITY_RELATIVE_THRESHOLD = 0.6
const MIN_HTML_DOCUMENT_CHARACTERS_FOR_FALLBACK = 5000
const TWITTER_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com'])
const NITTER_HOST = 'nitter.net'

function extractSpotifyEpisodeId(url: string): string | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (!host.endsWith('spotify.com')) return null
    const parts = parsed.pathname.split('/').filter(Boolean)
    const idx = parts.indexOf('episode')
    const id = idx >= 0 ? parts[idx + 1] : null
    return id && /^[A-Za-z0-9]+$/.test(id) ? id : null
  } catch {
    return null
  }
}

function extractApplePodcastIds(url: string): { showId: string; episodeId: string | null } | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (host !== 'podcasts.apple.com') return null
    const showId = parsed.pathname.match(/\/id(\d+)(?:\/|$)/)?.[1] ?? null
    if (!showId) return null
    const episodeIdRaw = parsed.searchParams.get('i')
    const episodeId = episodeIdRaw && /^\d+$/.test(episodeIdRaw) ? episodeIdRaw : null
    return { showId, episodeId }
  } catch {
    return null
  }
}

function stripLeadingTitle(content: string, title: string | null | undefined): string {
  if (!(content && title)) {
    return content
  }

  const normalizedTitle = title.trim()
  if (normalizedTitle.length === 0) {
    return content
  }

  const trimmedContent = content.trimStart()
  if (!trimmedContent.toLowerCase().startsWith(normalizedTitle.toLowerCase())) {
    return content
  }

  const remainderOriginal = trimmedContent.slice(normalizedTitle.length)
  const remainder = remainderOriginal.replace(LEADING_CONTROL_PATTERN, '')
  return remainder
}

function isPodcastLikeJsonLdType(type: string | null | undefined): boolean {
  if (!type) return false
  const normalized = type.toLowerCase()
  if (normalized.includes('podcast')) return true
  return (
    normalized === 'audioobject' ||
    normalized === 'episode' ||
    normalized === 'radioepisode' ||
    normalized === 'musicrecording'
  )
}

const PODCAST_HOST_SUFFIXES = [
  'spotify.com',
  'podcasts.apple.com',
  'podchaser.com',
  'podbean.com',
  'buzzsprout.com',
  'spreaker.com',
  'simplecast.com',
  'rss.com',
  'libsyn.com',
  'omny.fm',
  'acast.com',
  'transistor.fm',
  'captivate.fm',
  'soundcloud.com',
  'ivoox.com',
  'iheart.com',
  'megaphone.fm',
  'pca.st',
  'player.fm',
  'castbox.fm',
]

function isPodcastHost(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (host.startsWith('music.amazon.') && parsed.pathname.includes('/podcasts/')) {
      return true
    }
    return PODCAST_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  } catch {
    return false
  }
}

function shouldFallbackToFirecrawl(html: string): boolean {
  const plainText = normalizeForPrompt(extractPlainText(html))
  if (BLOCKED_HTML_HINT_PATTERN.test(plainText)) return true
  const normalized = normalizeForPrompt(extractArticleContent(html))
  if (normalized.length >= MIN_HTML_CONTENT_CHARACTERS) {
    return false
  }

  // Avoid spending Firecrawl on truly small/simple pages where the extracted HTML content is short but
  // likely complete (e.g. https://example.com). Only treat "thin" content as a Firecrawl signal when
  // the HTML document itself is large (SSR/app-shell pages, blocked pages without a match, etc.).
  return html.length >= MIN_HTML_DOCUMENT_CHARACTERS_FOR_FALLBACK
}

function isTwitterStatusUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (!TWITTER_HOSTS.has(host)) return false
    return /\/status\/\d+/.test(parsed.pathname)
  } catch {
    return false
  }
}

function toNitterUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (!TWITTER_HOSTS.has(host)) return null
    parsed.hostname = NITTER_HOST
    parsed.protocol = 'https:'
    return parsed.toString()
  } catch {
    return null
  }
}

function isBlockedTwitterContent(content: string): boolean {
  if (!content) return false
  return TWITTER_BLOCKED_TEXT_PATTERN.test(content)
}

export async function fetchLinkContent(
  url: string,
  options: FetchLinkContentOptions | undefined,
  deps: LinkPreviewDeps
): Promise<ExtractedLinkContent> {
  const timeoutMs = resolveTimeoutMs(options)
  const cacheMode = resolveCacheMode(options)
  const maxCharacters = resolveMaxCharacters(options)
  const youtubeTranscriptMode = options?.youtubeTranscript ?? 'auto'
  const firecrawlMode = resolveFirecrawlMode(options)
  const markdownRequested = (options?.format ?? 'text') === 'markdown'
  const markdownMode: MarkdownMode = options?.markdownMode ?? 'auto'

  const canUseFirecrawl =
    firecrawlMode !== 'off' && deps.scrapeWithFirecrawl !== null && !isYouTubeUrl(url)

  const spotifyEpisodeId = extractSpotifyEpisodeId(url)
  if (spotifyEpisodeId) {
    if (!deps.openaiApiKey && !deps.falApiKey) {
      throw new Error(
        'Spotify episode transcription requires OPENAI_API_KEY or FAL_KEY (Whisper); otherwise you may only get a captcha/recaptcha HTML page.'
      )
    }

    const transcriptResolution = await resolveTranscriptForLink(url, null, deps, {
      youtubeTranscriptMode,
      cacheMode,
    })
    if (!transcriptResolution.text) {
      const notes = transcriptResolution.diagnostics?.notes
      const suffix = notes ? ` (${notes})` : ''
      throw new Error(`Failed to transcribe Spotify episode${suffix}`)
    }

    const transcriptDiagnostics = ensureTranscriptDiagnostics(
      transcriptResolution,
      cacheMode ?? 'default'
    )
    transcriptDiagnostics.notes = appendNote(
      transcriptDiagnostics.notes,
      'Spotify episode: skipped HTML fetch to avoid captcha pages'
    )

    return finalizeExtractedLinkContent({
      url,
      baseContent: selectBaseContent('', transcriptResolution.text),
      maxCharacters,
      title: null,
      description: null,
      siteName: 'Spotify',
      transcriptResolution,
      video: null,
      isVideoOnly: false,
      diagnostics: {
        strategy: 'html',
        firecrawl: {
          attempted: false,
          used: false,
          cacheMode,
          cacheStatus: cacheMode === 'bypass' ? 'bypassed' : 'unknown',
          notes: 'Spotify short-circuit skipped HTML/Firecrawl',
        },
        markdown: {
          requested: markdownRequested,
          used: false,
          provider: null,
          notes: 'Spotify short-circuit uses transcript content',
        },
        transcript: transcriptDiagnostics,
      },
    })
  }

  const appleIds = extractApplePodcastIds(url)
  if (appleIds) {
    if (!deps.openaiApiKey && !deps.falApiKey) {
      throw new Error(
        'Apple Podcasts transcription requires OPENAI_API_KEY or FAL_KEY (Whisper); otherwise you may only get a slow/blocked HTML page.'
      )
    }

    const transcriptResolution = await resolveTranscriptForLink(url, null, deps, {
      youtubeTranscriptMode,
      cacheMode,
    })
    if (!transcriptResolution.text) {
      const notes = transcriptResolution.diagnostics?.notes
      const suffix = notes ? ` (${notes})` : ''
      throw new Error(`Failed to transcribe Apple Podcasts episode${suffix}`)
    }

    const transcriptDiagnostics = ensureTranscriptDiagnostics(
      transcriptResolution,
      cacheMode ?? 'default'
    )
    transcriptDiagnostics.notes = appendNote(
      transcriptDiagnostics.notes,
      'Apple Podcasts: skipped HTML fetch (prefer iTunes lookup / enclosures)'
    )

    return finalizeExtractedLinkContent({
      url,
      baseContent: selectBaseContent('', transcriptResolution.text),
      maxCharacters,
      title: null,
      description: null,
      siteName: 'Apple Podcasts',
      transcriptResolution,
      video: null,
      isVideoOnly: false,
      diagnostics: {
        strategy: 'html',
        firecrawl: {
          attempted: false,
          used: false,
          cacheMode,
          cacheStatus: cacheMode === 'bypass' ? 'bypassed' : 'unknown',
          notes: 'Apple Podcasts short-circuit skipped HTML/Firecrawl',
        },
        markdown: {
          requested: markdownRequested,
          used: false,
          provider: null,
          notes: 'Apple Podcasts short-circuit uses transcript content',
        },
        transcript: transcriptDiagnostics,
      },
    })
  }

  let firecrawlAttempted = false
  let firecrawlPayload: FirecrawlScrapeResult | null = null
  const firecrawlDiagnostics: FirecrawlDiagnostics = {
    attempted: false,
    used: false,
    cacheMode,
    cacheStatus: cacheMode === 'bypass' ? 'bypassed' : 'unknown',
    notes: null,
  }

  const twitterStatus = isTwitterStatusUrl(url)
  const nitterUrl = twitterStatus ? toNitterUrl(url) : null
  let birdError: unknown = null
  let nitterError: unknown = null

  const attemptFirecrawl = async (reason: string): Promise<ExtractedLinkContent | null> => {
    if (!canUseFirecrawl) {
      return null
    }

    if (!firecrawlAttempted) {
      const attempt = await fetchWithFirecrawl(url, deps.scrapeWithFirecrawl, {
        timeoutMs,
        cacheMode,
        onProgress: deps.onProgress ?? null,
        reason,
      })
      firecrawlAttempted = true
      firecrawlPayload = attempt.payload
      firecrawlDiagnostics.attempted = attempt.diagnostics.attempted
      firecrawlDiagnostics.used = attempt.diagnostics.used
      firecrawlDiagnostics.cacheMode = attempt.diagnostics.cacheMode
      firecrawlDiagnostics.cacheStatus = attempt.diagnostics.cacheStatus
      firecrawlDiagnostics.notes = attempt.diagnostics.notes ?? null
    }

    firecrawlDiagnostics.notes = appendNote(firecrawlDiagnostics.notes, reason)

    if (!firecrawlPayload) {
      return null
    }

    const firecrawlResult = await buildResultFromFirecrawl({
      url,
      payload: firecrawlPayload,
      cacheMode,
      maxCharacters,
      youtubeTranscriptMode,
      firecrawlDiagnostics,
      markdownRequested,
      deps,
    })
    if (firecrawlResult) {
      return firecrawlResult
    }

    firecrawlDiagnostics.notes = appendNote(
      firecrawlDiagnostics.notes,
      'Firecrawl returned empty content'
    )
    return null
  }

  const attemptBird = async (): Promise<ExtractedLinkContent | null> => {
    if (!deps.readTweetWithBird || !twitterStatus) {
      return null
    }

    deps.onProgress?.({ kind: 'bird-start', url })
    try {
      const tweet = await deps.readTweetWithBird({ url, timeoutMs })
      const text = tweet?.text?.trim() ?? ''
      if (text.length === 0) {
        deps.onProgress?.({ kind: 'bird-done', url, ok: false, textBytes: null })
        return null
      }

      const title = tweet?.author?.username ? `@${tweet.author.username}` : null
      const description = null
      const siteName = 'X'
      const transcriptResolution = { text: null, source: null }
      const transcriptDiagnostics = ensureTranscriptDiagnostics(
        transcriptResolution,
        cacheMode ?? 'default'
      )
      const result = finalizeExtractedLinkContent({
        url,
        baseContent: text,
        maxCharacters,
        title,
        description,
        siteName,
        transcriptResolution,
        video: null,
        isVideoOnly: false,
        diagnostics: {
          strategy: 'bird',
          firecrawl: firecrawlDiagnostics,
          markdown: {
            requested: markdownRequested,
            used: false,
            provider: null,
            notes: 'Bird tweet fetch provides plain text',
          },
          transcript: transcriptDiagnostics,
        },
      })
      deps.onProgress?.({
        kind: 'bird-done',
        url,
        ok: true,
        textBytes: Buffer.byteLength(result.content, 'utf8'),
      })
      return result
    } catch (error) {
      birdError = error
      deps.onProgress?.({ kind: 'bird-done', url, ok: false, textBytes: null })
      return null
    }
  }

  const birdResult = await attemptBird()
  if (birdResult) {
    return birdResult
  }

  const attemptNitter = async (): Promise<string | null> => {
    if (!nitterUrl) {
      return null
    }
    deps.onProgress?.({ kind: 'nitter-start', url })
    try {
      const nitterHtml = await fetchHtmlDocument(deps.fetch, nitterUrl, { timeoutMs })
      deps.onProgress?.({
        kind: 'nitter-done',
        url,
        ok: true,
        textBytes: Buffer.byteLength(nitterHtml, 'utf8'),
      })
      return nitterHtml
    } catch (error) {
      nitterError = error
      deps.onProgress?.({ kind: 'nitter-done', url, ok: false, textBytes: null })
      return null
    }
  }

  const nitterHtml = await attemptNitter()
  if (nitterHtml) {
    const nitterResult = await buildResultFromHtmlDocument({
      url,
      html: nitterHtml,
      cacheMode,
      maxCharacters,
      youtubeTranscriptMode,
      firecrawlDiagnostics,
      markdownRequested,
      markdownMode,
      timeoutMs,
      deps,
      readabilityCandidate: null,
    })
    if (!isBlockedTwitterContent(nitterResult.content)) {
      nitterResult.diagnostics.strategy = 'nitter'
      return nitterResult
    }
    nitterError = new Error('Nitter returned blocked or empty content')
  }

  if (firecrawlMode === 'always') {
    const firecrawlResult = await attemptFirecrawl('Firecrawl forced via options')
    if (firecrawlResult) {
      return firecrawlResult
    }
  }

  let html: string | null = null
  let htmlError: unknown = null

  try {
    html = await fetchHtmlDocument(deps.fetch, url, {
      timeoutMs,
      onProgress: deps.onProgress ?? null,
    })
  } catch (error) {
    htmlError = error
  }

  if (!html) {
    if (!canUseFirecrawl) {
      throw htmlError instanceof Error ? htmlError : new Error('Failed to fetch HTML document')
    }

    const firecrawlResult = await attemptFirecrawl('HTML fetch failed; falling back to Firecrawl')
    if (firecrawlResult) {
      return firecrawlResult
    }

    const firecrawlError = firecrawlDiagnostics.notes
      ? `; Firecrawl notes: ${firecrawlDiagnostics.notes}`
      : ''
    throw new Error(
      `Failed to fetch HTML document${firecrawlError}${
        htmlError instanceof Error ? `; HTML error: ${htmlError.message}` : ''
      }`
    )
  }

  let readabilityCandidate: Awaited<ReturnType<typeof extractReadabilityFromHtml>> | null = null

  if (firecrawlMode === 'auto' && shouldFallbackToFirecrawl(html)) {
    readabilityCandidate = await extractReadabilityFromHtml(html, url)
    const readabilityText = readabilityCandidate?.text
      ? normalizeForPrompt(readabilityCandidate.text)
      : ''
    if (readabilityText.length < MIN_READABILITY_CONTENT_CHARACTERS) {
      const firecrawlResult = await attemptFirecrawl(
        'HTML content looked blocked/thin; falling back to Firecrawl'
      )
      if (firecrawlResult) {
        return firecrawlResult
      }
    }
  }

  const htmlResult = await buildResultFromHtmlDocument({
    url,
    html,
    cacheMode,
    maxCharacters,
    youtubeTranscriptMode,
    firecrawlDiagnostics,
    markdownRequested,
    markdownMode,
    timeoutMs,
    deps,
    readabilityCandidate,
  })
  if (twitterStatus && isBlockedTwitterContent(htmlResult.content)) {
    const birdNote = !deps.readTweetWithBird
      ? 'Bird not available'
      : birdError
        ? `Bird failed: ${birdError instanceof Error ? birdError.message : String(birdError)}`
        : 'Bird returned no text'
    const nitterNote = nitterUrl
      ? nitterError
        ? `Nitter failed: ${nitterError instanceof Error ? nitterError.message : String(nitterError)}`
        : 'Nitter returned no text'
      : 'Nitter not available'
    throw new Error(`Unable to fetch tweet content from X. ${birdNote}. ${nitterNote}.`)
  }
  return htmlResult
}

async function buildResultFromFirecrawl({
  url,
  payload,
  cacheMode,
  maxCharacters,
  youtubeTranscriptMode,
  firecrawlDiagnostics,
  markdownRequested,
  deps,
}: {
  url: string
  payload: FirecrawlScrapeResult
  cacheMode: FetchLinkContentOptions['cacheMode']
  maxCharacters: number | null
  youtubeTranscriptMode: FetchLinkContentOptions['youtubeTranscript']
  firecrawlDiagnostics: FirecrawlDiagnostics
  markdownRequested: boolean
  deps: LinkPreviewDeps
}): Promise<ExtractedLinkContent | null> {
  const normalizedMarkdown = normalizeForPrompt(payload.markdown ?? '')
  if (normalizedMarkdown.length === 0) {
    firecrawlDiagnostics.notes = appendNote(
      firecrawlDiagnostics.notes,
      'Firecrawl markdown normalization yielded empty text'
    )
    return null
  }

  const jsonLd = payload.html ? extractJsonLdContent(payload.html) : null
  const isPodcastJsonLd = isPodcastLikeJsonLdType(jsonLd?.type)

  const transcriptResolution = await resolveTranscriptForLink(url, payload.html ?? null, deps, {
    youtubeTranscriptMode,
    cacheMode,
  })
  const htmlMetadata = payload.html
    ? extractMetadataFromHtml(payload.html, url)
    : { title: null, description: null, siteName: null }
  const metadata = extractMetadataFromFirecrawl(payload.metadata ?? null)

  const title = pickFirstText([jsonLd?.title, metadata.title, htmlMetadata.title])
  const description = pickFirstText([
    jsonLd?.description,
    metadata.description,
    htmlMetadata.description,
  ])
  const siteName = pickFirstText([metadata.siteName, htmlMetadata.siteName, safeHostname(url)])

  const descriptionCandidate = description ? normalizeForPrompt(description) : ''
  const preferDescription =
    descriptionCandidate.length >= MIN_METADATA_DESCRIPTION_CHARACTERS &&
    (isPodcastJsonLd ||
      isPodcastHost(url) ||
      normalizedMarkdown.length < MIN_HTML_CONTENT_CHARACTERS ||
      descriptionCandidate.length >= normalizedMarkdown.length * READABILITY_RELATIVE_THRESHOLD)
  const baseCandidate = preferDescription ? descriptionCandidate : normalizedMarkdown
  const baseContent = selectBaseContent(baseCandidate, transcriptResolution.text)
  if (baseContent.length === 0) {
    firecrawlDiagnostics.notes = appendNote(
      firecrawlDiagnostics.notes,
      'Firecrawl produced content that normalized to an empty string'
    )
    return null
  }

  firecrawlDiagnostics.used = true

  const transcriptDiagnostics = ensureTranscriptDiagnostics(
    transcriptResolution,
    cacheMode ?? 'default'
  )

  const video = payload.html ? detectPrimaryVideoFromHtml(payload.html, url) : null
  const isVideoOnly =
    !transcriptResolution.text &&
    normalizedMarkdown.length < MIN_HTML_CONTENT_CHARACTERS &&
    video !== null

  return finalizeExtractedLinkContent({
    url,
    baseContent,
    maxCharacters,
    title,
    description,
    siteName,
    transcriptResolution,
    video,
    isVideoOnly,
    diagnostics: {
      strategy: 'firecrawl',
      firecrawl: firecrawlDiagnostics,
      markdown: {
        requested: markdownRequested,
        used: true,
        provider: 'firecrawl',
      },
      transcript: transcriptDiagnostics,
    },
  })
}

async function buildResultFromHtmlDocument({
  url,
  html,
  cacheMode,
  maxCharacters,
  youtubeTranscriptMode,
  firecrawlDiagnostics,
  markdownRequested,
  markdownMode,
  timeoutMs,
  deps,
  readabilityCandidate,
}: {
  url: string
  html: string
  cacheMode: FetchLinkContentOptions['cacheMode']
  maxCharacters: number | null
  youtubeTranscriptMode: FetchLinkContentOptions['youtubeTranscript']
  firecrawlDiagnostics: FirecrawlDiagnostics
  markdownRequested: boolean
  markdownMode: MarkdownMode
  timeoutMs: number
  deps: LinkPreviewDeps
  readabilityCandidate: Awaited<ReturnType<typeof extractReadabilityFromHtml>> | null
}): Promise<ExtractedLinkContent> {
  if (isYouTubeVideoUrl(url) && !extractYouTubeVideoId(url)) {
    throw new Error('Invalid YouTube video id in URL')
  }

  const { title, description, siteName } = extractMetadataFromHtml(html, url)
  const jsonLd = extractJsonLdContent(html)
  const mergedTitle = pickFirstText([jsonLd?.title, title])
  const mergedDescription = pickFirstText([jsonLd?.description, description])
  const isPodcastJsonLd = isPodcastLikeJsonLdType(jsonLd?.type)
  const readability = readabilityCandidate ?? (await extractReadabilityFromHtml(html, url))
  const readabilityText = readability?.text ? normalizeForPrompt(readability.text) : ''
  const readabilityHtml = toReadabilityHtml(readability)

  const normalizedSegmentsFromHtml = normalizeForPrompt(extractArticleContent(html))
  const normalizedSegmentsFromReadabilityHtml = readabilityHtml
    ? normalizeForPrompt(extractArticleContent(readabilityHtml))
    : ''
  const preferReadabilityHtml =
    normalizedSegmentsFromReadabilityHtml.length >= MIN_READABILITY_CONTENT_CHARACTERS &&
    (normalizedSegmentsFromHtml.length < MIN_HTML_CONTENT_CHARACTERS ||
      normalizedSegmentsFromReadabilityHtml.length >=
        normalizedSegmentsFromHtml.length * READABILITY_RELATIVE_THRESHOLD)
  const normalizedSegments = preferReadabilityHtml
    ? normalizedSegmentsFromReadabilityHtml
    : normalizedSegmentsFromHtml

  const preferReadabilityText =
    !preferReadabilityHtml &&
    readabilityText.length >= MIN_READABILITY_CONTENT_CHARACTERS &&
    (normalizedSegmentsFromHtml.length < MIN_HTML_CONTENT_CHARACTERS ||
      readabilityText.length >= normalizedSegmentsFromHtml.length * READABILITY_RELATIVE_THRESHOLD)
  const preferReadability = preferReadabilityHtml || preferReadabilityText
  const effectiveNormalized = preferReadabilityText ? readabilityText : normalizedSegments
  const descriptionCandidate = mergedDescription ? normalizeForPrompt(mergedDescription) : ''
  const preferDescription =
    descriptionCandidate.length >= MIN_METADATA_DESCRIPTION_CHARACTERS &&
    (isPodcastJsonLd ||
      isPodcastHost(url) ||
      (!preferReadability &&
        (effectiveNormalized.length < MIN_HTML_CONTENT_CHARACTERS ||
          descriptionCandidate.length >=
            effectiveNormalized.length * READABILITY_RELATIVE_THRESHOLD)))
  const effectiveNormalizedWithDescription = preferDescription
    ? descriptionCandidate
    : effectiveNormalized
  const transcriptResolution = await resolveTranscriptForLink(url, html, deps, {
    youtubeTranscriptMode,
    cacheMode,
  })

  const youtubeDescription =
    transcriptResolution.text === null ? extractYouTubeShortDescription(html) : null
  const baseCandidate = youtubeDescription
    ? normalizeForPrompt(youtubeDescription)
    : effectiveNormalizedWithDescription

  let baseContent = selectBaseContent(baseCandidate, transcriptResolution.text)
  if (baseContent === normalizedSegments) {
    baseContent = stripLeadingTitle(baseContent, mergedTitle ?? title)
  }

  const transcriptDiagnostics = ensureTranscriptDiagnostics(
    transcriptResolution,
    cacheMode ?? 'default'
  )

  const markdownDiagnostics: MarkdownDiagnostics = await (async () => {
    if (!markdownRequested) {
      return { requested: false, used: false, provider: null, notes: null }
    }

    if (isYouTubeUrl(url)) {
      return {
        requested: true,
        used: false,
        provider: null,
        notes: 'Skipping Markdown conversion for YouTube URLs',
      }
    }

    if (!deps.convertHtmlToMarkdown) {
      return {
        requested: true,
        used: false,
        provider: null,
        notes: 'No HTML→Markdown converter configured',
      }
    }

    try {
      const htmlForMarkdown =
        markdownMode === 'readability' && readabilityHtml ? readabilityHtml : html
      const sanitizedHtml = sanitizeHtmlForMarkdownConversion(htmlForMarkdown)
      const markdown = await deps.convertHtmlToMarkdown({
        url,
        html: sanitizedHtml,
        title: mergedTitle ?? title,
        siteName,
        timeoutMs,
      })
      const normalizedMarkdown = normalizeForPrompt(markdown)
      if (normalizedMarkdown.length === 0) {
        return {
          requested: true,
          used: false,
          provider: null,
          notes: 'HTML→Markdown conversion returned empty content',
        }
      }

      baseContent = normalizedMarkdown
      return {
        requested: true,
        used: true,
        provider: 'llm',
        notes:
          markdownMode === 'readability' && readabilityHtml
            ? 'Readability HTML used for markdown input'
            : null,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        requested: true,
        used: false,
        provider: null,
        notes: `HTML→Markdown conversion failed: ${message}`,
      }
    }
  })()

  const video = detectPrimaryVideoFromHtml(html, url)
  const isVideoOnly =
    !transcriptResolution.text && baseContent.length < MIN_HTML_CONTENT_CHARACTERS && video !== null

  return finalizeExtractedLinkContent({
    url,
    baseContent,
    maxCharacters,
    title: mergedTitle ?? title,
    description: mergedDescription ?? description,
    siteName,
    transcriptResolution,
    video,
    isVideoOnly,
    diagnostics: {
      strategy: 'html',
      firecrawl: firecrawlDiagnostics,
      markdown: markdownDiagnostics,
      transcript: transcriptDiagnostics,
    },
  })
}

export type { ExtractedLinkContent, FetchLinkContentOptions } from './types.js'
