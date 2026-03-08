import { describe, expect, it } from "vitest";
import { cleanOcrText, estimateOcrConfidence } from "../src/slides/ocr.js";

describe("slides ocr helpers", () => {
  it("cleans noisy lines and keeps readable content", () => {
    expect(
      cleanOcrText(
        [
          "A",
          "Readable title",
          "SUPERCALIFRAGILISTICEXPIALIDOCIOUS",
          "###",
          "second line 123",
        ].join("\n"),
      ),
    ).toBe("Readable title\nsecond line 123");
  });

  it("estimates confidence from alphanumeric density", () => {
    expect(estimateOcrConfidence("")).toBe(0);
    expect(estimateOcrConfidence("abc123")).toBe(1);
    expect(estimateOcrConfidence("abc!!!")).toBeCloseTo(0.5, 2);
  });
});
