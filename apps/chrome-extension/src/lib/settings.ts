import {
  defaultColorMode,
  defaultColorScheme,
  normalizeColorMode,
  normalizeColorScheme,
  type ColorMode,
  type ColorScheme,
} from './theme'

export type Settings = {
  token: string
  autoSummarize: boolean
  model: string
  length: string
  language: string
  promptOverride: string
  maxChars: number
  fontFamily: string
  fontSize: number
  colorScheme: ColorScheme
  colorMode: ColorMode
}

const storageKey = 'settings'

const legacyFontFamilyMap = new Map<string, string>([
  [
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif',
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  ],
])

function normalizeFontFamily(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.fontFamily
  const trimmed = value.trim()
  if (!trimmed) return defaultSettings.fontFamily
  return legacyFontFamilyMap.get(trimmed) ?? trimmed
}

function normalizeModel(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.model
  const trimmed = value.trim()
  if (!trimmed) return defaultSettings.model
  const lowered = trimmed.toLowerCase()
  if (lowered === 'auto' || lowered === 'free') return lowered
  return trimmed
}

function normalizeLength(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.length
  const trimmed = value.trim()
  if (!trimmed) return defaultSettings.length
  const lowered = trimmed.toLowerCase()
  if (lowered === 's') return 'short'
  if (lowered === 'm') return 'medium'
  if (lowered === 'l') return 'long'
  return lowered
}

function normalizeLanguage(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.language
  const trimmed = value.trim()
  if (!trimmed) return defaultSettings.language
  return trimmed
}

function normalizePromptOverride(value: unknown): string {
  if (typeof value !== 'string') return defaultSettings.promptOverride
  return value
}

export const defaultSettings: Settings = {
  token: '',
  autoSummarize: true,
  model: 'auto',
  length: 'xl',
  language: 'auto',
  promptOverride: '',
  maxChars: 120_000,
  fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  fontSize: 14,
  colorScheme: defaultColorScheme,
  colorMode: defaultColorMode,
}

export async function loadSettings(): Promise<Settings> {
  const res = await chrome.storage.local.get(storageKey)
  const raw = (res[storageKey] ?? {}) as Partial<Settings>
  return {
    ...defaultSettings,
    ...raw,
    token: typeof raw.token === 'string' ? raw.token : defaultSettings.token,
    model: normalizeModel(raw.model),
    length: normalizeLength(raw.length),
    language: normalizeLanguage(raw.language),
    promptOverride: normalizePromptOverride(raw.promptOverride),
    autoSummarize:
      typeof raw.autoSummarize === 'boolean' ? raw.autoSummarize : defaultSettings.autoSummarize,
    maxChars: typeof raw.maxChars === 'number' ? raw.maxChars : defaultSettings.maxChars,
    fontFamily: normalizeFontFamily(raw.fontFamily),
    fontSize: typeof raw.fontSize === 'number' ? raw.fontSize : defaultSettings.fontSize,
    colorScheme: normalizeColorScheme(raw.colorScheme),
    colorMode: normalizeColorMode(raw.colorMode),
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({
    [storageKey]: {
      ...settings,
      model: normalizeModel(settings.model),
      length: normalizeLength(settings.length),
      language: normalizeLanguage(settings.language),
      promptOverride: normalizePromptOverride(settings.promptOverride),
      fontFamily: normalizeFontFamily(settings.fontFamily),
      colorScheme: normalizeColorScheme(settings.colorScheme),
      colorMode: normalizeColorMode(settings.colorMode),
    },
  })
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings()
  const next = { ...current, ...patch }
  await saveSettings(next)
  return next
}
