import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../packages/cli/src/run.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

describe('cli --extract-only', () => {
  it('prints full extracted content (no truncation) and never calls OpenAI', async () => {
    const body = 'A'.repeat(60_000)
    const html =
      '<!doctype html><html><head><title>Ok</title></head>' +
      `<body><article><p>${body}</p></article></body></html>`

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return htmlResponse(html)
      }
      if (url === 'https://api.openai.com/v1/chat/completions') {
        throw new Error('Unexpected OpenAI call in --extract-only mode')
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    let stdoutText = ''
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString()
        callback()
      },
    })

    await runCli(['--extract-only', '--timeout', '2s', 'https://example.com'], {
      env: { OPENAI_API_KEY: 'test' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout,
      stderr: new Writable({
        write(_chunk, _encoding, cb) {
          cb()
        },
      }),
    })

    expect(stdoutText.length).toBeGreaterThanOrEqual(59_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
