import { describe, expect, it } from 'vitest'

import { SUMMARY_LENGTHS as INDEX_LENGTHS } from '../packages/summarizer/src/index.js'
import { SUMMARY_LENGTHS as CONTRACT_LENGTHS } from '../packages/summarizer/src/shared/contracts.js'

describe('summarizer entrypoints', () => {
  it('exports summary length presets', () => {
    expect(INDEX_LENGTHS).toEqual(['short', 'medium', 'long', 'xl', 'xxl'])
    expect(CONTRACT_LENGTHS).toEqual(['short', 'medium', 'long', 'xl', 'xxl'])
  })
})
