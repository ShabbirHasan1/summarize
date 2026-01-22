import { splitStatusPercent } from '../../lib/status'
import type { PanelPhase } from './types'

type HeaderState = {
  phase: PanelPhase
  summaryFromCache: boolean | null
}

export type HeaderController = {
  setBaseTitle: (text: string) => void
  setBaseSubtitle: (text: string) => void
  setStatus: (text: string) => void
  armProgress: () => void
  stopProgress: () => void
  setProgressOverride: (next: boolean) => void
  updateHeaderOffset: () => void
}

export function createHeaderController({
  headerEl,
  titleEl,
  subtitleEl,
  progressFillEl,
  getState,
}: {
  headerEl: HTMLElement
  titleEl: HTMLElement
  subtitleEl: HTMLElement
  progressFillEl: HTMLElement
  getState: () => HeaderState
}): HeaderController {
  let baseTitle = 'Summarize'
  let baseSubtitle = ''
  let statusText = ''
  let showProgress = false
  let progressOverride = false
  let rafId: number | null = null
  let lastTitle = ''
  let lastSubtitle = ''
  let lastIsError = false
  let lastIsRunning = false
  let lastIsIndeterminate = false
  let lastProgress = ''
  let lastProgressDisplay = ''

  const shouldAllowProgress = (force = false) =>
    force || progressOverride || getState().summaryFromCache !== true

  const isActiveStatus = (text: string) => {
    const trimmed = text.trim().toLowerCase()
    if (!trimmed) return false
    if (trimmed.startsWith('error:')) return false
    if (trimmed === 'copied') return false
    return (
      trimmed.startsWith('extracting') ||
      trimmed.startsWith('connecting') ||
      trimmed.startsWith('summarizing') ||
      trimmed.startsWith('sending') ||
      trimmed.startsWith('slides:') ||
      trimmed.startsWith('downloading') ||
      trimmed.startsWith('transcribing') ||
      trimmed.startsWith('processing') ||
      trimmed.startsWith('refreshing') ||
      trimmed.startsWith('starting') ||
      trimmed.startsWith('scanning') ||
      trimmed.includes('whisper') ||
      trimmed.includes('transcript') ||
      trimmed.includes('caption')
    )
  }

  const renderHeader = () => {
    const { phase } = getState()
    const isStreaming = phase === 'connecting' || phase === 'streaming'
    const trimmed = statusText.trim()
    const showStatus = trimmed.length > 0
    const split = showStatus
      ? splitStatusPercent(trimmed)
      : { text: '', percent: null as string | null }
    const percentNum = split.percent ? Number.parseInt(split.percent, 10) : null
    const statusLabel = split.text || trimmed
    const isError =
      showStatus &&
      (trimmed.toLowerCase().startsWith('error:') || trimmed.toLowerCase().includes(' error'))
    const isRunning = showProgress && !isError
    const allowStatusWithSubtitle = showStatus && (isRunning || isActiveStatus(trimmed))
    const shouldShowStatus =
      showStatus && (!isStreaming || !baseSubtitle || allowStatusWithSubtitle)

    if (baseTitle !== lastTitle) {
      titleEl.textContent = baseTitle
      lastTitle = baseTitle
    }

    if (
      !isError &&
      percentNum != null &&
      Number.isFinite(percentNum) &&
      percentNum >= 0 &&
      percentNum <= 100
    ) {
      const next = `${percentNum}%`
      if (next !== lastProgress) {
        headerEl.style.setProperty('--progress', next)
        lastProgress = next
      }
    } else {
      if (lastProgress !== '0%') {
        headerEl.style.setProperty('--progress', '0%')
        lastProgress = '0%'
      }
    }

    if (isError !== lastIsError) {
      headerEl.classList.toggle('isError', isError)
      lastIsError = isError
    }
    if (isRunning !== lastIsRunning) {
      headerEl.classList.toggle('isRunning', isRunning)
      lastIsRunning = isRunning
    }
    const isIndeterminate = isRunning && percentNum == null
    if (isIndeterminate !== lastIsIndeterminate) {
      headerEl.classList.toggle('isIndeterminate', isIndeterminate)
      lastIsIndeterminate = isIndeterminate
    }

    const progressDisplay = isRunning || isError ? '' : 'none'
    if (progressDisplay !== lastProgressDisplay) {
      progressFillEl.style.display = progressDisplay
      lastProgressDisplay = progressDisplay
    }
    const combinedSubtitle =
      allowStatusWithSubtitle && baseSubtitle && !isError
        ? `${statusLabel} · ${baseSubtitle}`
        : statusLabel
    const nextSubtitle = isError ? statusLabel : shouldShowStatus ? combinedSubtitle : baseSubtitle
    if (nextSubtitle !== lastSubtitle) {
      subtitleEl.textContent = nextSubtitle
      lastSubtitle = nextSubtitle
    }
  }

  const updateHeader = () => {
    if (rafId != null) return
    rafId = window.requestAnimationFrame(() => {
      rafId = null
      renderHeader()
    })
  }

  const updateHeaderOffset = () => {
    const height = headerEl.getBoundingClientRect().height
    document.documentElement.style.setProperty('--header-height', `${height}px`)
  }

  const setBaseSubtitle = (text: string) => {
    baseSubtitle = text
    updateHeader()
  }

  const setBaseTitle = (text: string) => {
    const next = text.trim() || 'Summarize'
    baseTitle = next
    updateHeader()
  }

  const setStatus = (text: string) => {
    statusText = text
    const trimmed = text.trim()
    const isError =
      trimmed.length > 0 &&
      (trimmed.toLowerCase().startsWith('error:') || trimmed.toLowerCase().includes(' error'))
    const forceProgress = isActiveStatus(trimmed)
    const split = splitStatusPercent(text)
    const { phase } = getState()
    if (split.percent && shouldAllowProgress(forceProgress)) {
      armProgress()
    } else if (trimmed && shouldAllowProgress(forceProgress) && !isError) {
      armProgress()
    } else if (!trimmed && !(phase === 'connecting' || phase === 'streaming')) {
      stopProgress()
    }
    updateHeader()
  }

  const armProgress = () => {
    if (!shouldAllowProgress()) return
    if (showProgress) return
    showProgress = true
    updateHeader()
  }

  const stopProgress = () => {
    if (!showProgress) return
    showProgress = false
    updateHeader()
  }

  const setProgressOverride = (next: boolean) => {
    progressOverride = next
    if (next) {
      if (!showProgress) showProgress = true
    } else if (
      !statusText.trim() &&
      !(getState().phase === 'connecting' || getState().phase === 'streaming')
    ) {
      showProgress = false
    }
    updateHeader()
  }

  return {
    setBaseTitle,
    setBaseSubtitle,
    setStatus,
    armProgress,
    stopProgress,
    setProgressOverride,
    updateHeaderOffset,
  }
}
