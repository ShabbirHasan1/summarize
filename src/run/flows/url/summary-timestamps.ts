import type { ExtractedLinkContent } from "../../../content/index.js";

const TIMED_TRANSCRIPT_LINE_RE = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s+/;
const KEY_MOMENTS_HEADING_RE = /^\s{0,3}(?:#{1,6}\s*)?Key moments\s*:?\s*$/i;
const MARKDOWN_HEADING_RE = /^\s{0,3}#{1,6}\s+\S/;
const KEY_MOMENT_LINE_RE =
  /^\s*(?:[-*+]\s+)?(?:\[(\d{1,2}:\d{2}(?::\d{2})?)\]|(\d{1,2}:\d{2}(?::\d{2})?))(?=\s|[-:–—])/;

function parseTimestampSeconds(value: string): number | null {
  const parts = value.split(":").map((item) => Number(item));
  if (parts.some((item) => !Number.isFinite(item))) return null;
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return minutes * 60 + seconds;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }
  return null;
}

function formatTimestamp(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = clamped % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  if (hours <= 0) return `${minutes}:${ss}`;
  const hh = String(hours).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function readTranscriptMaxSeconds(
  extracted: Pick<ExtractedLinkContent, "transcriptSegments" | "transcriptTimedText">,
): number | null {
  let maxSeconds: number | null = null;

  for (const segment of extracted.transcriptSegments ?? []) {
    if (!segment) continue;
    const startSeconds = Math.floor(segment.startMs / 1000);
    if (Number.isFinite(startSeconds) && startSeconds >= 0) {
      maxSeconds = maxSeconds == null ? startSeconds : Math.max(maxSeconds, startSeconds);
    }
    if (typeof segment.endMs === "number" && Number.isFinite(segment.endMs)) {
      const endSeconds = Math.floor(segment.endMs / 1000);
      if (endSeconds >= 0) {
        maxSeconds = maxSeconds == null ? endSeconds : Math.max(maxSeconds, endSeconds);
      }
    }
  }

  for (const line of extracted.transcriptTimedText?.split("\n") ?? []) {
    const match = line.trim().match(TIMED_TRANSCRIPT_LINE_RE);
    if (!match) continue;
    const seconds = parseTimestampSeconds(match[1] ?? "");
    if (seconds == null) continue;
    maxSeconds = maxSeconds == null ? seconds : Math.max(maxSeconds, seconds);
  }

  return maxSeconds;
}

function trimEdgeBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") start += 1;
  while (end > start && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(start, end);
}

function readLeadingKeyMomentSeconds(line: string): number | null {
  const match = line.match(KEY_MOMENT_LINE_RE);
  const raw = match?.[1] ?? match?.[2] ?? null;
  return raw ? parseTimestampSeconds(raw) : null;
}

export function buildSummaryTimestampLimitInstruction(
  extracted: Pick<
    ExtractedLinkContent,
    "transcriptSegments" | "transcriptTimedText" | "mediaDurationSeconds"
  >,
): string | null {
  const maxSeconds = resolveSummaryTimestampUpperBound(extracted);
  if (maxSeconds == null) return null;
  return `The last available timestamp is ${formatTimestamp(maxSeconds)}. Never use a later timestamp.`;
}

export function resolveSummaryTimestampUpperBound(
  extracted: Pick<
    ExtractedLinkContent,
    "transcriptSegments" | "transcriptTimedText" | "mediaDurationSeconds"
  >,
): number | null {
  const transcriptMaxSeconds = readTranscriptMaxSeconds(extracted);
  const durationSeconds =
    typeof extracted.mediaDurationSeconds === "number" &&
    Number.isFinite(extracted.mediaDurationSeconds) &&
    extracted.mediaDurationSeconds > 0
      ? Math.floor(extracted.mediaDurationSeconds)
      : null;

  if (transcriptMaxSeconds == null) return durationSeconds;
  if (durationSeconds == null) return transcriptMaxSeconds;
  return Math.max(transcriptMaxSeconds, durationSeconds);
}

export function shouldSanitizeSummaryKeyMoments({
  extracted,
  hasSlides,
}: {
  extracted: Pick<
    ExtractedLinkContent,
    "transcriptSegments" | "transcriptTimedText" | "mediaDurationSeconds"
  >;
  hasSlides: boolean;
}): boolean {
  if (hasSlides) return false;
  return resolveSummaryTimestampUpperBound(extracted) != null;
}

export function sanitizeSummaryKeyMoments({
  markdown,
  maxSeconds,
}: {
  markdown: string;
  maxSeconds: number | null;
}): string {
  if (!markdown || maxSeconds == null) return markdown;

  const lines = markdown.split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!KEY_MOMENTS_HEADING_RE.test(line.trim())) {
      output.push(line);
      continue;
    }

    let sectionEnd = index + 1;
    while (sectionEnd < lines.length) {
      const candidate = lines[sectionEnd] ?? "";
      if (MARKDOWN_HEADING_RE.test(candidate.trim())) break;
      sectionEnd += 1;
    }

    const keptLines: string[] = [];
    let keptTimestampCount = 0;
    for (const sectionLine of lines.slice(index + 1, sectionEnd)) {
      const seconds = readLeadingKeyMomentSeconds(sectionLine);
      if (seconds != null && seconds > maxSeconds) continue;
      if (seconds != null) keptTimestampCount += 1;
      keptLines.push(sectionLine);
    }

    const normalizedLines = trimEdgeBlankLines(keptLines);
    if (keptTimestampCount > 0) {
      output.push(line);
      output.push(...normalizedLines);
    }

    index = sectionEnd - 1;
  }

  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
