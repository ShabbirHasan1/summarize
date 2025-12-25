import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import type { ExecFileFn } from '../src/markitdown.js'
import { runCli } from '../src/run.js'

describe('cli --extract finish line label', () => {
  it('prints extraction label (no via footer) in --extract mode', async () => {
    const html =
      '<!doctype html><html><head><title>Ok</title></head>' +
      '<body><nav><ul><li>Noise</li></ul></nav><article><h1>Title</h1><p>Hello</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const execFileMock = vi.fn((file, args, _opts, cb) => {
      expect(file).toBe('uvx')
      expect(args.slice(0, 3)).toEqual(['--from', 'markitdown[all]', 'markitdown'])
      cb(null, '# Converted\n\nHello\n', '')
    })

    const stderrChunks: string[] = []
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrChunks.push(chunk.toString())
        callback()
      },
    })

    await runCli(
      [
        '--extract',
        '--metrics',
        'on',
        '--timeout',
        '2s',
        'https://example.com',
      ],
      {
        env: { UVX_PATH: 'uvx' },
        fetch: fetchMock as unknown as typeof fetch,
        execFile: execFileMock as unknown as ExecFileFn,
        stdout: new Writable({
          write(_chunk, _encoding, callback) {
            callback()
          },
        }),
        stderr,
      }
    )

    const err = stderrChunks.join('')
    expect(err).toContain('markdown via readability')
    expect(err).not.toContain('\nvia ')
    expect(err).not.toContain('$')
  })

  it('does not spend tokens for markdown conversion by default (even with OPENAI_API_KEY)', async () => {
    const html =
      '<!doctype html><html><head><title>Ok</title></head>' +
      '<body><article><h1>Title</h1><p>Hello</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const execFileMock = vi.fn((_file, _args, _opts, cb) => {
      cb(null, '# Converted\n\nHello\n', '')
    })

    const stderrChunks: string[] = []
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrChunks.push(chunk.toString())
        callback()
      },
    })

    await runCli(
      [
        '--extract',
        '--metrics',
        'on',
        '--timeout',
        '2s',
        'https://example.com',
      ],
      {
        env: { OPENAI_API_KEY: 'test', UVX_PATH: 'uvx' },
        fetch: fetchMock as unknown as typeof fetch,
        execFile: execFileMock as unknown as ExecFileFn,
        stdout: new Writable({
          write(_chunk, _encoding, callback) {
            callback()
          },
        }),
        stderr,
      }
    )

    const err = stderrChunks.join('')
    expect(err).toContain('markdown via readability')
    expect(err).not.toContain('$')
  })
})
