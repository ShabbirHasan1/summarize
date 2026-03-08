import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runProcess: vi.fn(),
  runProcessCapture: vi.fn(),
}));

vi.mock("../src/slides/process.js", () => ({
  runProcess: mocks.runProcess,
  runProcessCapture: mocks.runProcessCapture,
  runProcessCaptureBuffer: vi.fn(),
}));

import {
  adjustTimestampWithinSegment,
  applyMaxSlidesFilter,
  applyMinDurationFilter,
  buildIntervalTimestamps,
  buildSceneSegments,
  buildSegments,
  clamp,
  detectSceneTimestamps,
  filterTimestampsByMinDuration,
  findSceneSegment,
  mergeTimestamps,
  parseShowinfoTimestamp,
  probeVideoInfo,
  selectTimestampTargets,
} from "../src/slides/scene-detection.js";

describe("slides scene detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("covers parsing, clamping, segments, and timestamp filters", () => {
    expect(clamp(-1, 0, 5)).toBe(0);
    expect(clamp(9, 0, 5)).toBe(5);
    expect(parseShowinfoTimestamp("foo")).toBeNull();
    expect(parseShowinfoTimestamp("showinfo pts_time:12.34")).toBe(12.34);

    expect(buildSegments(null, 4)).toEqual([{ start: 0, duration: 0 }]);
    expect(buildSegments(240, 3)).toEqual([
      { start: 0, duration: 80 },
      { start: 80, duration: 80 },
      { start: 160, duration: 80 },
    ]);

    expect(filterTimestampsByMinDuration([5, 1, 1.4, 4], 1.5)).toEqual([1, 4]);
    expect(mergeTimestamps([1, 5], [1.2, 10], 2)).toEqual([1, 5, 10]);

    const removed: string[] = [];
    const warnings: string[] = [];
    expect(
      applyMinDurationFilter(
        [
          { index: 1, timestamp: 0, imagePath: "a.png" },
          { index: 2, timestamp: 1, imagePath: "b.png" },
          { index: 3, timestamp: 4, imagePath: "c.png" },
        ],
        2,
        warnings,
        (file) => removed.push(file),
      ),
    ).toEqual([
      { index: 1, timestamp: 0, imagePath: "a.png" },
      { index: 2, timestamp: 4, imagePath: "c.png" },
    ]);
    expect(removed).toEqual(["b.png"]);
    expect(warnings).toEqual(["Filtered 1 slides by min duration"]);
  });

  it("builds scene segments, finds active segments, and adjusts timestamps safely", () => {
    const segments = buildSceneSegments([4, 4.02, 10], 15);
    expect(segments).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 10 },
      { start: 10, end: 15 },
    ]);

    expect(findSceneSegment(segments, 9.9)).toEqual({ start: 4, end: 10 });
    expect(findSceneSegment([], 2)).toBeNull();
    expect(adjustTimestampWithinSegment(0.1, { start: 0, end: 4 })).toBeCloseTo(0.32, 2);
    expect(adjustTimestampWithinSegment(30, { start: 10, end: 11 })).toBeCloseTo(10.8, 2);
    expect(adjustTimestampWithinSegment(30, { start: 10, end: null })).toBe(30);
  });

  it("selects scene targets near interval targets and builds interval fallbacks", () => {
    expect(
      selectTimestampTargets({
        targets: [5, 20, 40],
        sceneTimestamps: [4.5, 18.5, 39, 39.2],
        minDurationSeconds: 5,
        intervalSeconds: 15,
      }),
    ).toEqual([4.5, 18.5, 39]);

    expect(
      selectTimestampTargets({
        targets: [5, 8],
        sceneTimestamps: [],
        minDurationSeconds: 10,
        intervalSeconds: 6,
      }),
    ).toEqual([5, 8]);

    expect(
      buildIntervalTimestamps({
        durationSeconds: 600,
        minDurationSeconds: 12,
        maxSlides: 3,
      }),
    ).toEqual({
      intervalSeconds: 200,
      timestamps: [0, 200, 400],
    });
    expect(
      buildIntervalTimestamps({
        durationSeconds: null,
        minDurationSeconds: 12,
        maxSlides: 3,
      }),
    ).toBeNull();
  });

  it("detects scene timestamps across segments and reports progress", async () => {
    mocks.runProcess.mockImplementation(async ({ args, onStderrLine }) => {
      const startIndex = args.indexOf("-ss");
      const offset = startIndex >= 0 ? Number(args[startIndex + 1]) : 0;
      onStderrLine?.(`showinfo pts_time:${1 + offset}`);
    });
    const progress: Array<[number, number]> = [];

    const timestamps = await detectSceneTimestamps({
      ffmpegPath: "ffmpeg",
      inputPath: "/tmp/video.mp4",
      threshold: 0.25,
      timeoutMs: 1000,
      segments: [
        { start: 0, duration: 10 },
        { start: 10, duration: 5 },
      ],
      workers: 4,
      onSegmentProgress: (completed, total) => progress.push([completed, total]),
      runWithConcurrency: async (tasks, _workers, onProgress) => {
        const results = [];
        let completed = 0;
        for (const task of tasks) {
          results.push(await task());
          completed += 1;
          onProgress?.(completed, tasks.length);
        }
        return results;
      },
    });

    expect(timestamps).toEqual([1, 21]);
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(mocks.runProcess).toHaveBeenCalledTimes(2);
  });

  it("parses ffprobe output and falls back to format duration", async () => {
    mocks.runProcessCapture.mockResolvedValueOnce(
      JSON.stringify({
        streams: [
          { codec_type: "audio", duration: "1" },
          { codec_type: "video", width: 1920, height: 1080, duration: "12.5" },
        ],
      }),
    );
    await expect(
      probeVideoInfo({ ffprobePath: "ffprobe", inputPath: "/tmp/video.mp4", timeoutMs: 99999 }),
    ).resolves.toEqual({
      durationSeconds: 12.5,
      width: 1920,
      height: 1080,
    });

    mocks.runProcessCapture.mockResolvedValueOnce(
      JSON.stringify({
        streams: [{ codec_type: "video", width: 1280, height: 720 }],
        format: { duration: "90" },
      }),
    );
    await expect(
      probeVideoInfo({ ffprobePath: "ffprobe", inputPath: "/tmp/video.mp4", timeoutMs: 99999 }),
    ).resolves.toEqual({
      durationSeconds: 90,
      width: 1280,
      height: 720,
    });

    mocks.runProcessCapture.mockRejectedValueOnce(new Error("boom"));
    await expect(
      probeVideoInfo({ ffprobePath: "ffprobe", inputPath: "/tmp/video.mp4", timeoutMs: 99999 }),
    ).resolves.toEqual({
      durationSeconds: null,
      width: null,
      height: null,
    });
  });

  it("trims extra slides when maxSlides is exceeded", () => {
    const warnings: string[] = [];
    const removed: string[] = [];
    expect(
      applyMaxSlidesFilter(
        [
          { index: 1, timestamp: 0, imagePath: "a.png" },
          { index: 2, timestamp: 10, imagePath: "b.png" },
          { index: 3, timestamp: 20, imagePath: "c.png" },
        ],
        2,
        warnings,
        (file) => removed.push(file),
      ),
    ).toEqual([
      { index: 1, timestamp: 0, imagePath: "a.png" },
      { index: 2, timestamp: 10, imagePath: "b.png" },
    ]);
    expect(removed).toEqual(["c.png"]);
    expect(warnings).toEqual(["Trimmed slides to max 2"]);
  });
});
