import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

function collectStream() {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { stream, getText: () => text }
}

vi.mock('../src/llm/generate-text.js', () => ({
  generateTextWithModelId: vi.fn(async () => ({ text: 'OK' })),
  streamTextWithModelId: vi.fn(async () => {
    throw new Error('unexpected stream call')
  }),
}))

describe('refresh-free', () => {
  it('writes models.free and shows total runs (1 + runs)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-refresh-free-'))
    mkdirSync(join(root, '.summarize'), { recursive: true })

    const stdout = collectStream()
    const stderr = collectStream()

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini', context_length: 1234 },
            { id: 'google/gemma-3-27b-it:free', name: 'Gemma 27B', context_length: 5678 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    await runCli(['refresh-free', '--min-params', '0b'], {
      env: { HOME: root, OPENROUTER_API_KEY: 'test' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    })

    expect(stderr.getText()).toMatch(/Refresh Free: found 2 :free models; testing \(runs=3/i)
    const configPath = join(root, '.summarize', 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      models?: { free?: { rules?: Array<{ candidates?: string[] }> } }
    }
    expect(config.models?.free?.rules?.[0]?.candidates?.length).toBeGreaterThan(0)
    expect(stdout.getText()).toMatch(/Wrote .*config\.json/i)
  })

  it('accepts --runs 0 (no refine pass)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-refresh-free-'))
    mkdirSync(join(root, '.summarize'), { recursive: true })

    const stdout = collectStream()
    const stderr = collectStream()

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [{ id: 'google/gemma-3-27b-it:free' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    await runCli(['refresh-free', '--runs', '0', '--min-params', '0b'], {
      env: { HOME: root, OPENROUTER_API_KEY: 'test' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    })

    expect(stderr.getText()).toMatch(/testing \(runs=1/i)
    expect(stderr.getText()).not.toMatch(/refining .*extra runs/i)
  })

  it('backs off on rateLimitMin and retries once', async () => {
    vi.useFakeTimers()
    try {
      const { generateTextWithModelId } = await import('../src/llm/generate-text.js')
      const mock = generateTextWithModelId as unknown as ReturnType<typeof vi.fn>

      let calls = 0
      mock.mockImplementation(async () => {
        calls += 1
        if (calls === 1) {
          throw new Error('Rate limit exceeded: free-models-per-min.')
        }
        return { text: 'OK' }
      })

      const root = mkdtempSync(join(tmpdir(), 'summarize-refresh-free-'))
      mkdirSync(join(root, '.summarize'), { recursive: true })

      const stdout = collectStream()
      const stderr = collectStream()

      const fetchMock = vi.fn(async () => {
        return new Response(JSON.stringify({ data: [{ id: 'google/gemma-3-27b-it:free' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      })

      const promise = runCli(['refresh-free', '--runs', '0', '--min-params', '0b', '--verbose'], {
        env: { HOME: root, OPENROUTER_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })

      await vi.advanceTimersByTimeAsync(70_000)
      await promise

      expect(calls).toBe(2)
      expect(stderr.getText()).toMatch(/rate limit hit; sleeping/i)
      expect(stdout.getText()).toMatch(/Wrote .*config\.json/i)
    } finally {
      vi.useRealTimers()
    }
  })
})

