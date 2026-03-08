import type { Page } from "@playwright/test";

export async function getPanelPhase(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getPhase?: () => string };
      }
    ).__summarizeTestHooks;
    return hooks?.getPhase?.() ?? null;
  });
}

export async function getPanelSummaryMarkdown(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getSummaryMarkdown?: () => string };
      }
    ).__summarizeTestHooks;
    return hooks?.getSummaryMarkdown?.() ?? "";
  });
}

export async function getPanelModel(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getModel?: () => string | null };
      }
    ).__summarizeTestHooks;
    return hooks?.getModel?.() ?? null;
  });
}

export async function getPanelSlidesTimeline(
  page: Page,
): Promise<Array<{ index: number; timestamp: number | null }>> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: {
          getSlidesTimeline?: () => Array<{ index: number; timestamp: number | null }>;
        };
      }
    ).__summarizeTestHooks;
    return hooks?.getSlidesTimeline?.() ?? [];
  });
}

export async function getPanelTranscriptTimedText(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getTranscriptTimedText?: () => string | null };
      }
    ).__summarizeTestHooks;
    return hooks?.getTranscriptTimedText?.() ?? null;
  });
}

export async function setPanelTranscriptTimedText(page: Page, value: string | null) {
  await page.evaluate((nextValue) => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { setTranscriptTimedText?: (value: string | null) => void };
      }
    ).__summarizeTestHooks;
    hooks?.setTranscriptTimedText?.(nextValue);
  }, value);
}

export async function getPanelSlidesSummaryMarkdown(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getSlidesSummaryMarkdown?: () => string };
      }
    ).__summarizeTestHooks;
    return hooks?.getSlidesSummaryMarkdown?.() ?? "";
  });
}

export async function getPanelSlidesSummaryComplete(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getSlidesSummaryComplete?: () => boolean };
      }
    ).__summarizeTestHooks;
    return hooks?.getSlidesSummaryComplete?.() ?? false;
  });
}

export async function getPanelSlidesSummaryModel(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getSlidesSummaryModel?: () => string | null };
      }
    ).__summarizeTestHooks;
    return hooks?.getSlidesSummaryModel?.() ?? null;
  });
}

export async function getPanelSlideDescriptions(page: Page): Promise<Array<[number, string]>> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getSlideDescriptions?: () => Array<[number, string]> };
      }
    ).__summarizeTestHooks;
    return hooks?.getSlideDescriptions?.() ?? [];
  });
}

export async function waitForApplySlidesHook(page: Page) {
  await page.waitForFunction(
    () => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void };
        }
      ).__summarizeTestHooks;
      return Boolean(hooks?.applySlidesPayload);
    },
    null,
    { timeout: 5_000 },
  );
}

export async function waitForTranscriptTimedTextHook(page: Page) {
  await page.waitForFunction(
    () => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: {
            getTranscriptTimedText?: () => string | null;
            setTranscriptTimedText?: (value: string | null) => void;
          };
        }
      ).__summarizeTestHooks;
      return (
        typeof hooks?.getTranscriptTimedText === "function" &&
        typeof hooks?.setTranscriptTimedText === "function"
      );
    },
    null,
    { timeout: 5_000 },
  );
}

export async function waitForSettingsHydratedHook(page: Page) {
  await page.waitForFunction(
    () => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: {
            getSettingsHydrated?: () => boolean;
            getChatEnabled?: () => boolean;
          };
        }
      ).__summarizeTestHooks;
      return (
        typeof hooks?.getSettingsHydrated === "function" &&
        typeof hooks?.getChatEnabled === "function"
      );
    },
    null,
    { timeout: 5_000 },
  );
}

export async function waitForChatEnabled(page: Page, expected: boolean) {
  await page.waitForFunction(
    (target) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { getChatEnabled?: () => boolean };
        }
      ).__summarizeTestHooks;
      return hooks?.getChatEnabled?.() === target;
    },
    expected,
    { timeout: 5_000 },
  );
}

export async function applySlidesPayload(page: Page, payload: unknown) {
  await page.evaluate((value) => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void };
      }
    ).__summarizeTestHooks;
    hooks?.applySlidesPayload?.(value);
  }, payload);
}
