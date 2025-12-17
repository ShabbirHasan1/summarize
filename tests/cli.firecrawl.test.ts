import { describe, expect, it, vi } from 'vitest'

import { createFirecrawlScraper } from '../packages/cli/src/firecrawl.js'

describe('createFirecrawlScraper', () => {
  it('returns markdown/html/metadata when successful', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      expect(url).toBe('https://api.firecrawl.dev/v1/scrape')
      expect(init?.method).toBe('POST')
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer KEY',
        'Content-Type': 'application/json',
      })

      return Response.json(
        {
          success: true,
          data: {
            markdown: '# Hello',
            html: '<html></html>',
            metadata: { title: 'T' },
          },
        },
        { status: 200 }
      )
    })

    const scrape = createFirecrawlScraper({
      apiKey: 'KEY',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    const result = await scrape('https://example.com', { timeoutMs: 1000 })

    expect(result).toEqual({
      markdown: '# Hello',
      html: '<html></html>',
      metadata: { title: 'T' },
    })
  })

  it('returns null when markdown is empty', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ success: true, data: { markdown: '   ', html: null, metadata: null } })
    )

    const scrape = createFirecrawlScraper({
      apiKey: 'KEY',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    await expect(scrape('https://example.com')).resolves.toBeNull()
  })

  it('throws an error when Firecrawl returns non-2xx with error payload', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ success: false, error: 'nope' }, { status: 403 })
    )

    const scrape = createFirecrawlScraper({
      apiKey: 'KEY',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    await expect(scrape('https://example.com')).rejects.toThrow(
      'Firecrawl request failed (403): nope'
    )
  })

  it('throws a timeout error when aborted', async () => {
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal
        return new Promise((_resolve, reject) => {
          if (!signal) {
            reject(new Error('Missing abort signal'))
            return
          }
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }) as Promise<Response>
      })

      const scrape = createFirecrawlScraper({
        apiKey: 'KEY',
        fetchImpl: fetchMock as unknown as typeof fetch,
      })

      const promise = scrape('https://example.com', { timeoutMs: 10 })
      const assertion = expect(promise).rejects.toThrow('Firecrawl request timed out')
      await vi.advanceTimersByTimeAsync(20)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
