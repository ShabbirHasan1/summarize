import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type SummarizeConfig = {
  /**
   * Gateway-style model id, e.g.:
   * - google/gemini-3-flash-preview
   * - openai/gpt-5.2
   * - google/gemini-2.0-flash
   */
  model?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function loadSummarizeConfig({ env }: { env: Record<string, string | undefined> }): {
  config: SummarizeConfig | null
  path: string | null
} {
  const home = env.HOME?.trim() || homedir()
  if (!home) return { config: null, path: null }
  const path = join(home, '.summarize', 'config.json')

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { config: null, path }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON in config file ${path}: ${message}`)
  }

  if (!isRecord(parsed)) {
    throw new Error(`Invalid config file ${path}: expected an object at the top level`)
  }

  const model = typeof parsed.model === 'string' ? parsed.model : undefined
  return { config: { model }, path }
}
