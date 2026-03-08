import { describe, expect, it } from "vitest";
import type { ExtractedLinkContent } from "../src/content/index.js";
import { buildUrlPrompt } from "../src/run/flows/url/summary.js";

const baseExtracted: ExtractedLinkContent = {
  url: "https://example.com/video",
  title: "Video",
  description: null,
  siteName: "YouTube",
  content: "Transcript:\nhello",
  truncated: false,
  totalCharacters: 20,
  wordCount: 2,
  transcriptCharacters: 10,
  transcriptLines: 1,
  transcriptWordCount: 2,
  transcriptSource: "captionTracks",
  transcriptionProvider: null,
  transcriptMetadata: null,
  transcriptSegments: null,
  transcriptTimedText: null,
  mediaDurationSeconds: 120,
  video: null,
  isVideoOnly: false,
  diagnostics: {
    strategy: "html",
    firecrawl: { attempted: false, used: false, cacheMode: "bypass", cacheStatus: "unknown" },
    markdown: { requested: false, used: false, provider: null },
    transcript: {
      cacheMode: "bypass",
      cacheStatus: "unknown",
      textProvided: true,
      provider: "captionTracks",
      attemptedProviders: ["captionTracks"],
    },
  },
};

describe("buildUrlPrompt with transcript timestamps", () => {
  it("forces timestamped bullets when timed transcript is present", () => {
    const prompt = buildUrlPrompt({
      extracted: {
        ...baseExtracted,
        transcriptSegments: [{ startMs: 1000, endMs: 2000, text: "hello" }],
        transcriptTimedText: "[0:01] hello",
      },
      outputLanguage: { kind: "auto" },
      lengthArg: { kind: "preset", preset: "short" },
      promptOverride: null,
      lengthInstruction: null,
      languageInstruction: null,
    });

    expect(prompt).toContain("Key moments");
    expect(prompt).toContain("Start each bullet with a [mm:ss]");
    expect(prompt).toContain("do not prepend timestamps outside the Key moments section");
    expect(prompt).toContain("The last available timestamp is 2:00");
    expect(prompt).toContain("Use 1-2 short paragraphs");
  });

  it("keeps default formatting when timestamps are unavailable", () => {
    const prompt = buildUrlPrompt({
      extracted: { ...baseExtracted, transcriptTimedText: null, transcriptSegments: null },
      outputLanguage: { kind: "auto" },
      lengthArg: { kind: "preset", preset: "short" },
      promptOverride: null,
      lengthInstruction: null,
      languageInstruction: null,
    });

    expect(prompt).not.toContain("Key moments");
    expect(prompt).toContain("Use 1-2 short paragraphs");
  });
});
