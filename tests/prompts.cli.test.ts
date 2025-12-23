import { describe, expect, it } from 'vitest'

import { buildPathSummaryPrompt } from '../src/prompts/index.js'

describe('buildPathSummaryPrompt', () => {
  it('builds a prompt for file summaries with soft length', () => {
    const prompt = buildPathSummaryPrompt({
      kindLabel: 'file',
      filePath: '/tmp/notes.md',
      filename: 'notes.md',
      mediaType: 'text/markdown',
      summaryLength: { maxCharacters: 12_345 },
    })

    expect(prompt).toContain('You summarize files')
    expect(prompt).toContain('Path: /tmp/notes.md')
    expect(prompt).toContain('Filename: notes.md')
    expect(prompt).toContain('Media type: text/markdown')
    expect(prompt).toContain('Target length: around 12,345 characters total')
  })

  it('builds a prompt for images without optional headers', () => {
    const prompt = buildPathSummaryPrompt({
      kindLabel: 'image',
      filePath: '/tmp/photo.jpg',
      filename: null,
      mediaType: null,
      summaryLength: 'short',
    })

    expect(prompt).toContain('You summarize images')
    expect(prompt).toContain('Path: /tmp/photo.jpg')
    expect(prompt).not.toContain('Filename:')
    expect(prompt).not.toContain('Media type:')
    expect(prompt).not.toContain('Target length:')
  })
})
