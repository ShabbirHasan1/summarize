import type { LlmTokenUsage } from './llm/generate-text.js'

export type LlmProvider = 'xai' | 'openai' | 'google' | 'anthropic'

export type LlmCall = {
  provider: LlmProvider
  model: string
  usage: LlmTokenUsage | null
  purpose: 'summary' | 'chunk-notes' | 'markdown'
}

export type LlmPerTokenPricing = {
  inputUsdPerToken: number
  outputUsdPerToken: number
}

export type RunCostReport = {
  llm: Array<{
    provider: LlmProvider
    model: string
    calls: number
    promptTokens: number | null
    completionTokens: number | null
    totalTokens: number | null
    estimatedUsd: number | null
  }>
  services: {
    firecrawl: { requests: number; estimatedUsd: number | null }
    apify: { requests: number; estimatedUsd: number | null }
  }
  totalEstimatedUsd: number | null
}

function sumOrNull(values: Array<number | null>): number | null {
  let sum = 0
  let any = false
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      sum += value
      any = true
    }
  }
  return any ? sum : null
}

function estimateLlmUsd({
  pricing,
  usage,
}: {
  pricing: LlmPerTokenPricing | null
  usage: { promptTokens: number | null; completionTokens: number | null }
}): number | null {
  if (!pricing) return null
  if (usage.promptTokens === null || usage.completionTokens === null) return null
  const inputUsd = usage.promptTokens * pricing.inputUsdPerToken
  const outputUsd = usage.completionTokens * pricing.outputUsdPerToken
  return inputUsd + outputUsd
}

export function buildRunCostReport({
  llmCalls,
  firecrawlRequests,
  apifyRequests,
  resolveLlmPricing,
}: {
  llmCalls: LlmCall[]
  firecrawlRequests: number
  apifyRequests: number
  resolveLlmPricing: (modelId: string) => LlmPerTokenPricing | null
}): RunCostReport {
  const llmMap = new Map<
    string,
    {
      provider: LlmProvider
      model: string
      calls: number
      promptTokens: Array<number | null>
      completionTokens: Array<number | null>
      totalTokens: Array<number | null>
    }
  >()

  for (const call of llmCalls) {
    const key = `${call.provider}:${call.model}`
    const existing = llmMap.get(key)
    const promptTokens = call.usage?.promptTokens ?? null
    const completionTokens = call.usage?.completionTokens ?? null
    const totalTokens = call.usage?.totalTokens ?? null
    if (!existing) {
      llmMap.set(key, {
        provider: call.provider,
        model: call.model,
        calls: 1,
        promptTokens: [promptTokens],
        completionTokens: [completionTokens],
        totalTokens: [totalTokens],
      })
      continue
    }
    existing.calls += 1
    existing.promptTokens.push(promptTokens)
    existing.completionTokens.push(completionTokens)
    existing.totalTokens.push(totalTokens)
  }

  const llm = Array.from(llmMap.values()).map((row) => {
    const promptTokens = sumOrNull(row.promptTokens)
    const completionTokens = sumOrNull(row.completionTokens)
    const totalTokens = sumOrNull(row.totalTokens)
    const estimatedUsd = estimateLlmUsd({
      pricing: resolveLlmPricing(row.model),
      usage: { promptTokens, completionTokens },
    })
    return {
      provider: row.provider,
      model: row.model,
      calls: row.calls,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedUsd,
    }
  })

  const firecrawlEstimatedUsd = null
  const apifyEstimatedUsd = null

  const totalEstimatedUsd = (() => {
    const pieces: Array<number | null> = [
      sumOrNull(llm.map((row) => row.estimatedUsd)),
      firecrawlEstimatedUsd,
      apifyEstimatedUsd,
    ]
    const total = sumOrNull(pieces)
    return total
  })()

  return {
    llm,
    services: {
      firecrawl: { requests: firecrawlRequests, estimatedUsd: firecrawlEstimatedUsd },
      apify: { requests: apifyRequests, estimatedUsd: apifyEstimatedUsd },
    },
    totalEstimatedUsd,
  }
}
