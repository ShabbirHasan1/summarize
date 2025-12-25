import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const streamTextMock = vi.fn(() => {
  throw new Error('should not be called')
})

vi.mock('ai', () => ({
  streamText: streamTextMock,
}))

function collectStream({ isTTY }: { isTTY: boolean }) {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  ;(stream as unknown as { isTTY?: boolean }).isTTY = isTTY
  ;(stream as unknown as { columns?: number }).columns = 120
  return { stream, getText: () => text }
}

function stripOsc(text: string): string {
  // OSC ... ST
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch !== '\u001b' || text[i + 1] !== ']') {
      out += ch
      continue
    }

    i += 2
    while (i < text.length) {
      const c = text[i]
      if (c === '\u0007') break
      if (c === '\u001b' && text[i + 1] === '\\') {
        i += 1
        break
      }
      i += 1
    }
  }
  return out
}

function stripCsi(text: string): string {
  // Remove CSI sequences we don't simulate here (cursor show/hide, SGR, etc).
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch !== '\u001b' || text[i + 1] !== '[') {
      out += ch
      continue
    }

    i += 2
    while (i < text.length) {
      const c = text[i]
      if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) break
      i += 1
    }
  }
  return out
}

function applyCarriageReturnAndClearLine(text: string): string {
  // Minimal terminal model:
  // - \r resets current line.
  // - CSI 2K clears current line.
  const CSI_2K = '\u001b[2K'
  let currentLine = ''
  const lines: string[] = []

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') {
      lines.push(currentLine)
      currentLine = ''
      continue
    }
    if (ch === '\r') {
      currentLine = ''
      continue
    }
    if (text.startsWith(CSI_2K, i)) {
      currentLine = ''
      i += CSI_2K.length - 1
      continue
    }
    currentLine += ch
  }
  if (currentLine.length > 0) lines.push(currentLine)
  return lines.join('\n')
}

// Deterministic spinner: write the initial text once; stop/clear are no-ops.
vi.mock('ora', () => {
  const ora = (opts: { text: string; stream: NodeJS.WritableStream }) => {
    const spinner = {
      isSpinning: true,
      text: opts.text,
      stop() {
        spinner.isSpinning = false
      },
      clear() {},
      start() {
        opts.stream.write(`- ${spinner.text}`)
        return spinner
      },
    }
    return spinner
  }
  return { default: ora }
})

describe('cli spinner output', () => {
  it('clears the "Loading file" spinner line (no scrollback junk) and includes file size', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-spinner-file-'))
    const pdfPath = join(root, 'test.pdf')
    const buf = Buffer.alloc(1536, 0)
    buf.write('%PDF-1.7\n', 0, 'utf8')
    writeFileSync(pdfPath, buf)

    const stdout = collectStream({ isTTY: true })
    const stderr = collectStream({ isTTY: true })

    await expect(
      runCli(['--model', 'xai/grok-4-fast-non-reasoning', '--timeout', '2s', pdfPath], {
        env: { HOME: root, XAI_API_KEY: 'test', TERM: 'xterm-256color' },
        fetch: vi.fn(async () => {
          throw new Error('unexpected fetch')
        }) as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      })
    ).rejects.toThrow(/does not support attaching files/i)

    const rawErr = stderr.getText()
    expect(rawErr).toContain('Loading file (1.5 KB)')
    expect(rawErr).toContain('\r\u001b[2K')

    const visibleErr = applyCarriageReturnAndClearLine(stripCsi(stripOsc(rawErr)))
    expect(visibleErr).not.toMatch(/Loading file/i)
    // When calling `runCli` directly, errors are thrown (not printed). We only assert
    // that the spinner line is cleared and does not pollute scrollback.
  })

  it('clears the "Fetching website" spinner line (no scrollback junk)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-spinner-web-'))
    const stdout = collectStream({ isTTY: true })
    const stderr = collectStream({ isTTY: true })

    await runCli(['--extract', '--format', 'text', '--timeout', '2s', 'https://example.com'], {
      env: { HOME: root, TERM: 'xterm-256color' },
      fetch: vi.fn(async () => {
        return new Response('<html><body><h1>Example</h1></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }) as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    })

    const rawErr = stderr.getText()
    expect(rawErr).toContain('Fetching website')
    expect(rawErr).not.toContain('Transcript')
    expect(rawErr).toContain('\r\u001b[2K')

    const visibleErr = applyCarriageReturnAndClearLine(stripCsi(stripOsc(rawErr)))
    expect(visibleErr).not.toMatch(/Fetching website/i)
  })

  it('switches OSC progress to indeterminate for summarizing', async () => {
    vi.useRealTimers()
    const root = mkdtempSync(join(tmpdir(), 'summarize-spinner-osc-'))
    const stdout = collectStream({ isTTY: true })
    const stderr = collectStream({ isTTY: true })

    await runCli(['--timeout', '2s', 'https://example.com'], {
      env: { HOME: root, TERM_PROGRAM: 'wezterm', TERM: 'xterm-256color' },
      fetch: vi.fn(async () => {
        return new Response('<html><body><h1>Example</h1></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }) as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    })

    const rawErr = stderr.getText()
    expect(rawErr).toContain('\u001b]9;4;3;;Summarizing')
  }, 15_000)
})
