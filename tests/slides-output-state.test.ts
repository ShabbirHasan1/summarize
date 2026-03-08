import { describe, expect, it } from "vitest";
import { createSlideOutputState } from "../src/run/flows/url/slides-output-state.js";

describe("slide output state", () => {
  it("keeps slide order and metadata from extracted slides", () => {
    const state = createSlideOutputState({
      sourceUrl: "https://example.com/watch?v=1",
      sourceKind: "youtube",
      sourceId: "1",
      slidesDir: "/tmp/slides",
      slidesDirId: null,
      sceneThreshold: 0.3,
      autoTuneThreshold: false,
      autoTune: { enabled: false, chosenThreshold: 0, confidence: 0, strategy: "none" },
      maxSlides: 10,
      minSlideDuration: 5,
      ocrRequested: false,
      ocrAvailable: false,
      slides: [
        { index: 2, timestamp: 20, imagePath: "/tmp/2.png" },
        { index: 1, timestamp: 10, imagePath: "/tmp/1.png" },
      ],
      warnings: [],
    });

    expect(state.getOrder()).toEqual([1, 2]);
    expect(state.getSlidesDir()).toBe("/tmp/slides");
    expect(state.getSourceUrl()).toBe("https://example.com/watch?v=1");
    expect(state.getSlide(1)?.imagePath).toBe("/tmp/1.png");
  });

  it("resolves waiters when a slide image arrives later", async () => {
    const state = createSlideOutputState(null);
    const waiting = state.waitForSlide(3);

    state.updateSlideEntry({ index: 3, timestamp: 30, imagePath: "/tmp/3.png" });

    await expect(waiting).resolves.toMatchObject({
      index: 3,
      timestamp: 30,
      imagePath: "/tmp/3.png",
    });
  });

  it("flushes pending waiters with partial entries when marking done", async () => {
    const state = createSlideOutputState(null);
    state.updateSlideEntry({ index: 4, timestamp: 40, imagePath: null });

    const waiting = state.waitForSlide(4);
    state.markDone();

    await expect(waiting).resolves.toMatchObject({
      index: 4,
      timestamp: 40,
      imagePath: null,
    });
    expect(state.isDone()).toBe(true);
  });
});
