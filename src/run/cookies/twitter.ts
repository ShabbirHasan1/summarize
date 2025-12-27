import type { BrowserName, GetCookiesOptions, GetCookiesResult } from '@steipete/sweet-cookie'

export type TwitterCookies = {
  authToken: string | null
  ct0: string | null
  cookieHeader: string | null
  source: string | null
}

export type CookieExtractionResult = {
  cookies: TwitterCookies
  warnings: string[]
}

const DEFAULT_SOURCES: BrowserName[] = ['chrome', 'safari', 'firefox']
const TWITTER_COOKIE_NAMES = ['auth_token', 'ct0'] as const
const TWITTER_ORIGINS = ['https://x.com', 'https://twitter.com'] as const

const ENV_COOKIE_SOURCE_KEYS = ['TWITTER_COOKIE_SOURCE'] as const
const ENV_CHROME_PROFILE_KEYS = ['TWITTER_CHROME_PROFILE'] as const
const ENV_FIREFOX_PROFILE_KEYS = ['TWITTER_FIREFOX_PROFILE'] as const

function normalizeValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseCookieSourceList(value: string, warnings: string[]): BrowserName[] | undefined {
  const tokens = value
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
  if (tokens.length === 0) return undefined

  const result: BrowserName[] = []
  for (const token of tokens) {
    if (token === 'safari' || token === 'chrome' || token === 'firefox') {
      if (!result.includes(token)) result.push(token)
      continue
    }
    warnings.push(`Unknown cookie source "${token}" in TWITTER_COOKIE_SOURCE`)
  }

  return result.length > 0 ? result : undefined
}

function resolveEnvCookieSource(
  env: Record<string, string | undefined>,
  warnings: string[]
): BrowserName[] | undefined {
  for (const key of ENV_COOKIE_SOURCE_KEYS) {
    const value = normalizeValue(env[key])
    if (value) return parseCookieSourceList(value, warnings)
  }
  return undefined
}

function resolveEnvProfile(
  env: Record<string, string | undefined>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = normalizeValue(env[key])
    if (value) return value
  }
  return undefined
}

function formatBrowserSourceLabel(browser: BrowserName, profile?: string): string {
  if (browser === 'chrome') return profile ? `Chrome (${profile})` : 'Chrome'
  if (browser === 'firefox') return profile ? `Firefox (${profile})` : 'Firefox'
  return 'Safari'
}

type GetCookiesFn = (options: GetCookiesOptions) => Promise<GetCookiesResult>

export async function resolveTwitterCookies({
  env,
  authToken,
  ct0,
  cookieSource,
  chromeProfile,
  firefoxProfile,
  getCookiesImpl,
}: {
  env: Record<string, string | undefined>
  authToken?: string
  ct0?: string
  cookieSource?: BrowserName | BrowserName[]
  chromeProfile?: string
  firefoxProfile?: string
  getCookiesImpl?: GetCookiesFn
}): Promise<CookieExtractionResult> {
  const warnings: string[] = []
  const cookies: TwitterCookies = {
    authToken: null,
    ct0: null,
    cookieHeader: null,
    source: null,
  }

  const envCookieSource = resolveEnvCookieSource(env, warnings)
  const envChromeProfile = resolveEnvProfile(env, ENV_CHROME_PROFILE_KEYS)
  const envFirefoxProfile = resolveEnvProfile(env, ENV_FIREFOX_PROFILE_KEYS)

  const effectiveCookieSource = cookieSource ?? envCookieSource
  const effectiveChromeProfile = chromeProfile ?? envChromeProfile
  const effectiveFirefoxProfile = firefoxProfile ?? envFirefoxProfile

  if (authToken) {
    cookies.authToken = authToken
    cookies.source = 'CLI argument'
  }
  if (ct0) {
    cookies.ct0 = ct0
    if (!cookies.source) cookies.source = 'CLI argument'
  }

  const envAuthKeys = ['AUTH_TOKEN', 'TWITTER_AUTH_TOKEN'] as const
  const envCt0Keys = ['CT0', 'TWITTER_CT0'] as const

  if (!cookies.authToken) {
    for (const key of envAuthKeys) {
      const value = normalizeValue(env[key])
      if (value) {
        cookies.authToken = value
        cookies.source = `env ${key}`
        break
      }
    }
  }

  if (!cookies.ct0) {
    for (const key of envCt0Keys) {
      const value = normalizeValue(env[key])
      if (value) {
        cookies.ct0 = value
        if (!cookies.source) cookies.source = `env ${key}`
        break
      }
    }
  }

  if (cookies.authToken && cookies.ct0) {
    cookies.cookieHeader = `auth_token=${cookies.authToken}; ct0=${cookies.ct0}`
    return { cookies, warnings }
  }

  const sourcesToTry: BrowserName[] = Array.isArray(effectiveCookieSource)
    ? effectiveCookieSource
    : effectiveCookieSource
      ? [effectiveCookieSource]
      : DEFAULT_SOURCES

  const getCookiesFn: GetCookiesFn =
    getCookiesImpl ?? (await import('@steipete/sweet-cookie')).getCookies

  for (const source of sourcesToTry) {
    const result = await getCookiesFn({
      url: 'https://x.com',
      origins: [...TWITTER_ORIGINS],
      names: [...TWITTER_COOKIE_NAMES],
      browsers: [source],
      chromeProfile: effectiveChromeProfile,
      firefoxProfile: effectiveFirefoxProfile,
    })

    warnings.push(...result.warnings)

    const auth = result.cookies.find((c) => c.name === 'auth_token')?.value ?? null
    const csrf = result.cookies.find((c) => c.name === 'ct0')?.value ?? null

    if (auth && csrf) {
      const browserLabel =
        source === 'chrome'
          ? formatBrowserSourceLabel(source, effectiveChromeProfile)
          : source === 'firefox'
            ? formatBrowserSourceLabel(source, effectiveFirefoxProfile)
            : formatBrowserSourceLabel(source)
      return {
        cookies: {
          authToken: auth,
          ct0: csrf,
          cookieHeader: `auth_token=${auth}; ct0=${csrf}`,
          source: browserLabel,
        },
        warnings,
      }
    }
  }

  if (!cookies.authToken) {
    warnings.push(
      'Missing auth_token - provide via AUTH_TOKEN env var, or login to x.com in Safari/Chrome/Firefox'
    )
  }
  if (!cookies.ct0) {
    warnings.push(
      'Missing ct0 - provide via CT0 env var, or login to x.com in Safari/Chrome/Firefox'
    )
  }

  return { cookies, warnings }
}
