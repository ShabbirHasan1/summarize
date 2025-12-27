import MarkdownIt from 'markdown-it'

import { loadSettings, patchSettings } from '../../lib/settings'
import { parseSseStream } from '../../lib/sse'
import { generateToken } from '../../lib/token'

type PanelToBg =
  | { type: 'panel:ready' }
  | { type: 'panel:summarize' }
  | { type: 'panel:ping' }
  | { type: 'panel:closed' }
  | { type: 'panel:rememberUrl'; url: string }
  | { type: 'panel:setAuto'; value: boolean }
  | { type: 'panel:setModel'; value: string }
  | { type: 'panel:openOptions' }

type UiState = {
  panelOpen: boolean
  daemon: { ok: boolean; authed: boolean; error?: string }
  tab: { url: string | null; title: string | null }
  settings: { autoSummarize: boolean; model: string; tokenPresent: boolean }
  status: string
}

type RunStart = {
  id: string
  url: string
  title: string | null
  model: string
  reason: string
}

type BgToPanel =
  | { type: 'ui:state'; state: UiState }
  | { type: 'ui:status'; status: string }
  | { type: 'run:start'; run: RunStart }
  | { type: 'run:error'; message: string }

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el as T
}

const subtitleEl = byId<HTMLDivElement>('subtitle')
const drawerEl = byId<HTMLElement>('drawer')
const setupEl = byId<HTMLDivElement>('setup')
const statusEl = byId<HTMLDivElement>('status')
const statusTextEl = byId<HTMLSpanElement>('statusText')
const statusPctEl = byId<HTMLSpanElement>('statusPct')
const renderEl = byId<HTMLElement>('render')
const metricsEl = byId<HTMLDivElement>('metrics')

const summarizeBtn = byId<HTMLButtonElement>('summarize')
const drawerToggleBtn = byId<HTMLButtonElement>('drawerToggle')
const advancedBtn = byId<HTMLButtonElement>('advanced')
const autoEl = byId<HTMLInputElement>('auto')
const modelEl = byId<HTMLInputElement>('model')
const fontEl = byId<HTMLSelectElement>('font')
const sizeEl = byId<HTMLInputElement>('size')

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
})

let markdown = ''
let renderQueued = 0
let currentState: UiState | null = null
let currentSource: { url: string; title: string | null } | null = null
let streamController: AbortController | null = null
let streamedAnyNonWhitespace = false
let rememberedUrl = false
let streaming = false

function ensureSelectValue(select: HTMLSelectElement, value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) {
    const fallback = select.options[0]?.value ?? ''
    if (fallback) select.value = fallback
    if (select.selectedIndex === -1 && select.options.length > 0) select.selectedIndex = 0
    return fallback
  }

  if (!Array.from(select.options).some((o) => o.value === normalized)) {
    const label = normalized.split(',')[0]?.replace(/["']/g, '').trim() || 'Custom'
    const option = document.createElement('option')
    option.value = normalized
    option.textContent = `Custom (${label})`
    select.append(option)
  }

  select.value = normalized
  if (select.selectedIndex === -1 && select.options.length > 0) select.selectedIndex = 0
  return normalized
}

function extractTrailingPercent(input: string): {
  text: string
  percent: string | null
  raw: string
} {
  const raw = input
  const trimmed = input.trim()
  if (!trimmed) return { text: '', percent: null, raw }

  // Match "... 34%" or "... (34%)" at the end, and split it out for a stronger visual treatment.
  const m = trimmed.match(/^(?<text>.*?)(?:\s*[([]?(?<pct>\d{1,3})%[)\]]?)\s*$/)
  if (!m?.groups) return { text: trimmed, percent: null, raw }
  const pctNum = Number(m.groups.pct)
  if (!Number.isFinite(pctNum) || pctNum < 0 || pctNum > 100)
    return { text: trimmed, percent: null, raw }
  const text = (m.groups.text ?? '').trim()
  if (!text) return { text: trimmed, percent: null, raw }
  return { text, percent: `${pctNum}%`, raw }
}

function setStatus(text: string) {
  const split = extractTrailingPercent(text)
  statusTextEl.textContent = split.text
  statusPctEl.textContent = split.percent ?? ''

  const isError =
    split.raw.toLowerCase().startsWith('error:') || split.raw.toLowerCase().includes(' error')
  statusEl.classList.toggle('error', isError)
  statusEl.classList.toggle('running', Boolean(split.raw.trim()) && !isError)
  statusEl.classList.toggle('hidden', !split.raw.trim())
}

window.addEventListener('error', (event) => {
  const message =
    event.error instanceof Error ? event.error.stack || event.error.message : event.message
  setStatus(`Error: ${message}`)
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = (event as PromiseRejectionEvent).reason
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason)
  setStatus(`Error: ${message}`)
})

function queueRender() {
  if (renderQueued) return
  renderQueued = window.setTimeout(() => {
    renderQueued = 0
    try {
      renderEl.innerHTML = md.render(markdown)
    } catch (err) {
      const message = err instanceof Error ? err.stack || err.message : String(err)
      setStatus(`Error: ${message}`)
      return
    }
    for (const a of Array.from(renderEl.querySelectorAll('a'))) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    }
  }, 80)
}

function mergeStreamText(current: string, incoming: string): string {
  if (!incoming) return current
  if (!current) return incoming

  // Some providers stream cumulative buffers; prefer replacement if the incoming chunk contains everything so far.
  if (incoming.length >= current.length && incoming.startsWith(current)) {
    return incoming
  }

  // Overlap-merge to avoid duplicated tails/heads.
  const maxOverlap = Math.min(current.length, incoming.length, 2000)
  for (let overlap = maxOverlap; overlap >= 8; overlap -= 1) {
    if (current.endsWith(incoming.slice(0, overlap))) {
      return current + incoming.slice(overlap)
    }
  }

  return current + incoming
}

function applyTypography(fontFamily: string, fontSize: number) {
  document.documentElement.style.setProperty('--font-body', fontFamily)
  document.documentElement.style.setProperty('--font-size', `${fontSize}px`)
}

function friendlyFetchError(err: unknown, context: string): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.toLowerCase() === 'failed to fetch') {
    return `${context}: Failed to fetch (daemon unreachable or blocked by Chrome; try \`summarize daemon status\`, maybe \`summarize daemon restart\`, and check ~/.summarize/logs/daemon.err.log)`
  }
  return `${context}: ${message}`
}

async function ensureToken(): Promise<string> {
  const settings = await loadSettings()
  if (settings.token.trim()) return settings.token.trim()
  const token = generateToken()
  await patchSettings({ token })
  return token
}

function renderSetup(token: string) {
  setupEl.classList.remove('hidden')
  const cmd = `summarize daemon install --token ${token}`
  setupEl.innerHTML = `
    <h2>Setup</h2>
    <p>Install the local daemon (LaunchAgent) so the side panel can stream summaries.</p>
    <code>${cmd}</code>
    <div class="row">
      <button id="copy" type="button">Copy Install Command</button>
      <button id="regen" type="button">Regenerate Token</button>
    </div>
  `
  const copyBtn = setupEl.querySelector<HTMLButtonElement>('#copy')
  const regenBtn = setupEl.querySelector<HTMLButtonElement>('#regen')
  copyBtn?.addEventListener('click', () => {
    void (async () => {
      await navigator.clipboard.writeText(cmd)
      setStatus('Copied')
      setTimeout(() => setStatus(currentState?.status ?? ''), 800)
    })()
  })
  regenBtn?.addEventListener('click', () => {
    void (async () => {
      const token2 = generateToken()
      await patchSettings({ token: token2 })
      renderSetup(token2)
    })()
  })
}

function maybeShowSetup(state: UiState) {
  if (!state.settings.tokenPresent) {
    void (async () => {
      const token = await ensureToken()
      renderSetup(token)
    })()
    return
  }
  if (!state.daemon.ok || !state.daemon.authed) {
    setupEl.classList.remove('hidden')
    const token = (async () => (await loadSettings()).token.trim())()
    void token.then((t) => {
      const cmd = `summarize daemon install --token ${t}`
      setupEl.innerHTML = `
        <h2>Daemon not reachable</h2>
        <p>${state.daemon.error ?? 'Check that the LaunchAgent is installed.'}</p>
        <p>Try:</p>
        <code>${cmd}</code>
        <div class="row">
          <button id="copy" type="button">Copy Install Command</button>
          <button id="status" type="button">Copy Status Command</button>
          <button id="restart" type="button">Copy Restart Command</button>
        </div>
      `
      setupEl.querySelector<HTMLButtonElement>('#copy')?.addEventListener('click', () => {
        void (async () => {
          await navigator.clipboard.writeText(cmd)
        })()
      })
      setupEl.querySelector<HTMLButtonElement>('#status')?.addEventListener('click', () => {
        void (async () => {
          await navigator.clipboard.writeText('summarize daemon status')
        })()
      })
      setupEl.querySelector<HTMLButtonElement>('#restart')?.addEventListener('click', () => {
        void (async () => {
          await navigator.clipboard.writeText('summarize daemon restart')
        })()
      })
    })
    return
  }
  setupEl.classList.add('hidden')
}

function updateControls(state: UiState) {
  autoEl.checked = state.settings.autoSummarize
  modelEl.value = state.settings.model
  if (currentSource && state.tab.url && state.tab.url !== currentSource.url && !streaming) {
    currentSource = null
  }
  if (!currentSource) subtitleEl.textContent = state.tab.title || state.tab.url || ''
  setStatus(state.status)
  maybeShowSetup(state)
}

function handleBgMessage(msg: BgToPanel) {
  switch (msg.type) {
    case 'ui:state':
      currentState = msg.state
      updateControls(msg.state)
      return
    case 'ui:status':
      setStatus(msg.status)
      return
    case 'run:error':
      setStatus(`Error: ${msg.message}`)
      return
    case 'run:start':
      void startStream(msg.run)
      return
  }
}

function send(message: PanelToBg) {
  void chrome.runtime.sendMessage(message).catch(() => {
    // ignore (panel/background race while reloading)
  })
}

function toggleDrawer(force?: boolean) {
  const next = typeof force === 'boolean' ? force : drawerEl.classList.contains('hidden')
  drawerEl.classList.toggle('hidden', !next)
}

summarizeBtn.addEventListener('click', () => send({ type: 'panel:summarize' }))
drawerToggleBtn.addEventListener('click', () => toggleDrawer())
advancedBtn.addEventListener('click', () => send({ type: 'panel:openOptions' }))

autoEl.addEventListener('change', () => send({ type: 'panel:setAuto', value: autoEl.checked }))
modelEl.addEventListener('change', () =>
  send({ type: 'panel:setModel', value: modelEl.value.trim() || 'auto' })
)

fontEl.addEventListener('change', () => {
  void (async () => {
    const next = await patchSettings({ fontFamily: fontEl.value })
    applyTypography(next.fontFamily, next.fontSize)
  })()
})

sizeEl.addEventListener('input', () => {
  void (async () => {
    const next = await patchSettings({ fontSize: Number(sizeEl.value) })
    applyTypography(next.fontFamily, next.fontSize)
  })()
})

void (async () => {
  const s = await loadSettings()
  const fontFamily = ensureSelectValue(fontEl, s.fontFamily)
  if (fontFamily !== s.fontFamily) await patchSettings({ fontFamily })
  sizeEl.value = String(s.fontSize)
  modelEl.value = s.model
  autoEl.checked = s.autoSummarize
  applyTypography(fontEl.value, s.fontSize)
  toggleDrawer(false)
  chrome.runtime.onMessage.addListener((msg: BgToPanel) => {
    handleBgMessage(msg)
  })
  send({ type: 'panel:ready' })
})()

setInterval(() => {
  send({ type: 'panel:ping' })
}, 25_000)

window.addEventListener('beforeunload', () => {
  send({ type: 'panel:closed' })
})

async function startStream(run: RunStart) {
  const token = (await loadSettings()).token.trim()
  if (!token) {
    setStatus('Setup required (missing token)')
    return
  }

  streamController?.abort()
  const controller = new AbortController()
  streamController = controller
  streaming = true
  streamedAnyNonWhitespace = false
  rememberedUrl = false
  currentSource = { url: run.url, title: run.title }

  markdown = ''
  renderEl.innerHTML = ''
  metricsEl.textContent = ''
  metricsEl.classList.add('hidden')
  metricsEl.removeAttribute('data-details')
  metricsEl.removeAttribute('title')
  subtitleEl.textContent = run.title || run.url
  setStatus('Connecting…')

  try {
    const res = await fetch(`http://127.0.0.1:8787/v1/summarize/${run.id}/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    if (!res.body) throw new Error('Missing stream body')

    setStatus('Summarizing…')

    for await (const msg of parseSseStream(res.body)) {
      if (controller.signal.aborted) return

      if (msg.event === 'chunk') {
        const data = JSON.parse(msg.data) as { text: string }
        const merged = mergeStreamText(markdown, data.text)
        if (merged !== markdown) {
          markdown = merged
          queueRender()
        }

        if (!streamedAnyNonWhitespace && data.text.trim().length > 0) {
          streamedAnyNonWhitespace = true
          if (!rememberedUrl) {
            rememberedUrl = true
            send({ type: 'panel:rememberUrl', url: run.url })
          }
        }
      } else if (msg.event === 'meta') {
        const data = JSON.parse(msg.data) as { model: string }
        const title = currentSource?.title || currentState?.tab.title || 'Current tab'
        subtitleEl.textContent = `${title} · ${data.model}`
      } else if (msg.event === 'status') {
        const data = JSON.parse(msg.data) as { text: string }
        if (!streamedAnyNonWhitespace) setStatus(data.text)
      } else if (msg.event === 'metrics') {
        const data = JSON.parse(msg.data) as {
          summary: string
          details: string | null
          summaryDetailed: string
          detailsDetailed: string | null
          elapsedMs: number
        }
        metricsEl.textContent = data.summary
        const tooltipParts = [data.summaryDetailed, data.detailsDetailed, data.details]
          .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          .slice(0, 2)
        const tooltip = tooltipParts.join('\n')
        if (tooltip) {
          metricsEl.setAttribute('title', tooltip)
          metricsEl.setAttribute('data-details', '1')
        }
        metricsEl.classList.remove('hidden')
      } else if (msg.event === 'error') {
        const data = JSON.parse(msg.data) as { message: string }
        throw new Error(data.message)
      } else if (msg.event === 'done') {
        break
      }
    }

    if (!streamedAnyNonWhitespace) {
      throw new Error('Model returned no output.')
    }

    setStatus('')
  } catch (err) {
    if (controller.signal.aborted) return
    const message = friendlyFetchError(err, 'Stream failed')
    setStatus(`Error: ${message}`)
  } finally {
    if (streamController === controller) streaming = false
  }
}
