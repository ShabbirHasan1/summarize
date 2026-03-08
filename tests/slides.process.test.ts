import { describe, expect, it, vi } from "vitest";
import { runWithConcurrency } from "../src/slides/process.js";

describe("slides process helpers", () => {
  it("returns early for empty task lists", async () => {
    await expect(runWithConcurrency([], 4)).resolves.toEqual([]);
  });

  it("preserves order, clamps workers, and reports progress", async () => {
    const progress = vi.fn();
    const results = await runWithConcurrency(
      [async () => "a", async () => "b", async () => "c"],
      99,
      progress,
    );

    expect(results).toEqual(["a", "b", "c"]);
    expect(progress).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });
});
