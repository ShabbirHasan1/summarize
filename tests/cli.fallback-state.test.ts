import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  readLastSuccessfulCliProvider,
  writeLastSuccessfulCliProvider,
} from '../src/run/cli-fallback-state.js'

describe('run/cli-fallback-state', () => {
  it('stores and restores the last successful CLI provider', async () => {
    const home = mkdtempSync(join(tmpdir(), 'summarize-cli-fallback-state-'))
    expect(await readLastSuccessfulCliProvider({ HOME: home })).toBeNull()

    await writeLastSuccessfulCliProvider({
      env: { HOME: home },
      provider: 'claude',
    })
    expect(await readLastSuccessfulCliProvider({ HOME: home })).toBe('claude')
  })

  it('supports USERPROFILE when HOME is unset', async () => {
    const userProfile = mkdtempSync(join(tmpdir(), 'summarize-cli-fallback-profile-'))
    await writeLastSuccessfulCliProvider({
      env: { USERPROFILE: userProfile },
      provider: 'agent',
    })
    expect(await readLastSuccessfulCliProvider({ USERPROFILE: userProfile })).toBe('agent')
  })

  it('ignores invalid stored providers', async () => {
    const home = mkdtempSync(join(tmpdir(), 'summarize-cli-fallback-invalid-'))
    const dir = join(home, '.summarize')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cli-state.json'), JSON.stringify({ lastSuccessfulProvider: 'nope' }))
    expect(await readLastSuccessfulCliProvider({ HOME: home })).toBeNull()
  })
})
