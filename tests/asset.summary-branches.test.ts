import { Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  prepareAssetPrompt: vi.fn(),
  runModelAttempts: vi.fn(),
}))

vi.mock('../src/run/flows/asset/preprocess.js', () => ({
  prepareAssetPrompt: mocks.prepareAssetPrompt,
}))
vi.mock('../src/run/model-attempts.js', () => ({
  runModelAttempts: mocks.runModelAttempts,
}))

import { summarizeAsset } from '../src/run/flows/asset/summary.js'

const collectStream = () => {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { stream, getText: () => text }
}

const createContext = (overrides: Partial<Parameters<typeof summarizeAsset>[0]> = {}) => {
  const stdout = collectStream()
  const stderr = collectStream()
  const writeViaFooter = vi.fn()
  const ctx = {
    env: {},
    envForRun: {},
    stdout: stdout.stream,
    stderr: stderr.stream,
    execFileImpl: async () => ({ ok: true, stdout: '', stderr: '' }),
    timeoutMs: 1000,
    preprocessMode: 'off' as const,
    format: 'text' as const,
    extractMode: false,
    lengthArg: { kind: 'preset' as const, preset: 'xl' as const },
    forceSummary: false,
    outputLanguage: { kind: 'auto' as const },
    videoMode: 'auto' as const,
    fixedModelSpec: null,
    promptOverride: null,
    lengthInstruction: null,
    languageInstruction: null,
    isFallbackModel: true,
    isImplicitAutoSelection: true,
    allowAutoCliFallback: false,
    desiredOutputTokens: null,
    envForAuto: {},
    configForModelSelection: null,
    cliAvailability: {},
    requestedModel: { kind: 'auto' as const },
    requestedModelInput: 'auto',
    requestedModelLabel: 'auto',
    wantsFreeNamedModel: false,
    isNamedModelSelection: false,
    maxOutputTokensArg: null,
    json: false,
    metricsEnabled: false,
    metricsDetailed: false,
    shouldComputeReport: false,
    runStartedAtMs: Date.now(),
    verbose: false,
    verboseColor: false,
    streamingEnabled: false,
    plain: true,
    summaryEngine: {
      applyZaiOverrides: (attempt) => attempt,
    } as Parameters<typeof summarizeAsset>[0]['summaryEngine'],
    trackedFetch: globalThis.fetch.bind(globalThis),
    writeViaFooter,
    clearProgressForStdout: vi.fn(),
    restoreProgressAfterStdout: vi.fn(),
    getLiteLlmCatalog: async () => ({ catalog: [] }),
    buildReport: async () => ({ tokens: 0, calls: 0, durationMs: 0 }),
    estimateCostUsd: async () => null,
    llmCalls: [],
    cache: { mode: 'default', store: null },
    apiStatus: {
      xaiApiKey: null,
      apiKey: null,
      openrouterApiKey: null,
      apifyToken: null,
      firecrawlConfigured: false,
      googleConfigured: false,
      anthropicConfigured: false,
      providerBaseUrls: { openai: null, anthropic: null, google: null, xai: null },
      zaiApiKey: null,
      zaiBaseUrl: '',
    },
  }
  return {
    ctx: { ...ctx, ...overrides },
    stdout,
    stderr,
    writeViaFooter,
  }
}

describe('asset summary early branches', () => {
  beforeEach(() => {
    mocks.prepareAssetPrompt.mockReset()
    mocks.runModelAttempts.mockReset()
  })

  it('bypasses short content for auto models', async () => {
    mocks.prepareAssetPrompt.mockResolvedValue({
      promptText: 'Prompt',
      attachments: [],
      assetFooterParts: [],
      textContent: { content: 'Short text.' },
    })

    const { ctx, stdout, writeViaFooter } = createContext()

    await summarizeAsset(ctx, {
      sourceKind: 'file',
      sourceLabel: '/tmp/note.txt',
      attachment: {
        kind: 'file',
        mediaType: 'text/plain',
        filename: 'note.txt',
        bytes: new Uint8Array([1]),
      },
    })

    expect(stdout.getText()).toContain('Short text.')
    expect(writeViaFooter).not.toHaveBeenCalled()
  })

  it('bypasses short content for video attachments', async () => {
    mocks.prepareAssetPrompt.mockResolvedValue({
      promptText: 'Prompt',
      attachments: [],
      assetFooterParts: [],
      textContent: { content: 'Video snippet.' },
    })

    const { ctx, stdout } = createContext({ videoMode: 'auto' })

    await summarizeAsset(ctx, {
      sourceKind: 'file',
      sourceLabel: '/tmp/clip.mp4',
      attachment: {
        kind: 'file',
        mediaType: 'video/mp4',
        filename: 'clip.mp4',
        bytes: new Uint8Array([1]),
      },
    })

    expect(stdout.getText()).toContain('Video snippet.')
  })

  it('bypasses short content for image attachments', async () => {
    mocks.prepareAssetPrompt.mockResolvedValue({
      promptText: 'Prompt',
      attachments: [],
      assetFooterParts: [],
      textContent: { content: 'Image snippet.' },
    })

    const { ctx, stdout } = createContext()

    await summarizeAsset(ctx, {
      sourceKind: 'file',
      sourceLabel: '/tmp/image.png',
      attachment: {
        kind: 'file',
        mediaType: 'image/png',
        filename: 'image.png',
        bytes: new Uint8Array([1]),
      },
    })

    expect(stdout.getText()).toContain('Image snippet.')
  })

  it('skips the model when content fits max output tokens', async () => {
    mocks.prepareAssetPrompt.mockResolvedValue({
      promptText: 'Prompt',
      attachments: [],
      assetFooterParts: ['mock'],
      textContent: { content: 'Hello world' },
    })

    const { ctx, stdout, writeViaFooter } = createContext({
      lengthArg: { kind: 'chars', maxCharacters: 5 },
      maxOutputTokensArg: 500,
    })

    await summarizeAsset(ctx, {
      sourceKind: 'file',
      sourceLabel: '/tmp/note.txt',
      attachment: {
        kind: 'file',
        mediaType: 'text/plain',
        filename: 'note.txt',
        bytes: new Uint8Array([1]),
      },
    })

    expect(stdout.getText()).toContain('Hello world')
    expect(writeViaFooter).toHaveBeenCalledWith(['mock', 'no model'])
  })

  it('renders JSON for asset URLs when model attempts succeed', async () => {
    mocks.prepareAssetPrompt.mockResolvedValue({
      promptText: 'Prompt',
      attachments: [],
      assetFooterParts: [],
      textContent: null,
    })
    mocks.runModelAttempts.mockResolvedValue({
      result: {
        summary: 'Model summary.',
        summaryAlreadyPrinted: false,
        modelMeta: { provider: 'openai', canonical: 'openai/gpt-5.2' },
        maxOutputTokensForCall: null,
      },
      usedAttempt: {
        transport: 'native',
        userModelId: 'openai/gpt-5.2',
        llmModelId: 'gpt-5.2',
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: 'OPENAI_API_KEY',
      },
      missingRequiredEnvs: new Set(),
      lastError: null,
      sawOpenRouterNoAllowedProviders: false,
    })

    const { ctx, stdout } = createContext({ json: true })

    await summarizeAsset(ctx, {
      sourceKind: 'asset-url',
      sourceLabel: 'https://example.com/video.mp4',
      attachment: {
        kind: 'file',
        mediaType: 'application/octet-stream',
        filename: 'video.mp4',
        bytes: new Uint8Array([1]),
      },
    })

    const payload = JSON.parse(stdout.getText()) as {
      input: { kind: string }
      summary?: string
      llm?: { provider?: string }
    }
    expect(payload.input.kind).toBe('asset-url')
    expect(payload.summary).toBe('Model summary.')
    expect(payload.llm?.provider).toBe('openai')
  })

  it('writes JSON when short content is bypassed', async () => {
    mocks.prepareAssetPrompt.mockResolvedValue({
      promptText: 'Prompt',
      attachments: [],
      assetFooterParts: [],
      textContent: { content: 'Short text.' },
    })

    const { ctx, stdout } = createContext({ json: true })

    await summarizeAsset(ctx, {
      sourceKind: 'file',
      sourceLabel: '/tmp/note.txt',
      attachment: {
        kind: 'file',
        mediaType: 'text/plain',
        filename: 'note.txt',
        bytes: new Uint8Array([1]),
      },
    })

    const payload = JSON.parse(stdout.getText()) as { summary?: string; llm?: unknown }
    expect(payload.summary).toContain('Short text.')
    expect(payload.llm).toBeNull()
  })

  it('adds via footer when short content includes asset footer parts', async () => {
    mocks.prepareAssetPrompt.mockResolvedValue({
      promptText: 'Prompt',
      attachments: [],
      assetFooterParts: ['mock'],
      textContent: { content: 'Short text.' },
    })

    const { ctx, stdout, writeViaFooter } = createContext()

    await summarizeAsset(ctx, {
      sourceKind: 'file',
      sourceLabel: '/tmp/note.txt',
      attachment: {
        kind: 'file',
        mediaType: 'text/plain',
        filename: 'note.txt',
        bytes: new Uint8Array([1]),
      },
    })

    expect(stdout.getText()).toContain('Short text.')
    expect(writeViaFooter).toHaveBeenCalledWith(['mock', 'short content'])
  })

  it('renders short content with TTY markdown when plain is off', async () => {
    mocks.prepareAssetPrompt.mockResolvedValue({
      promptText: 'Prompt',
      attachments: [],
      assetFooterParts: [],
      textContent: { content: '# Heading' },
    })

    const { ctx } = createContext({ plain: false })
    const out = collectStream()
    ;(out.stream as unknown as { isTTY?: boolean }).isTTY = true
    ctx.stdout = out.stream

    await summarizeAsset(ctx, {
      sourceKind: 'file',
      sourceLabel: '/tmp/note.txt',
      attachment: {
        kind: 'file',
        mediaType: 'text/plain',
        filename: 'note.txt',
        bytes: new Uint8Array([1]),
      },
    })

    expect(out.getText()).toContain('Heading')
  })

  it('emits metrics finish line when enabled', async () => {
    mocks.prepareAssetPrompt.mockResolvedValue({
      promptText: 'Prompt',
      attachments: [],
      assetFooterParts: [],
      textContent: { content: 'Short text.' },
    })

    const { ctx, stderr } = createContext({
      metricsEnabled: true,
      shouldComputeReport: true,
      buildReport: async () => ({
        llm: [],
        services: { firecrawl: { requests: 0 }, apify: { requests: 0 } },
      }),
      estimateCostUsd: async () => 0,
    })

    await summarizeAsset(ctx, {
      sourceKind: 'file',
      sourceLabel: '/tmp/note.txt',
      attachment: {
        kind: 'file',
        mediaType: 'text/plain',
        filename: 'note.txt',
        bytes: new Uint8Array([1]),
      },
    })

    expect(stderr.getText().length).toBeGreaterThan(0)
  })

  it('falls back to content when model attempts fail', async () => {
    mocks.prepareAssetPrompt.mockResolvedValue({
      promptText: 'Prompt',
      attachments: [],
      assetFooterParts: [],
      textContent: { content: 'Fallback content.' },
    })
    mocks.runModelAttempts.mockResolvedValue({
      result: null,
      usedAttempt: null,
      missingRequiredEnvs: new Set(),
      lastError: null,
      sawOpenRouterNoAllowedProviders: false,
    })

    const { ctx, stdout } = createContext({ forceSummary: true })

    await summarizeAsset(ctx, {
      sourceKind: 'file',
      sourceLabel: '/tmp/note.txt',
      attachment: {
        kind: 'file',
        mediaType: 'text/plain',
        filename: 'note.txt',
        bytes: new Uint8Array([1]),
      },
    })

    expect(stdout.getText()).toContain('Fallback content.')
  })
})
