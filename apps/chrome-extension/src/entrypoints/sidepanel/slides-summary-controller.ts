import { coerceSummaryWithSlides } from "../../../../../src/run/flows/url/slides-text.js";
import { resolveSlidesLengthArg } from "./slides-state";
import { createStreamController } from "./stream-controller";
import type { PanelState, RunStart, UiState } from "./types";

type SlidesSummarySnapshot = {
  runId: string | null;
  markdown: string;
  complete: boolean;
  model: string | null;
};

type SlidesSummaryControllerOptions = {
  getToken: () => Promise<string>;
  friendlyFetchError: (error: unknown, fallback: string) => string;
  panelUrlsMatch: (left: string | null | undefined, right: string | null | undefined) => boolean;
  getPanelState: () => PanelState;
  getUiState: () => UiState | null;
  getActiveTabUrl: () => string | null;
  getInputMode: () => "page" | "video";
  getInputModeOverride: () => "page" | "video" | null;
  getSlidesEnabled: () => boolean;
  getLengthValue: () => string;
  getTranscriptTimedText: () => string | null;
  clearSummarySource: () => void;
  updateSlideSummaryFromMarkdown: (
    markdown: string,
    opts?: { preserveIfEmpty?: boolean; source?: "summary" | "slides" },
  ) => void;
  renderMarkdown: (markdown: string) => void;
  renderInlineSlidesFallback: () => void;
};

type SlidesSummaryState = {
  runId: string | null;
  url: string | null;
  markdown: string;
  pending: string | null;
  hadError: boolean;
  complete: boolean;
  model: string | null;
};

function buildInitialState(): SlidesSummaryState {
  return {
    runId: null,
    url: null,
    markdown: "",
    pending: null,
    hadError: false,
    complete: false,
    model: null,
  };
}

export function createSlidesSummaryController(options: SlidesSummaryControllerOptions) {
  let state = buildInitialState();

  const getEffectiveInputMode = () => options.getInputModeOverride() ?? options.getInputMode();
  const getCurrentUrl = () =>
    options.getPanelState().currentSource?.url ?? options.getActiveTabUrl() ?? null;
  const getFallbackModel = () =>
    options.getPanelState().lastMeta.model ?? options.getUiState()?.settings.model ?? "auto";

  const applyMarkdown = (markdown: string) => {
    if (!markdown.trim()) return;
    const currentUrl = getCurrentUrl();
    if (state.url && currentUrl && !options.panelUrlsMatch(state.url, currentUrl)) return;
    if (!options.getSlidesEnabled()) {
      state.pending = markdown;
      return;
    }
    if (getEffectiveInputMode() !== "video") {
      state.pending = markdown;
      return;
    }

    let output = markdown;
    const slides = options.getPanelState().slides?.slides ?? [];
    if (slides.length > 0) {
      output = coerceSummaryWithSlides({
        markdown,
        slides: slides.map((slide) => ({
          index: slide.index,
          timestamp: Number.isFinite(slide.timestamp) ? slide.timestamp : Number.NaN,
        })),
        transcriptTimedText: options.getTranscriptTimedText(),
        lengthArg: resolveSlidesLengthArg(options.getLengthValue()),
      });
    }
    options.updateSlideSummaryFromMarkdown(output, { preserveIfEmpty: false, source: "slides" });
    if (!options.getPanelState().summaryMarkdown?.trim()) {
      options.renderMarkdown(output);
    }
  };

  const maybeApplyPending = () => {
    if (!state.pending) return;
    const phase = options.getPanelState().phase;
    if (phase === "connecting" || phase === "streaming") return;
    const markdown = state.pending;
    state.pending = null;
    applyMarkdown(markdown);
  };

  const streamController = createStreamController({
    getToken: options.getToken,
    onStatus: () => {},
    onPhaseChange: () => {},
    idleTimeoutMs: 600_000,
    idleTimeoutMessage: "Slides summary stalled. The daemon may have stopped.",
    onMeta: (meta) => {
      if (typeof meta.model === "string") {
        state.model = meta.model;
      }
    },
    onRender: (markdown) => {
      state.markdown = markdown;
      if (
        options.getSlidesEnabled() &&
        getEffectiveInputMode() === "video" &&
        options.getPanelState().slides
      ) {
        options.updateSlideSummaryFromMarkdown(markdown, {
          preserveIfEmpty: true,
          source: "slides",
        });
        if (options.getPanelState().summaryMarkdown) {
          options.renderInlineSlidesFallback();
        }
      }
    },
    onReset: () => {
      state.markdown = "";
      state.pending = null;
      state.hadError = false;
      state.complete = false;
      state.model = getFallbackModel();
    },
    onError: (error) => {
      state.hadError = true;
      return options.friendlyFetchError(error, "Slides summary failed");
    },
    onDone: () => {
      if (state.hadError) {
        state.complete = false;
        return;
      }
      state.complete = true;
      const markdown = state.markdown;
      if (!markdown.trim()) return;
      const phase = options.getPanelState().phase;
      if (phase === "connecting" || phase === "streaming") {
        state.pending = markdown;
        return;
      }
      applyMarkdown(markdown);
    },
  });

  return {
    stop() {
      streamController.abort();
      state = buildInitialState();
      options.clearSummarySource();
    },
    start(run: RunStart) {
      return streamController.start(run);
    },
    getSnapshot(): SlidesSummarySnapshot {
      return {
        runId: state.runId,
        markdown: state.markdown,
        complete: state.complete,
        model: state.model,
      };
    },
    getMarkdown() {
      return state.markdown;
    },
    getComplete() {
      return state.complete;
    },
    getModel() {
      return state.model;
    },
    getRunId() {
      return state.runId;
    },
    setSnapshot(payload: { markdown: string; complete: boolean; model: string | null }) {
      state.markdown = payload.markdown;
      state.complete = payload.complete;
      state.model = payload.model;
    },
    clearPending() {
      state.pending = null;
    },
    clearError() {
      state.hadError = false;
    },
    setRunId(value: string | null) {
      state.runId = value;
    },
    setUrl(value: string | null) {
      state.url = value;
    },
    resetSummaryState() {
      state.markdown = "";
      state.pending = null;
      state.hadError = false;
      state.complete = false;
    },
    setModel(value: string | null) {
      state.model = value;
    },
    applyMarkdown,
    maybeApplyPending,
  };
}
