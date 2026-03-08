import { describe, expect, it } from "vitest";
import {
  buildSlideDescriptions,
  formatSlideTimestamp,
  resolveSlidesLengthArg,
  resolveSlidesTextState,
  selectMarkdownForLayout,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/slides-state.js";

describe("sidepanel slides state", () => {
  it("hides the markdown summary in slide gallery mode", () => {
    expect(
      selectMarkdownForLayout({
        markdown: "# Summary\n\nBody",
        slidesEnabled: true,
        inputMode: "video",
        hasSlides: true,
        slidesLayout: "gallery",
      }),
    ).toBe("");
  });

  it("parses custom length values", () => {
    expect(resolveSlidesLengthArg("12k")).toEqual({ kind: "chars", maxCharacters: 12000 });
    expect(resolveSlidesLengthArg("1.5m")).toEqual({ kind: "chars", maxCharacters: 1500000 });
    expect(resolveSlidesLengthArg("bogus")).toEqual({ kind: "preset", preset: "short" });
  });

  it("formats slide timestamps", () => {
    expect(formatSlideTimestamp(2)).toBe("0:02");
    expect(formatSlideTimestamp(65)).toBe("1:05");
    expect(formatSlideTimestamp(3665)).toBe("1:01:05");
    expect(formatSlideTimestamp(null)).toBeNull();
  });

  it("keeps ocr mode hidden when ocr is too weak", () => {
    expect(
      resolveSlidesTextState({
        slides: [{ index: 1, timestamp: 0, imageUrl: "x", ocrText: "tiny" }],
        slidesOcrEnabled: true,
        slidesTranscriptAvailable: true,
        currentMode: "ocr",
      }),
    ).toEqual({
      slidesOcrAvailable: true,
      slidesTextToggleVisible: false,
      slidesTextMode: "transcript",
    });
  });

  it("builds transcript-first descriptions with ocr fallback", () => {
    const descriptions = buildSlideDescriptions({
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: "x",
          ocrText: "Ignored OCR text",
        },
        {
          index: 2,
          timestamp: 30,
          imageUrl: "y",
          ocrText: "Fallback OCR text for second slide",
        },
      ],
      transcriptTimedText:
        "[00:00] Intro text for the first slide.\n[00:30] Transcript text for the second slide.",
      lengthValue: "short",
      slidesTextMode: "transcript",
      slidesOcrEnabled: true,
      slidesOcrAvailable: true,
      slidesTranscriptAvailable: true,
    });
    expect(descriptions.get(1)).toContain("Intro text");
    expect(descriptions.get(2)).toContain("Transcript text");
  });

  it("uses ocr descriptions when transcript text is unavailable", () => {
    const descriptions = buildSlideDescriptions({
      slides: [
        {
          index: 1,
          timestamp: 90,
          imageUrl: "x",
          ocrText: "Clear OCR paragraph for the first slide with enough words to keep.",
        },
      ],
      transcriptTimedText: null,
      lengthValue: "short",
      slidesTextMode: "ocr",
      slidesOcrEnabled: true,
      slidesOcrAvailable: true,
      slidesTranscriptAvailable: false,
    });
    expect(descriptions.get(1)).toContain("Clear OCR paragraph");
  });

  it("drops gibberish ocr and keeps transcript mode when ocr is not significant", () => {
    expect(
      resolveSlidesTextState({
        slides: [
          {
            index: 1,
            timestamp: 0,
            imageUrl: "x",
            ocrText: "A b c d e f g h I J K L",
          },
          {
            index: 2,
            timestamp: 10,
            imageUrl: "y",
            ocrText: "^^ ~~ == || `` __ ++ --",
          },
        ],
        slidesOcrEnabled: true,
        slidesTranscriptAvailable: false,
        currentMode: "ocr",
      }),
    ).toEqual({
      slidesOcrAvailable: true,
      slidesTextToggleVisible: false,
      slidesTextMode: "transcript",
    });
  });

  it("keeps ocr mode available when enough meaningful ocr exists", () => {
    expect(
      resolveSlidesTextState({
        slides: [
          {
            index: 1,
            timestamp: 0,
            imageUrl: "x",
            ocrText: "Long readable OCR text for slide one with enough detail to count strongly.",
          },
          {
            index: 2,
            timestamp: 10,
            imageUrl: "y",
            ocrText: "Another readable OCR paragraph for slide two with enough detail to count.",
          },
          {
            index: 3,
            timestamp: 20,
            imageUrl: "z",
            ocrText: "Third readable OCR paragraph for slide three with enough detail to count.",
          },
        ],
        slidesOcrEnabled: true,
        slidesTranscriptAvailable: false,
        currentMode: "ocr",
      }),
    ).toEqual({
      slidesOcrAvailable: true,
      slidesTextToggleVisible: true,
      slidesTextMode: "ocr",
    });
  });

  it("keeps markdown visible outside slide gallery mode", () => {
    expect(
      selectMarkdownForLayout({
        markdown: "# Summary\n\nBody",
        slidesEnabled: false,
        inputMode: "page",
        hasSlides: false,
        slidesLayout: "stacked",
      }),
    ).toContain("Body");
  });

  it("uses the summary section for strip layouts when slides markdown exists", () => {
    expect(
      selectMarkdownForLayout({
        markdown: "# Summary\n\nMain summary\n\n## Slides\n\n- Slide 1",
        slidesEnabled: true,
        inputMode: "page",
        hasSlides: true,
        slidesLayout: "strip",
      }),
    ).toContain("Main summary");
  });
});
