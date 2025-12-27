import { describe, expect, it, vi } from 'vitest'

import { resolveTwitterCookies } from '../src/run/cookies/twitter.js'

describe('twitter cookies resolver (CLI)', () => {
  it('uses explicit tokens without touching browsers', async () => {
    const getCookiesImpl = vi.fn(async () => ({ cookies: [], warnings: [] }))

    const res = await resolveTwitterCookies({
      env: {},
      authToken: 'auth',
      ct0: 'csrf',
      getCookiesImpl,
    })
    expect(res.cookies.cookieHeader).toBe('auth_token=auth; ct0=csrf')
    expect(res.cookies.source).toBe('CLI argument')
    expect(getCookiesImpl).not.toHaveBeenCalled()
  })

  it('uses env vars without touching browsers', async () => {
    const getCookiesImpl = vi.fn(async () => ({ cookies: [], warnings: [] }))

    const res = await resolveTwitterCookies({
      env: { AUTH_TOKEN: 'auth', CT0: 'csrf' },
      getCookiesImpl,
    })
    expect(res.cookies.cookieHeader).toBe('auth_token=auth; ct0=csrf')
    expect(res.cookies.source).toBe('env AUTH_TOKEN')
    expect(getCookiesImpl).not.toHaveBeenCalled()
  })

  it('returns the first browser with both cookies', async () => {
    const getCookiesImpl = vi.fn(async (options) => {
      const browser = options.browsers?.[0]
      if (browser === 'safari') {
        return {
          cookies: [
            { name: 'auth_token', value: 'a' },
            { name: 'ct0', value: 'c' },
          ],
          warnings: [],
        }
      }
      return { cookies: [], warnings: [] }
    })

    const res = await resolveTwitterCookies({
      env: {},
      cookieSource: ['safari', 'chrome', 'firefox'],
      getCookiesImpl,
    })
    expect(res.cookies.source).toBe('Safari')
    expect(res.cookies.cookieHeader).toBe('auth_token=a; ct0=c')
    expect(getCookiesImpl).toHaveBeenCalledTimes(1)
  })

  it('uses cookie source order from env vars', async () => {
    const getCookiesImpl = vi.fn(async (options) => {
      const browser = options.browsers?.[0]
      if (browser !== 'firefox') return { cookies: [], warnings: [] }
      expect(options.firefoxProfile).toBe('default-release')
      return {
        cookies: [
          { name: 'auth_token', value: 'a' },
          { name: 'ct0', value: 'c' },
        ],
        warnings: [],
      }
    })

    const res = await resolveTwitterCookies({
      env: {
        TWITTER_COOKIE_SOURCE: 'firefox, chrome',
        TWITTER_FIREFOX_PROFILE: 'default-release',
      },
      getCookiesImpl,
    })
    expect(res.cookies.source).toBe('Firefox (default-release)')
    expect(getCookiesImpl).toHaveBeenCalledTimes(1)
  })

  it('falls back to the next browser when needed', async () => {
    const getCookiesImpl = vi.fn(async (options) => {
      const browser = options.browsers?.[0]
      if (browser === 'safari') return { cookies: [], warnings: ['nope'] }
      if (browser === 'chrome') {
        return {
          cookies: [
            { name: 'auth_token', value: 'a' },
            { name: 'ct0', value: 'c' },
          ],
          warnings: [],
        }
      }
      return { cookies: [], warnings: [] }
    })

    const res = await resolveTwitterCookies({
      env: {},
      cookieSource: ['safari', 'chrome'],
      getCookiesImpl,
    })
    expect(res.cookies.source).toBe('Chrome')
    expect(res.warnings).toContain('nope')
    expect(getCookiesImpl).toHaveBeenCalledTimes(2)
  })

  it('returns warnings when no cookies are found', async () => {
    const getCookiesImpl = vi.fn(async () => ({ cookies: [], warnings: [] }))

    const res = await resolveTwitterCookies({
      env: {},
      cookieSource: ['safari'],
      getCookiesImpl,
    })
    expect(res.cookies.cookieHeader).toBeNull()
    expect(res.warnings.join('\n')).toContain('Missing auth_token')
    expect(res.warnings.join('\n')).toContain('Missing ct0')
  })
})
