import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { Writable } from "node:stream";
import type { CacheState } from "../cache.js";
import { loadSummarizeConfig } from "../config.js";
import { createDaemonLogger } from "../logging/daemon.js";
import { runWithProcessContext, setProcessObserver } from "../processes.js";
import { refreshFree } from "../refresh-free.js";
import { createCacheStateFromConfig, refreshCacheStoreIfMissing } from "../run/cache-state.js";
import { resolveExecutableInPath } from "../run/env.js";
import { formatModelLabelForDisplay } from "../run/finish-line.js";
import { createMediaCacheFromConfig } from "../run/media-cache-state.js";
import { resolveRunOverrides } from "../run/run-settings.js";
import { encodeSseEvent, type SseEvent, type SseSlidesData } from "../shared/sse-events.js";
import type { SlideExtractionResult, SlideSettings } from "../slides/index.js";
import { resolveSlideImagePath, resolveSlideSettings } from "../slides/index.js";
import { resolvePackageVersion } from "../version.js";
import { completeAgentResponse, streamAgentResponse } from "./agent.js";
import { type DaemonRequestedMode, resolveAutoDaemonMode } from "./auto-mode.js";
import { daemonConfigTokens, type DaemonConfig } from "./config.js";
import { DAEMON_HOST, DAEMON_PORT_DEFAULT } from "./constants.js";
import { resolveDaemonLogPaths } from "./launchd.js";
import { ProcessRegistry } from "./process-registry.js";
import { handleAdminRoutes } from "./server-admin-routes.js";
import {
  clampNumber,
  corsHeaders,
  json,
  readBearerToken,
  readCorsHeaders,
  readJsonBody,
  text,
  wantsJsonResponse,
} from "./server-http.js";
import {
  createSession,
  emitMeta,
  emitSlides,
  emitSlidesDone,
  emitSlidesStatus,
  endSession,
  pushSlidesToSession,
  pushToSession,
  scheduleSessionCleanup,
  type Session,
  type SessionEvent,
} from "./server-session.js";
import { attachBufferedSseSession } from "./server-sse.js";
import {
  extractContentForUrl,
  streamSummaryForUrl,
  streamSummaryForVisiblePage,
} from "./summarize.js";

export { corsHeaders, isTrustedOrigin } from "./server-http.js";

function parseDiagnostics(raw: unknown): { includeContent: boolean } {
  if (!raw || typeof raw !== "object") {
    return { includeContent: false };
  }
  const obj = raw as Record<string, unknown>;
  return { includeContent: Boolean(obj.includeContent) };
}

function createLineWriter(onLine: (line: string) => void) {
  let buffer = "";
  return new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trimEnd();
        buffer = buffer.slice(index + 1);
        if (line.trim().length > 0) onLine(line);
        index = buffer.indexOf("\n");
      }
      callback();
    },
    final(callback) {
      const line = buffer.trim();
      if (line) onLine(line);
      buffer = "";
      callback();
    },
  });
}

function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) return process.cwd();
  return home;
}

function resolveSlidesSettings({
  env,
  request,
}: {
  env: Record<string, string | undefined>;
  request: Record<string, unknown>;
}): SlideSettings | null {
  const slidesValue = request.slides;
  const tesseractAvailable = resolveToolPath("tesseract", env, "TESSERACT_PATH") !== null;
  const slidesOcrValue = tesseractAvailable ? request.slidesOcr : false;
  return resolveSlideSettings({
    slides: slidesValue,
    slidesOcr: slidesOcrValue,
    slidesDir: request.slidesDir ?? ".summarize/slides",
    slidesSceneThreshold: request.slidesSceneThreshold,
    slidesSceneThresholdExplicit: typeof request.slidesSceneThreshold !== "undefined",
    slidesMax: request.slidesMax,
    slidesMinDuration: request.slidesMinDuration,
    cwd: resolveHomeDir(env),
  });
}

function buildSlidesPayload({
  slides,
  port,
}: {
  slides: SlideExtractionResult;
  port: number;
}): SseSlidesData {
  // Use a stable URL that survives session GC, so images don't break while scrolling.
  const baseUrl = `http://127.0.0.1:${port}/v1/slides/${slides.sourceId}`;
  return {
    sourceUrl: slides.sourceUrl,
    sourceId: slides.sourceId,
    sourceKind: slides.sourceKind,
    ocrAvailable: slides.ocrAvailable,
    slides: slides.slides.map((slide) => ({
      index: slide.index,
      timestamp: slide.timestamp,
      imageUrl: `${baseUrl}/${slide.index}${
        typeof slide.imageVersion === "number" && slide.imageVersion > 0
          ? `?v=${slide.imageVersion}`
          : ""
      }`,
      ocrText: slide.ocrText ?? null,
      ocrConfidence: slide.ocrConfidence ?? null,
    })),
  };
}

function resolveToolPath(
  binary: string,
  env: Record<string, string | undefined>,
  explicitEnvKey?: string,
): string | null {
  const explicit =
    explicitEnvKey && typeof env[explicitEnvKey] === "string" ? env[explicitEnvKey]?.trim() : "";
  if (explicit) return resolveExecutableInPath(explicit, env);
  return resolveExecutableInPath(binary, env);
}

export function buildHealthPayload(importMetaUrl?: string) {
  return { ok: true, pid: process.pid, version: resolvePackageVersion(importMetaUrl) };
}

export async function runDaemonServer({
  env,
  fetchImpl,
  config,
  port = config.port ?? DAEMON_PORT_DEFAULT,
  signal,
  onListening,
  onSessionEvent,
}: {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  config: DaemonConfig;
  port?: number;
  signal?: AbortSignal;
  onListening?: ((port: number) => void) | null;
  onSessionEvent?: ((event: SessionEvent, sessionId: string) => void) | null;
}): Promise<void> {
  const { config: summarizeConfig } = loadSummarizeConfig({ env });
  const daemonLogger = createDaemonLogger({ env, config: summarizeConfig });
  const daemonLogPaths = resolveDaemonLogPaths(env);
  const daemonLogFile =
    daemonLogger.config?.file ?? path.join(daemonLogPaths.logDir, "daemon.jsonl");
  const cacheState = await createCacheStateFromConfig({
    envForRun: env,
    config: summarizeConfig,
    noCacheFlag: false,
    transcriptNamespace: "yt:auto",
  });
  const mediaCache = await createMediaCacheFromConfig({
    envForRun: env,
    config: summarizeConfig,
    noMediaCacheFlag: false,
  });

  const processRegistry = new ProcessRegistry();
  setProcessObserver(processRegistry.createObserver());

  const sessions = new Map<string, Session>();
  const refreshSessions = new Map<string, Session>();
  let activeRefreshSessionId: string | null = null;

  const server = http.createServer((req, res) => {
    void (async () => {
      const cors = readCorsHeaders(req);

      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://${DAEMON_HOST}:${port}`);
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/health") {
        json(res, 200, buildHealthPayload(import.meta.url), cors);
        return;
      }

      const token = readBearerToken(req);
      const authed = token ? daemonConfigTokens(config).includes(token) : false;
      if (pathname.startsWith("/v1/") && !authed) {
        json(res, 401, { ok: false, error: "unauthorized" }, cors);
        return;
      }

      if (
        await handleAdminRoutes({
          req,
          res,
          url,
          pathname,
          cors,
          env,
          fetchImpl,
          summarizeConfig,
          daemonLogger,
          daemonLogFile,
          daemonLogPaths,
          processRegistry,
          resolveToolPath,
        })
      ) {
        return;
      }

      if (req.method === "POST" && pathname === "/v1/refresh-free") {
        if (activeRefreshSessionId) {
          json(res, 200, { ok: true, id: activeRefreshSessionId, running: true }, cors);
          return;
        }

        const session = createSession(() => randomUUID());
        refreshSessions.set(session.id, session);
        activeRefreshSessionId = session.id;
        json(res, 200, { ok: true, id: session.id }, cors);

        void (async () => {
          const pushStatus = (text: string) => {
            pushToSession(session, { event: "status", data: { text } }, onSessionEvent);
          };
          try {
            pushStatus("Refresh free: starting…");
            const stdout = createLineWriter(pushStatus);
            const stderr = createLineWriter(pushStatus);
            await refreshFree({ env, fetchImpl, stdout, stderr });
            pushToSession(session, { event: "done", data: {} }, onSessionEvent);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            pushToSession(session, { event: "error", data: { message } }, onSessionEvent);
            console.error("[summarize-daemon] refresh-free failed", error);
          } finally {
            if (activeRefreshSessionId === session.id) {
              activeRefreshSessionId = null;
            }
            setTimeout(() => {
              refreshSessions.delete(session.id);
              endSession(session);
            }, 60_000).unref();
          }
        })();
        return;
      }

      if (req.method === "POST" && pathname === "/v1/summarize") {
        await refreshCacheStoreIfMissing({ cacheState, transcriptNamespace: "yt:auto" });
        let body: unknown;
        try {
          body = await readJsonBody(req, 2_000_000);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          json(res, 400, { ok: false, error: message }, cors);
          return;
        }
        if (!body || typeof body !== "object") {
          json(res, 400, { ok: false, error: "invalid json" }, cors);
          return;
        }
        const obj = body as Record<string, unknown>;
        const pageUrl = typeof obj.url === "string" ? obj.url.trim() : "";
        const title = typeof obj.title === "string" ? obj.title.trim() : null;
        const textContent = typeof obj.text === "string" ? obj.text : "";
        const truncated = Boolean(obj.truncated);
        const modelOverride = typeof obj.model === "string" ? obj.model.trim() : null;
        const lengthRaw = typeof obj.length === "string" ? obj.length.trim() : "";
        const languageRaw = typeof obj.language === "string" ? obj.language.trim() : "";
        const promptRaw = typeof obj.prompt === "string" ? obj.prompt : "";
        const promptOverride = promptRaw.trim() || null;
        const noCache = Boolean(obj.noCache);
        const extractOnly = Boolean(obj.extractOnly);
        const modeRaw = typeof obj.mode === "string" ? obj.mode.trim().toLowerCase() : "";
        const mode: DaemonRequestedMode =
          modeRaw === "url" ? "url" : modeRaw === "page" ? "page" : "auto";
        const maxCharactersCandidate =
          typeof obj.maxExtractCharacters === "number" && Number.isFinite(obj.maxExtractCharacters)
            ? obj.maxExtractCharacters
            : typeof obj.maxCharacters === "number" && Number.isFinite(obj.maxCharacters)
              ? obj.maxCharacters
              : null;
        const maxCharacters =
          maxCharactersCandidate && maxCharactersCandidate > 0 ? maxCharactersCandidate : null;
        const formatRaw = typeof obj.format === "string" ? obj.format.trim().toLowerCase() : "";
        const format: "text" | "markdown" =
          formatRaw === "markdown" || formatRaw === "md" ? "markdown" : "text";
        const overrides = resolveRunOverrides({
          firecrawl: obj.firecrawl,
          markdownMode: obj.markdownMode,
          preprocess: obj.preprocess,
          youtube: obj.youtube,
          videoMode: obj.videoMode,
          timestamps: obj.timestamps,
          forceSummary: obj.forceSummary,
          timeout: obj.timeout,
          retries: obj.retries,
          maxOutputTokens: obj.maxOutputTokens,
          autoCliFallback: obj.autoCliFallback,
          autoCliOrder: obj.autoCliOrder,
          magicCliAuto: obj.magicCliAuto,
          magicCliOrder: obj.magicCliOrder,
        });
        const slidesSettings = resolveSlidesSettings({ env, request: obj });
        const diagnostics = parseDiagnostics(obj.diagnostics);
        const includeContentLog = daemonLogger.enabled && diagnostics.includeContent;
        const hasText = Boolean(textContent.trim());
        if (!pageUrl || !/^https?:\/\//i.test(pageUrl)) {
          json(res, 400, { ok: false, error: "missing url" }, cors);
          return;
        }
        if (extractOnly) {
          if (mode === "page") {
            json(res, 400, { ok: false, error: "extractOnly requires mode=url" }, cors);
            return;
          }
          try {
            const requestCache: CacheState = noCache
              ? { ...cacheState, mode: "bypass" as const, store: null }
              : cacheState;
            const runId = randomUUID();
            const { extracted, slides } = await runWithProcessContext(
              { runId, source: "extract" },
              async () =>
                extractContentForUrl({
                  env,
                  fetchImpl,
                  input: { url: pageUrl, title, maxCharacters },
                  cache: requestCache,
                  mediaCache,
                  overrides,
                  format,
                  slides: slidesSettings,
                }),
            );
            const slidesPayload =
              slides && slides.slides.length > 0
                ? {
                    sourceUrl: slides.sourceUrl,
                    sourceId: slides.sourceId,
                    sourceKind: slides.sourceKind,
                    ocrAvailable: slides.ocrAvailable,
                    slides: slides.slides.map((slide) => ({
                      index: slide.index,
                      timestamp: slide.timestamp,
                      ocrText: slide.ocrText ?? null,
                      ocrConfidence: slide.ocrConfidence ?? null,
                    })),
                  }
                : null;
            json(
              res,
              200,
              {
                ok: true,
                extracted: {
                  content: extracted.content,
                  title: extracted.title,
                  url: extracted.url,
                  wordCount: extracted.wordCount,
                  totalCharacters: extracted.totalCharacters,
                  truncated: extracted.truncated,
                  transcriptSource: extracted.transcriptSource ?? null,
                  transcriptCharacters: extracted.transcriptCharacters ?? null,
                  transcriptWordCount: extracted.transcriptWordCount ?? null,
                  transcriptLines: extracted.transcriptLines ?? null,
                  transcriptSegments: extracted.transcriptSegments ?? null,
                  transcriptTimedText: extracted.transcriptTimedText ?? null,
                  transcriptionProvider: extracted.transcriptionProvider ?? null,
                  mediaDurationSeconds: extracted.mediaDurationSeconds ?? null,
                  diagnostics: extracted.diagnostics,
                },
                ...(slidesPayload ? { slides: slidesPayload } : {}),
              },
              cors,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            json(res, 500, { ok: false, error: message }, cors);
          }
          return;
        }

        if (mode === "page" && !hasText) {
          json(res, 400, { ok: false, error: "missing text" }, cors);
          return;
        }

        const session = createSession(() => randomUUID());
        session.slidesRequested = Boolean(slidesSettings);
        sessions.set(session.id, session);
        const requestLogger = daemonLogger.getSubLogger("daemon.summarize", {
          requestId: session.id,
        });
        const logStartedAt = Date.now();
        let logSummaryFromCache = false;
        let logInputSummary: string | null = null;
        let logSummaryText = "";
        let logExtracted: Record<string, unknown> | null = null;
        const logInput = includeContentLog
          ? {
              url: pageUrl,
              title,
              text: hasText ? textContent : null,
              truncated: hasText ? truncated : null,
            }
          : null;
        const logSlidesSettings =
          includeContentLog && slidesSettings
            ? {
                enabled: slidesSettings.enabled,
                ocr: slidesSettings.ocr,
                outputDir: slidesSettings.outputDir,
                sceneThreshold: slidesSettings.sceneThreshold,
                autoTuneThreshold: slidesSettings.autoTuneThreshold,
                maxSlides: slidesSettings.maxSlides,
                minDurationSeconds: slidesSettings.minDurationSeconds,
              }
            : null;
        requestLogger?.info({
          event: "summarize.request",
          url: pageUrl,
          mode,
          hasText,
          noCache,
          length: lengthRaw,
          language: languageRaw,
          model: modelOverride,
          includeContent: includeContentLog,
          slides: Boolean(slidesSettings),
          ...(logSlidesSettings ? { slidesSettings: logSlidesSettings } : {}),
          ...(includeContentLog ? { diagnostics } : {}),
        });

        json(res, 200, { ok: true, id: session.id }, cors);

        void runWithProcessContext({ runId: session.id, source: "summarize" }, async () => {
          const slideLogState: {
            startedAt: number | null;
            requested: boolean;
            cacheHit: boolean;
            lastStatus: string | null;
            statusCount: number;
            elapsedMs: number | null;
            slidesCount: number | null;
            ocrAvailable: boolean | null;
            warnings: string[];
          } = {
            startedAt: null,
            requested: Boolean(slidesSettings),
            cacheHit: false,
            lastStatus: null,
            statusCount: 0,
            elapsedMs: null,
            slidesCount: null,
            ocrAvailable: null,
            warnings: [],
          };
          try {
            let emittedOutput = false;
            const sink = {
              writeChunk: (chunk: string) => {
                emittedOutput = true;
                if (includeContentLog) {
                  logSummaryText += chunk;
                }
                pushToSession(session, { event: "chunk", data: { text: chunk } }, onSessionEvent);
              },
              onModelChosen: (modelId: string) => {
                if (session.lastMeta.model === modelId) return;
                emittedOutput = true;
                emitMeta(
                  session,
                  {
                    model: modelId,
                    modelLabel: formatModelLabelForDisplay(modelId),
                  },
                  onSessionEvent,
                );
              },
              writeStatus: (text: string) => {
                const clean = text.trim();
                if (!clean) return;
                pushToSession(session, { event: "status", data: { text: clean } }, onSessionEvent);
              },
              writeMeta: (data: {
                inputSummary?: string | null;
                summaryFromCache?: boolean | null;
              }) => {
                if (typeof data.inputSummary === "string") {
                  logInputSummary = data.inputSummary;
                }
                if (typeof data.summaryFromCache === "boolean") {
                  logSummaryFromCache = data.summaryFromCache;
                }
                emitMeta(
                  session,
                  {
                    inputSummary: typeof data.inputSummary === "string" ? data.inputSummary : null,
                    summaryFromCache:
                      typeof data.summaryFromCache === "boolean" ? data.summaryFromCache : null,
                  },
                  onSessionEvent,
                );
              },
            };

            const normalizedModelOverride =
              modelOverride && modelOverride.toLowerCase() !== "auto" ? modelOverride : null;

            const requestCache: CacheState = noCache
              ? { ...cacheState, mode: "bypass" as const, store: null }
              : cacheState;
            let liveSlides: SlideExtractionResult | null = null;

            const runWithMode = async (resolved: "url" | "page") => {
              if (resolved === "url" && slideLogState.requested) {
                slideLogState.startedAt = Date.now();
                console.log(
                  `[summarize-daemon] slides: start url=${pageUrl} (session=${session.id})`,
                );
                if (includeContentLog) {
                  requestLogger?.info({
                    event: "slides.start",
                    url: pageUrl,
                    sessionId: session.id,
                    ...(logSlidesSettings ? { settings: logSlidesSettings } : {}),
                  });
                }
              }
              return resolved === "url"
                ? await streamSummaryForUrl({
                    env,
                    fetchImpl,
                    modelOverride: normalizedModelOverride,
                    promptOverride,
                    lengthRaw,
                    languageRaw,
                    format,
                    input: { url: pageUrl, title, maxCharacters },
                    sink,
                    cache: requestCache,
                    mediaCache,
                    overrides,
                    slides: slidesSettings,
                    hooks: {
                      ...(includeContentLog
                        ? {
                            onExtracted: (content) => {
                              logExtracted = content as unknown as Record<string, unknown>;
                            },
                          }
                        : {}),
                      onSlidesExtracted: (slides) => {
                        session.slides = slides;
                        slideLogState.slidesCount = slides.slides.length;
                        slideLogState.ocrAvailable = slides.ocrAvailable;
                        slideLogState.warnings = slides.warnings;
                        if (slideLogState.startedAt) {
                          slideLogState.elapsedMs = Date.now() - slideLogState.startedAt;
                        }
                        if (slideLogState.startedAt) {
                          const elapsedMs = Date.now() - slideLogState.startedAt;
                          console.log(
                            `[summarize-daemon] slides: done count=${slides.slides.length} ocr=${slides.ocrAvailable} elapsedMs=${elapsedMs} warnings=${slides.warnings.join("; ")}`,
                          );
                        }
                        if (includeContentLog) {
                          requestLogger?.info({
                            event: "slides.done",
                            url: pageUrl,
                            sessionId: session.id,
                            slidesCount: slides.slides.length,
                            ocrAvailable: slides.ocrAvailable,
                            elapsedMs: slideLogState.elapsedMs,
                            cacheHit: slideLogState.cacheHit,
                            warnings: slides.warnings,
                          });
                        }
                        emitSlides(
                          session,
                          buildSlidesPayload({
                            slides,
                            port,
                          }),
                          onSessionEvent,
                        );
                      },
                      onSlidesDone: (result) => {
                        emitSlidesDone(session, result, onSessionEvent);
                      },
                      onSlidesProgress: (text) => {
                        const clean = typeof text === "string" ? text.trim() : "";
                        if (!clean) return;
                        slideLogState.lastStatus = clean;
                        slideLogState.statusCount += 1;
                        if (clean.toLowerCase().includes("cached")) {
                          slideLogState.cacheHit = true;
                        }
                        const progressMatch = clean.match(/(\d+)%/);
                        const progress = progressMatch ? Number(progressMatch[1]) : null;
                        if (includeContentLog) {
                          requestLogger?.info({
                            event: "slides.status",
                            url: pageUrl,
                            sessionId: session.id,
                            status: clean,
                            ...(progress !== null ? { progress } : {}),
                          });
                        }
                        emitSlidesStatus(session, clean, onSessionEvent);
                      },
                      onSlideChunk: (chunk) => {
                        const { slide, meta } = chunk;
                        if (
                          slide == null ||
                          !meta?.slidesDir ||
                          !meta.sourceUrl ||
                          !meta.sourceId ||
                          !meta.sourceKind
                        ) {
                          return;
                        }
                        const nextSlides = liveSlides ?? {
                          sourceUrl: meta.sourceUrl,
                          sourceKind: meta.sourceKind,
                          sourceId: meta.sourceId,
                          slidesDir: meta.slidesDir,
                          sceneThreshold: 0,
                          autoTuneThreshold: false,
                          autoTune: {
                            enabled: false,
                            chosenThreshold: 0,
                            confidence: 0,
                            strategy: "none",
                          },
                          maxSlides: 0,
                          minSlideDuration: 0,
                          ocrRequested: meta.ocrAvailable,
                          ocrAvailable: meta.ocrAvailable,
                          slides: [],
                          warnings: [],
                        };
                        liveSlides = nextSlides;
                        const existingIndex = nextSlides.slides.findIndex(
                          (item) => item.index === slide.index,
                        );
                        if (existingIndex >= 0) {
                          nextSlides.slides[existingIndex] = {
                            ...nextSlides.slides[existingIndex],
                            ...slide,
                          };
                        } else {
                          nextSlides.slides.push(slide);
                        }
                        nextSlides.slides.sort((a, b) => a.index - b.index);
                        session.slides = nextSlides;
                        emitSlides(
                          session,
                          buildSlidesPayload({
                            slides: nextSlides,
                            port,
                          }),
                          onSessionEvent,
                        );
                      },
                    },
                  })
                : await streamSummaryForVisiblePage({
                    env,
                    fetchImpl,
                    modelOverride: normalizedModelOverride,
                    promptOverride,
                    lengthRaw,
                    languageRaw,
                    format,
                    input: { url: pageUrl, title, text: textContent, truncated },
                    sink,
                    cache: requestCache,
                    mediaCache,
                    overrides,
                  });
            };

            const result = await (async () => {
              if (mode !== "auto") return runWithMode(mode);

              const { primary, fallback } = resolveAutoDaemonMode({ url: pageUrl, hasText });

              try {
                return await runWithMode(primary);
              } catch (error) {
                if (!fallback || emittedOutput) throw error;

                sink.writeStatus?.("Primary failed. Trying fallback…");
                try {
                  return await runWithMode(fallback);
                } catch (fallbackError) {
                  const primaryMessage = error instanceof Error ? error.message : String(error);
                  const fallbackMessage =
                    fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                  throw new Error(
                    `Auto mode failed.\nPrimary (${primary}): ${primaryMessage}\nFallback (${fallback}): ${fallbackMessage}`,
                  );
                }
              }
            })();

            if (!session.lastMeta.model) {
              emitMeta(
                session,
                {
                  model: result.usedModel,
                  modelLabel: formatModelLabelForDisplay(result.usedModel),
                },
                onSessionEvent,
              );
            }

            pushToSession(session, { event: "metrics", data: result.metrics }, onSessionEvent);
            pushToSession(session, { event: "done", data: {} }, onSessionEvent);
            requestLogger?.info({
              event: "summarize.done",
              url: pageUrl,
              mode,
              model: result.usedModel,
              elapsedMs: Date.now() - logStartedAt,
              summaryFromCache: logSummaryFromCache,
              inputSummary: logInputSummary,
              ...(includeContentLog && slideLogState.requested
                ? {
                    slides: {
                      requested: true,
                      cacheHit: slideLogState.cacheHit,
                      lastStatus: slideLogState.lastStatus,
                      statusCount: slideLogState.statusCount,
                      elapsedMs: slideLogState.elapsedMs,
                      slidesCount: slideLogState.slidesCount,
                      ocrAvailable: slideLogState.ocrAvailable,
                      warnings: slideLogState.warnings,
                    },
                  }
                : {}),
              ...(includeContentLog && !logSummaryFromCache
                ? {
                    input: logInput,
                    extracted: logExtracted,
                    summary: logSummaryText,
                  }
                : {}),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            pushToSession(session, { event: "error", data: { message } }, onSessionEvent);
            if (session.slidesRequested && !session.slidesDone) {
              emitSlidesDone(session, { ok: false, error: message }, onSessionEvent);
            }
            // Preserve full stack trace in daemon logs for debugging.
            console.error("[summarize-daemon] summarize failed", error);
            requestLogger?.error({
              event: "summarize.error",
              url: pageUrl,
              mode,
              elapsedMs: Date.now() - logStartedAt,
              summaryFromCache: logSummaryFromCache,
              inputSummary: logInputSummary,
              ...(includeContentLog && slideLogState.requested
                ? {
                    slides: {
                      requested: true,
                      cacheHit: slideLogState.cacheHit,
                      lastStatus: slideLogState.lastStatus,
                      statusCount: slideLogState.statusCount,
                      elapsedMs: slideLogState.elapsedMs,
                      slidesCount: slideLogState.slidesCount,
                      ocrAvailable: slideLogState.ocrAvailable,
                      warnings: slideLogState.warnings,
                    },
                  }
                : {}),
              error: {
                message,
                stack: error instanceof Error ? error.stack : null,
              },
              ...(includeContentLog && !logSummaryFromCache
                ? {
                    input: logInput,
                    extracted: logExtracted,
                    summary: logSummaryText || null,
                  }
                : {}),
            });
          } finally {
            scheduleSessionCleanup({ session, sessions, refreshSessions });
          }
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/agent") {
        let body: unknown;
        try {
          body = await readJsonBody(req, 4_000_000);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          json(res, 400, { ok: false, error: message }, cors);
          return;
        }
        if (!body || typeof body !== "object") {
          json(res, 400, { ok: false, error: "invalid json" }, cors);
          return;
        }

        const obj = body as Record<string, unknown>;
        const pageUrl = typeof obj.url === "string" ? obj.url.trim() : "";
        const pageTitle = typeof obj.title === "string" ? obj.title.trim() : null;
        const pageContent = typeof obj.pageContent === "string" ? obj.pageContent : "";
        const messages = obj.messages;
        const modelOverride = typeof obj.model === "string" ? obj.model.trim() : null;
        const tools = Array.isArray(obj.tools)
          ? obj.tools.filter((tool): tool is string => typeof tool === "string")
          : [];
        const automationEnabled = Boolean(obj.automationEnabled);

        if (!pageUrl) {
          json(res, 400, { ok: false, error: "missing url" }, cors);
          return;
        }

        const runId = `agent-${randomUUID()}`;
        const wantsJson = wantsJsonResponse(req, url);
        if (wantsJson) {
          try {
            const assistant = await runWithProcessContext({ runId, source: "agent" }, async () =>
              completeAgentResponse({
                env,
                pageUrl,
                pageTitle,
                pageContent,
                messages,
                modelOverride:
                  modelOverride && modelOverride.toLowerCase() !== "auto" ? modelOverride : null,
                tools,
                automationEnabled,
              }),
            );
            json(res, 200, { ok: true, assistant }, cors);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("[summarize-daemon] agent failed", error);
            json(res, 500, { ok: false, error: message }, cors);
          }
          return;
        }

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          ...cors,
        });

        const controller = new AbortController();
        const abort = () => controller.abort();
        req.on("close", abort);
        res.on("close", abort);

        const writeEvent = (event: SseEvent) => {
          if (res.writableEnded) return;
          res.write(encodeSseEvent(event));
        };

        try {
          await runWithProcessContext({ runId, source: "agent" }, async () =>
            streamAgentResponse({
              env,
              pageUrl,
              pageTitle,
              pageContent,
              messages,
              modelOverride:
                modelOverride && modelOverride.toLowerCase() !== "auto" ? modelOverride : null,
              tools,
              automationEnabled,
              onChunk: (text) => writeEvent({ event: "chunk", data: { text } }),
              onAssistant: (assistant) => writeEvent({ event: "assistant", data: assistant }),
              signal: controller.signal,
            }),
          );
          writeEvent({ event: "done", data: {} });
          res.end();
        } catch (error) {
          if (controller.signal.aborted) return;
          const message = error instanceof Error ? error.message : String(error);
          console.error("[summarize-daemon] agent failed", error);
          writeEvent({ event: "error", data: { message } });
          writeEvent({ event: "done", data: {} });
          res.end();
        }
        return;
      }

      const slidesMatch = pathname.match(/^\/v1\/summarize\/([^/]+)\/slides$/);
      if (req.method === "GET" && slidesMatch) {
        const id = slidesMatch[1];
        const session = id ? sessions.get(id) : null;
        if (!session || !session.slides) {
          json(res, 200, { ok: false, error: "not found" }, cors);
          return;
        }
        json(
          res,
          200,
          { ok: true, slides: buildSlidesPayload({ slides: session.slides, port }) },
          cors,
        );
        return;
      }

      const slideImageMatch = pathname.match(/^\/v1\/summarize\/([^/]+)\/slides\/(\d+)$/);
      if (req.method === "GET" && slideImageMatch) {
        const id = slideImageMatch[1];
        const index = Number(slideImageMatch[2]);
        const session = id ? sessions.get(id) : null;
        if (!session || !session.slides || !Number.isFinite(index)) {
          json(res, 404, { ok: false, error: "not found" }, cors);
          return;
        }
        const slide = session.slides.slides.find((item) => item.index === index);
        if (!slide) {
          json(res, 404, { ok: false, error: "not found" }, cors);
          return;
        }
        try {
          const stat = await fs.stat(slide.imagePath);
          res.writeHead(200, {
            "content-type": "image/png",
            "content-length": stat.size.toString(),
            "cache-control": "no-cache",
            ...cors,
          });
          const stream = createReadStream(slide.imagePath);
          stream.pipe(res);
          stream.on("error", () => res.end());
        } catch {
          json(res, 404, { ok: false, error: "not found" }, cors);
        }
        return;
      }

      const stableSlideImageMatch = pathname.match(/^\/v1\/slides\/([^/]+)\/(\d+)$/);
      if (req.method === "GET" && stableSlideImageMatch) {
        const sourceId = stableSlideImageMatch[1];
        const index = Number(stableSlideImageMatch[2]);
        if (!sourceId || !Number.isFinite(index) || index <= 0) {
          json(res, 404, { ok: false, error: "not found" }, cors);
          return;
        }

        const slidesRoot = path.resolve(resolveHomeDir(env), ".summarize", "slides");
        const slidesDir = path.join(slidesRoot, sourceId);
        const payloadPath = path.join(slidesDir, "slides.json");

        const resolveFromDisk = async (): Promise<string | null> => {
          const raw = await fs.readFile(payloadPath, "utf8").catch(() => null);
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as SlideExtractionResult;
              const slide = parsed?.slides?.find?.((item) => item?.index === index);
              if (slide?.imagePath) {
                const resolved = resolveSlideImagePath(slidesDir, slide.imagePath);
                if (resolved) return resolved;
              }
            } catch {
              // fall through
            }
          }
          const prefix = `slide_${String(index).padStart(4, "0")}`;
          const entries = await fs.readdir(slidesDir).catch(() => null);
          if (!entries) return null;
          const candidates = entries
            .filter((name) => name.startsWith(prefix) && name.endsWith(".png"))
            .map((name) => path.join(slidesDir, name));
          if (candidates.length === 0) return null;
          let best: { filePath: string; mtimeMs: number } | null = null;
          for (const filePath of candidates) {
            const stat = await fs.stat(filePath).catch(() => null);
            if (!stat?.isFile()) continue;
            const mtimeMs = stat.mtimeMs;
            if (!best || mtimeMs > best.mtimeMs) best = { filePath, mtimeMs };
          }
          return best?.filePath ?? null;
        };

        const filePath = await resolveFromDisk();
        if (!filePath) {
          // Return a tiny transparent PNG (placeholder) instead of 404 to avoid broken-image icons
          // while extraction is still running.
          const placeholder = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
            "base64",
          );
          res.writeHead(200, {
            "content-type": "image/png",
            "content-length": placeholder.length.toString(),
            "cache-control": "no-store",
            "x-summarize-slide-ready": "0",
            ...cors,
          });
          res.end(placeholder);
          return;
        }

        try {
          const stat = await fs.stat(filePath);
          res.writeHead(200, {
            "content-type": "image/png",
            "content-length": stat.size.toString(),
            "cache-control": "no-store",
            "x-summarize-slide-ready": "1",
            ...cors,
          });
          const stream = createReadStream(filePath);
          stream.pipe(res);
          stream.on("error", () => res.end());
        } catch {
          json(res, 404, { ok: false, error: "not found" }, cors);
        }
        return;
      }

      const eventsMatch = pathname.match(/^\/v1\/summarize\/([^/]+)\/events$/);
      if (req.method === "GET" && eventsMatch) {
        const id = eventsMatch[1];
        if (!id) {
          json(res, 404, { ok: false }, cors);
          return;
        }
        const session = sessions.get(id);
        if (!session) {
          json(res, 404, { ok: false, error: "not found" }, cors);
          return;
        }

        attachBufferedSseSession({
          res,
          cors,
          buffer: session.buffer,
          clients: session.clients,
          done: session.done,
        });
        return;
      }

      const slidesEventsMatch = pathname.match(/^\/v1\/summarize\/([^/]+)\/slides\/events$/);
      if (req.method === "GET" && slidesEventsMatch) {
        const id = slidesEventsMatch[1];
        if (!id) {
          json(res, 404, { ok: false }, cors);
          return;
        }
        const session = sessions.get(id);
        if (!session || !session.slidesRequested) {
          json(res, 404, { ok: false, error: "not found" }, cors);
          return;
        }

        attachBufferedSseSession({
          res,
          cors,
          buffer: session.slidesBuffer,
          clients: session.slidesClients,
          done: session.slidesDone,
          afterReplay: () => {
            const hasSlidesEvent = session.slidesBuffer.some(
              (entry) => entry.event.event === "slides",
            );
            if (!hasSlidesEvent && session.slides) {
              res.write(
                encodeSseEvent({
                  event: "slides",
                  data: buildSlidesPayload({ slides: session.slides, port }),
                }),
              );
            }

            const hasStatusEvent = session.slidesBuffer.some(
              (entry) => entry.event.event === "status",
            );
            if (!hasStatusEvent && session.slidesLastStatus) {
              res.write(
                encodeSseEvent({ event: "status", data: { text: session.slidesLastStatus } }),
              );
            }
          },
        });
        return;
      }

      const refreshEventsMatch = pathname.match(/^\/v1\/refresh-free\/([^/]+)\/events$/);
      if (req.method === "GET" && refreshEventsMatch) {
        const id = refreshEventsMatch[1];
        if (!id) {
          json(res, 404, { ok: false }, cors);
          return;
        }
        const session = refreshSessions.get(id);
        if (!session) {
          json(res, 404, { ok: false, error: "not found" }, cors);
          return;
        }

        attachBufferedSseSession({
          res,
          cors,
          buffer: session.buffer,
          clients: session.clients,
          done: session.done,
        });
        return;
      }

      text(res, 404, "Not found", cors);
    })().catch((error) => {
      const cors = readCorsHeaders(req);
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        json(res, 500, { ok: false, error: message }, cors);
        return;
      }
      try {
        res.end();
      } catch {
        // ignore
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, DAEMON_HOST, () => {
        const address = server.address();
        const actualPort =
          address && typeof address === "object" && typeof address.port === "number"
            ? address.port
            : port;
        onListening?.(actualPort);
        resolve();
      });
    });

    await new Promise<void>((resolve) => {
      let resolved = false;
      const onStop = () => {
        if (resolved) return;
        resolved = true;
        server.close(() => resolve());
      };
      process.once("SIGTERM", onStop);
      process.once("SIGINT", onStop);
      if (signal) {
        if (signal.aborted) {
          onStop();
        } else {
          signal.addEventListener("abort", onStop, { once: true });
        }
      }
    });
  } finally {
    cacheState.store?.close();
  }
}
