import { describe, expect, it } from 'vitest'

import {
  countWords,
  estimateDurationSecondsFromWords,
  formatInputSummary,
} from '../src/daemon/meta.js'

describe('daemon/meta', () => {
  describe('countWords', () => {
    it('counts words with whitespace normalization', () => {
      expect(countWords('')).toBe(0)
      expect(countWords('   ')).toBe(0)
      expect(countWords('hello')).toBe(1)
      expect(countWords('hello   world\n\nok')).toBe(3)
    })
  })

  describe('formatInputSummary', () => {
    it('formats website input lengths', () => {
      expect(
        formatInputSummary({
          kindLabel: null,
          durationSeconds: null,
          words: 1234,
          characters: 12000,
        })
      ).toBe('1.2k words · 12k chars')
    })

    it('formats media input with approximate duration', () => {
      expect(
        formatInputSummary({
          kindLabel: 'YouTube',
          durationSeconds: 600,
          isDurationApproximate: true,
          words: 1700,
          characters: 10200,
        })
      ).toBe('10 min YouTube · 1.7k words · 10k chars')
    })

    it('does not round word-derived duration to whole minutes', () => {
      const durationSeconds = estimateDurationSecondsFromWords(401)
      expect(
        formatInputSummary({
          kindLabel: 'YouTube',
          durationSeconds,
          isDurationApproximate: true,
          words: 401,
          characters: null,
        })
      ).toBe('2.5 min YouTube · 401 words')
    })

    it('includes kind label without duration', () => {
      expect(
        formatInputSummary({
          kindLabel: 'YouTube',
          durationSeconds: null,
          words: 1200,
          characters: null,
        })
      ).toBe('YouTube · 1.2k words')
    })
  })
})
