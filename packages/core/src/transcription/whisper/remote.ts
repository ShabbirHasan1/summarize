import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WhisperProgressEvent, WhisperTranscriptionResult } from "./types.js";
import { transcribeWithAssemblyAi, transcribeFileWithAssemblyAi } from "./assemblyai.js";
import {
  cloudProviderLabel,
  formatCloudFallbackTargets,
  resolveCloudProviderOrder,
  type CloudProvider,
} from "./cloud-providers.js";
import { DEFAULT_SEGMENT_SECONDS, MAX_OPENAI_UPLOAD_BYTES } from "./constants.js";
import { transcribeWithFal } from "./fal.js";
import { isFfmpegAvailable, transcodeBytesToMp3 } from "./ffmpeg.js";
import { transcribeFileWithGemini, transcribeWithGemini } from "./gemini.js";
import { shouldRetryOpenAiViaFfmpeg, transcribeWithOpenAi } from "./openai.js";
import { buildMissingTranscriptionProviderMessage } from "./provider-setup.js";
import { formatBytes, readFirstBytes, wrapError } from "./utils.js";

type Env = Record<string, string | undefined>;

type CloudArgs = {
  groqApiKey: string | null;
  groqError?: Error | null;
  assemblyaiApiKey: string | null;
  geminiApiKey: string | null;
  openaiApiKey: string | null;
  falApiKey: string | null;
  env: Env;
};

type FailedAttempt = {
  provider: CloudProvider | "groq" | null;
  error: Error;
};

function withMergedNotes(
  result: WhisperTranscriptionResult,
  notes: string[],
): WhisperTranscriptionResult {
  if (result.notes.length === 0) return { ...result, notes };
  return { ...result, notes: [...notes, ...result.notes] };
}

function buildNoProviderResult({
  notes,
  groqApiKey,
  groqError,
}: {
  notes: string[];
  groqApiKey: string | null;
  groqError: Error | null;
}): WhisperTranscriptionResult {
  if (groqApiKey) {
    return {
      text: null,
      provider: "groq",
      error: groqError ?? new Error("No transcription providers available"),
      notes,
    };
  }
  return {
    text: null,
    provider: null,
    error: new Error(buildMissingTranscriptionProviderMessage()),
    notes,
  };
}

async function transcribeBytesAcrossProviders({
  providerOrder,
  bytes,
  mediaType,
  filename,
  notes,
  groqApiKey,
  groqError = null,
  assemblyaiApiKey,
  geminiApiKey,
  openaiApiKey,
  falApiKey,
  env,
  onProgress,
  transcribeOversizedBytesWithChunking,
}: {
  providerOrder: CloudProvider[];
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
  notes: string[];
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  transcribeOversizedBytesWithChunking?: (args: {
    bytes: Uint8Array;
    mediaType: string;
    filename: string | null;
    onProgress?: ((event: WhisperProgressEvent) => void) | null;
  }) => Promise<WhisperTranscriptionResult>;
} & CloudArgs): Promise<WhisperTranscriptionResult> {
  if (providerOrder.length === 0) {
    return buildNoProviderResult({ notes, groqApiKey, groqError });
  }

  let currentBytes = bytes;
  let currentMediaType = mediaType;
  let currentFilename = filename;
  let lastFailure: FailedAttempt | null = null;

  for (const [index, provider] of providerOrder.entries()) {
    let error: Error | null = null;

    if (provider === "assemblyai") {
      try {
        const text = await transcribeWithAssemblyAi(
          currentBytes,
          currentMediaType,
          assemblyaiApiKey!,
        );
        if (text) return { text, provider: "assemblyai", error: null, notes };
        error = new Error("AssemblyAI transcription returned empty text");
      } catch (caught) {
        error =
          caught instanceof Error ? caught : wrapError("AssemblyAI transcription failed", caught);
      }
    }

    if (provider === "gemini") {
      try {
        const text = await transcribeWithGemini(
          currentBytes,
          currentMediaType,
          currentFilename,
          geminiApiKey!,
          { env },
        );
        if (text) return { text, provider: "gemini", error: null, notes };
        error = new Error("Gemini transcription returned empty text");
      } catch (caught) {
        error = wrapError("Gemini transcription failed", caught);
      }
    }

    if (provider === "openai") {
      if (
        currentBytes.byteLength > MAX_OPENAI_UPLOAD_BYTES &&
        transcribeOversizedBytesWithChunking &&
        openaiApiKey
      ) {
        const canChunk = await isFfmpegAvailable();
        if (canChunk) {
          return withMergedNotes(
            await transcribeOversizedBytesWithChunking({
              bytes: currentBytes,
              mediaType: currentMediaType,
              filename: currentFilename,
              onProgress,
            }),
            notes,
          );
        }
        notes.push(
          `Media too large for Whisper upload (${formatBytes(currentBytes.byteLength)}); transcribing first ${formatBytes(MAX_OPENAI_UPLOAD_BYTES)} only (install ffmpeg for full transcription)`,
        );
        currentBytes = currentBytes.slice(0, MAX_OPENAI_UPLOAD_BYTES);
      }

      try {
        const text = await transcribeWithOpenAi(
          currentBytes,
          currentMediaType,
          currentFilename,
          openaiApiKey!,
          { env },
        );
        if (text) return { text, provider: "openai", error: null, notes };
        error = new Error("OpenAI transcription returned empty text");
      } catch (caught) {
        error = wrapError("OpenAI transcription failed", caught);
      }

      if (error && shouldRetryOpenAiViaFfmpeg(error)) {
        const canTranscode = await isFfmpegAvailable();
        if (canTranscode) {
          try {
            notes.push("OpenAI could not decode media; transcoding via ffmpeg and retrying");
            const mp3Bytes = await transcodeBytesToMp3(currentBytes);
            const retried = await transcribeWithOpenAi(
              mp3Bytes,
              "audio/mpeg",
              "audio.mp3",
              openaiApiKey!,
              { env },
            );
            if (retried) return { text: retried, provider: "openai", error: null, notes };
            error = new Error("OpenAI transcription returned empty text after ffmpeg transcode");
            currentBytes = mp3Bytes;
            currentMediaType = "audio/mpeg";
            currentFilename = "audio.mp3";
          } catch (caught) {
            notes.push(
              `ffmpeg transcode failed; cannot retry OpenAI decode error: ${
                caught instanceof Error ? caught.message : String(caught)
              }`,
            );
          }
        } else {
          notes.push("OpenAI could not decode media; install ffmpeg to enable transcoding retry");
        }
      }
    }

    if (provider === "fal") {
      if (!currentMediaType.toLowerCase().startsWith("audio/")) {
        notes.push(`Skipping FAL transcription: unsupported mediaType ${currentMediaType}`);
        continue;
      }
      try {
        const text = await transcribeWithFal(currentBytes, currentMediaType, falApiKey!);
        if (text) return { text, provider: "fal", error: null, notes };
        error = new Error("FAL transcription returned empty text");
      } catch (caught) {
        error = wrapError("FAL transcription failed", caught);
      }
    }

    if (!error) continue;
    lastFailure = { provider, error };
    const remaining = providerOrder.slice(index + 1).filter((candidate) => {
      if (candidate !== "fal") return true;
      return currentMediaType.toLowerCase().startsWith("audio/");
    });
    if (remaining.length > 0) {
      notes.push(
        `${cloudProviderLabel(provider, false)} transcription failed; falling back to ${formatCloudFallbackTargets(remaining)}: ${error.message}`,
      );
    }
  }

  if (lastFailure) {
    return {
      text: null,
      provider: lastFailure.provider,
      error: lastFailure.error,
      notes,
    };
  }
  return buildNoProviderResult({ notes, groqApiKey, groqError });
}

export async function transcribeBytesWithRemoteFallbacks({
  bytes,
  mediaType,
  filename,
  notes,
  groqApiKey,
  groqError = null,
  assemblyaiApiKey,
  geminiApiKey,
  openaiApiKey,
  falApiKey,
  env,
  onProgress,
  transcribeOversizedBytesWithChunking,
}: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
  notes: string[];
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  transcribeOversizedBytesWithChunking: (args: {
    bytes: Uint8Array;
    mediaType: string;
    filename: string | null;
    onProgress?: ((event: WhisperProgressEvent) => void) | null;
  }) => Promise<WhisperTranscriptionResult>;
} & CloudArgs): Promise<WhisperTranscriptionResult> {
  return await transcribeBytesAcrossProviders({
    providerOrder: resolveCloudProviderOrder({
      assemblyaiApiKey,
      geminiApiKey,
      openaiApiKey,
      falApiKey,
    }),
    bytes,
    mediaType,
    filename,
    notes,
    groqApiKey,
    groqError,
    assemblyaiApiKey,
    geminiApiKey,
    openaiApiKey,
    falApiKey,
    env,
    onProgress,
    transcribeOversizedBytesWithChunking,
  });
}

export async function transcribeFileWithRemoteFallbacks({
  filePath,
  mediaType,
  filename,
  notes,
  groqApiKey,
  groqError = null,
  assemblyaiApiKey,
  geminiApiKey,
  openaiApiKey,
  falApiKey,
  env,
  totalDurationSeconds,
  onProgress,
  transcribeChunkedFile,
}: {
  filePath: string;
  mediaType: string;
  filename: string | null;
  notes: string[];
  totalDurationSeconds: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  transcribeChunkedFile: (args: {
    filePath: string;
    segmentSeconds: number;
    totalDurationSeconds: number | null;
    onProgress?: ((event: WhisperProgressEvent) => void) | null;
  }) => Promise<WhisperTranscriptionResult>;
} & CloudArgs): Promise<WhisperTranscriptionResult> {
  const providerOrder = resolveCloudProviderOrder({
    assemblyaiApiKey,
    geminiApiKey,
    openaiApiKey,
    falApiKey,
  });
  if (providerOrder.length === 0) {
    return buildNoProviderResult({ notes, groqApiKey, groqError });
  }

  const stat = await fs.stat(filePath);
  onProgress?.({
    partIndex: null,
    parts: null,
    processedDurationSeconds: null,
    totalDurationSeconds,
  });
  let cachedBytes: Uint8Array | null = null;
  const readFileBytes = async () => {
    if (cachedBytes) return cachedBytes;
    cachedBytes = new Uint8Array(await fs.readFile(filePath));
    return cachedBytes;
  };

  let lastFailure: FailedAttempt | null = null;

  for (const [index, provider] of providerOrder.entries()) {
    let error: Error | null = null;

    if (provider === "assemblyai") {
      try {
        const text = await transcribeFileWithAssemblyAi({
          filePath,
          mediaType,
          apiKey: assemblyaiApiKey!,
        });
        if (text) return { text, provider: "assemblyai", error: null, notes };
        error = new Error("AssemblyAI transcription returned empty text");
      } catch (caught) {
        error =
          caught instanceof Error ? caught : wrapError("AssemblyAI transcription failed", caught);
      }
    }

    if (provider === "gemini") {
      try {
        const text = await transcribeFileWithGemini({
          filePath,
          mediaType,
          filename,
          apiKey: geminiApiKey!,
          env,
        });
        if (text) return { text, provider: "gemini", error: null, notes };
        error = new Error("Gemini transcription returned empty text");
      } catch (caught) {
        error = wrapError("Gemini transcription failed", caught);
      }
    }

    if (provider === "openai" || provider === "fal") {
      if (provider === "openai" && stat.size > MAX_OPENAI_UPLOAD_BYTES) {
        const canChunk = await isFfmpegAvailable();
        if (canChunk) {
          return withMergedNotes(
            await transcribeChunkedFile({
              filePath,
              segmentSeconds: DEFAULT_SEGMENT_SECONDS,
              totalDurationSeconds,
              onProgress,
            }),
            notes,
          );
        }
        notes.push(
          `Media too large for Whisper upload (${formatBytes(stat.size)}); install ffmpeg to enable chunked transcription`,
        );
        const head = await readFirstBytes(filePath, MAX_OPENAI_UPLOAD_BYTES);
        return withMergedNotes(
          await transcribeBytesAcrossProviders({
            providerOrder: providerOrder.slice(index),
            bytes: head,
            mediaType,
            filename,
            notes: [],
            groqApiKey,
            groqError,
            assemblyaiApiKey,
            geminiApiKey,
            openaiApiKey,
            falApiKey,
            env,
            onProgress,
          }),
          notes,
        );
      }

      return withMergedNotes(
        await transcribeBytesAcrossProviders({
          providerOrder: providerOrder.slice(index),
          bytes: await readFileBytes(),
          mediaType,
          filename,
          notes: [],
          groqApiKey,
          groqError,
          assemblyaiApiKey,
          geminiApiKey,
          openaiApiKey,
          falApiKey,
          env,
          onProgress,
        }),
        notes,
      );
    }

    if (!error) continue;
    lastFailure = { provider, error };
    const remaining = providerOrder.slice(index + 1);
    if (remaining.length > 0) {
      notes.push(
        `${cloudProviderLabel(provider, false)} transcription failed; falling back to ${formatCloudFallbackTargets(remaining)}: ${error.message}`,
      );
    }
  }

  if (lastFailure) {
    return {
      text: null,
      provider: lastFailure.provider,
      error: lastFailure.error,
      notes,
    };
  }
  return buildNoProviderResult({ notes, groqApiKey, groqError });
}

export async function transcribeOversizedBytesViaTempFile({
  bytes,
  mediaType,
  filename,
  onProgress,
  transcribeFile,
}: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  transcribeFile: (args: {
    filePath: string;
    mediaType: string;
    filename: string | null;
    onProgress?: ((event: WhisperProgressEvent) => void) | null;
  }) => Promise<WhisperTranscriptionResult>;
}): Promise<WhisperTranscriptionResult> {
  const tempFile = join(tmpdir(), `summarize-whisper-${randomUUID()}`);
  try {
    await fs.writeFile(tempFile, bytes);
    return await transcribeFile({
      filePath: tempFile,
      mediaType,
      filename,
      onProgress,
    });
  } finally {
    await fs.unlink(tempFile).catch(() => {});
  }
}
