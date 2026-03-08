import { openAsBlob } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { TRANSCRIPTION_TIMEOUT_MS } from "./constants.js";
import { toArrayBuffer, wrapError } from "./utils.js";

const ASSEMBLYAI_BASE_URL = "https://api.assemblyai.com/v2";
export const ASSEMBLYAI_DEFAULT_SPEECH_MODEL = "universal-2";
export const ASSEMBLYAI_DEFAULT_MODELS = [ASSEMBLYAI_DEFAULT_SPEECH_MODEL] as const;
export const ASSEMBLYAI_TRANSCRIPTION_MODEL_ID =
  `assemblyai/${ASSEMBLYAI_DEFAULT_SPEECH_MODEL}` as const;
const ASSEMBLYAI_POLL_INTERVAL_MS = 1_500;

type AssemblyAiOptions = {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  mediaType?: string | null;
};

type UploadResponse = {
  upload_url?: unknown;
};

type TranscriptResponse = {
  id?: unknown;
  status?: unknown;
  text?: unknown;
  error?: unknown;
};

function resolveFetch(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? globalThis.fetch;
}

function buildHeaders(apiKey: string, contentType?: string | null): Headers {
  const headers = new Headers({ authorization: apiKey });
  if (contentType?.trim()) headers.set("content-type", contentType.trim());
  return headers;
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  throw new Error(`AssemblyAI ${label} missing from response`);
}

async function uploadViaAssemblyAi(
  body: BodyInit,
  apiKey: string,
  {
    fetchImpl,
    baseUrl = ASSEMBLYAI_BASE_URL,
    mediaType,
  }: Pick<AssemblyAiOptions, "fetchImpl" | "baseUrl" | "mediaType">,
): Promise<string> {
  const res = await resolveFetch(fetchImpl)(`${baseUrl}/upload`, {
    method: "POST",
    headers: buildHeaders(apiKey, mediaType ?? "application/octet-stream"),
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`upload failed (${res.status}): ${text.trim() || res.statusText}`);
  }
  const payload = (await res.json().catch(() => null)) as UploadResponse | null;
  return requireString(payload?.upload_url, "upload_url");
}

async function submitAssemblyAiTranscript(
  audioUrl: string,
  apiKey: string,
  { fetchImpl, baseUrl = ASSEMBLYAI_BASE_URL }: Pick<AssemblyAiOptions, "fetchImpl" | "baseUrl">,
): Promise<{ id: string; status: string; text: string | null }> {
  const res = await resolveFetch(fetchImpl)(`${baseUrl}/transcript`, {
    method: "POST",
    headers: buildHeaders(apiKey, "application/json"),
    body: JSON.stringify({
      audio_url: audioUrl,
      speech_models: [...ASSEMBLYAI_DEFAULT_MODELS],
      punctuate: true,
      format_text: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`transcript create failed (${res.status}): ${text.trim() || res.statusText}`);
  }
  const payload = (await res.json().catch(() => null)) as TranscriptResponse | null;
  return {
    id: requireString(payload?.id, "transcript id"),
    status: typeof payload?.status === "string" ? payload.status : "queued",
    text: typeof payload?.text === "string" && payload.text.trim() ? payload.text.trim() : null,
  };
}

async function pollAssemblyAiTranscript(
  id: string,
  apiKey: string,
  {
    fetchImpl,
    baseUrl = ASSEMBLYAI_BASE_URL,
    pollIntervalMs = ASSEMBLYAI_POLL_INTERVAL_MS,
    timeoutMs = TRANSCRIPTION_TIMEOUT_MS,
  }: Pick<AssemblyAiOptions, "fetchImpl" | "baseUrl" | "pollIntervalMs" | "timeoutMs">,
): Promise<string | null> {
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`transcript polling timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    const res = await resolveFetch(fetchImpl)(`${baseUrl}/transcript/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: buildHeaders(apiKey),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`transcript poll failed (${res.status}): ${text.trim() || res.statusText}`);
    }
    const payload = (await res.json().catch(() => null)) as TranscriptResponse | null;
    const status = typeof payload?.status === "string" ? payload.status.trim().toLowerCase() : "";
    if (status === "completed") {
      return typeof payload?.text === "string" && payload.text.trim() ? payload.text.trim() : null;
    }
    if (status === "error") {
      const message =
        typeof payload?.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : "AssemblyAI transcription failed";
      throw new Error(message);
    }
    await delay(pollIntervalMs);
  }
}

async function transcribeUploadedAudioWithAssemblyAi(
  body: BodyInit,
  apiKey: string,
  {
    fetchImpl,
    baseUrl,
    mediaType,
    pollIntervalMs,
    timeoutMs,
  }: Pick<
    AssemblyAiOptions,
    "fetchImpl" | "baseUrl" | "mediaType" | "pollIntervalMs" | "timeoutMs"
  >,
): Promise<string | null> {
  const uploadUrl = await uploadViaAssemblyAi(body, apiKey, {
    fetchImpl,
    baseUrl,
    mediaType,
  });
  const started = await submitAssemblyAiTranscript(uploadUrl, apiKey, {
    fetchImpl,
    baseUrl,
  });
  if (started.status.trim().toLowerCase() === "completed") return started.text;
  return await pollAssemblyAiTranscript(started.id, apiKey, {
    fetchImpl,
    baseUrl,
    pollIntervalMs,
    timeoutMs,
  });
}

export async function transcribeWithAssemblyAi(
  bytes: Uint8Array,
  mediaType: string,
  apiKey: string,
  options: AssemblyAiOptions = {},
): Promise<string | null> {
  try {
    return await transcribeUploadedAudioWithAssemblyAi(
      new Blob([toArrayBuffer(bytes)], { type: mediaType }),
      apiKey,
      {
        mediaType,
        ...options,
      },
    );
  } catch (error) {
    throw wrapError("AssemblyAI transcription failed", error);
  }
}

export async function transcribeFileWithAssemblyAi({
  filePath,
  mediaType,
  apiKey,
  fetchImpl,
  baseUrl,
  pollIntervalMs,
  timeoutMs,
}: {
  filePath: string;
  mediaType: string;
  apiKey: string;
} & Pick<AssemblyAiOptions, "fetchImpl" | "baseUrl" | "pollIntervalMs" | "timeoutMs">): Promise<
  string | null
> {
  try {
    return await transcribeUploadedAudioWithAssemblyAi(
      await openAsBlob(filePath, { type: mediaType }),
      apiKey,
      {
        mediaType,
        fetchImpl,
        baseUrl,
        pollIntervalMs,
        timeoutMs,
      },
    );
  } catch (error) {
    throw wrapError("AssemblyAI transcription failed", error);
  }
}
