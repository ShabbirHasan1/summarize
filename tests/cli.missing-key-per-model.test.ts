import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const noopStream = () =>
  new Writable({
    write(chunk, encoding, callback) {
      void chunk
      void encoding
      callback()
    },
  })

describe('cli missing API key errors', () => {
  it('errors when --model openai/... is set without OPENAI_API_KEY', async () => {
    const html = `<!doctype html><html><head><title>Ok</title></head><body><article><p>${'A'.repeat(
      260
    )}</p></article></body></html>`

    await expect(
      runCli(['--model', 'openai/gpt-5.2', '--timeout', '2s', 'https://example.com'], {
        env: {},
        fetch: vi.fn(async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/Missing OPENAI_API_KEY/)
  })

  it('errors when --model google/... is set without GOOGLE_GENERATIVE_AI_API_KEY', async () => {
    const html = `<!doctype html><html><head><title>Ok</title></head><body><article><p>${'A'.repeat(
      260
    )}</p></article></body></html>`

    await expect(
      runCli(['--model', 'google/gemini-2.0-flash', '--timeout', '2s', 'https://example.com'], {
        env: {},
        fetch: vi.fn(async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/Missing GOOGLE_GENERATIVE_AI_API_KEY/)
  })

  it('errors when --model anthropic/... is set without ANTHROPIC_API_KEY', async () => {
    const html = `<!doctype html><html><head><title>Ok</title></head><body><article><p>${'A'.repeat(
      260
    )}</p></article></body></html>`

    await expect(
      runCli(['--model', 'anthropic/claude-sonnet-4-5', '--timeout', '2s', 'https://example.com'], {
        env: {},
        fetch: vi.fn(async () => new Response(html, { status: 200 })) as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      })
    ).rejects.toThrow(/Missing ANTHROPIC_API_KEY/)
  })
})
