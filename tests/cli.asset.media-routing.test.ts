import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { withUrlAsset } from '../src/run/flows/asset/input.js'

describe('media URL routing', () => {
  it('routes direct media URLs with query parameters to transcription', async () => {
    const stderr = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })
    const summarizeMediaFile = vi.fn(async () => {})
    const ctx = {
      env: {},
      stderr,
      progressEnabled: false,
      timeoutMs: 1000,
      trackedFetch: vi.fn(async () => {
        throw new Error('fetch should not be called')
      }) as unknown as typeof fetch,
      summarizeAsset: vi.fn(async () => {
        throw new Error('summarizeAsset should not be called')
      }),
      summarizeMediaFile,
      setClearProgressBeforeStdout: vi.fn(),
      clearProgressIfCurrent: vi.fn(),
    }

    const handled = await withUrlAsset(
      ctx,
      'https://example.com/audio.mp3?token=abc',
      false,
      async () => {
        throw new Error('handler should not be called')
      }
    )

    expect(handled).toBe(true)
    expect(summarizeMediaFile).toHaveBeenCalledTimes(1)
  })
})
