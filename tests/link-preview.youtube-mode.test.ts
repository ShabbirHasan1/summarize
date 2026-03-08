import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLinkPreviewClient } from "../src/content/index.js";
import { stubMissingTranscriptionEnv } from "./helpers/transcription-env.js";

const jsonResponse = (payload: unknown, status = 200) =>
  Response.json(payload, {
    status,
    headers: { "Content-Type": "application/json" },
  });

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { "Content-Type": "text/html" },
  });

describe("link preview extraction (YouTube mode)", () => {
  beforeEach(() => {
    stubMissingTranscriptionEnv();
  });

  const html =
    "<!doctype html><html><head><title>Sample</title>" +
    '<script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}},"INNERTUBE_CONTEXT_CLIENT_NAME":1});</script>' +
    '<script>var ytInitialPlayerResponse = {"getTranscriptEndpoint":{"params":"TEST_PARAMS"}};</script>' +
    "</head><body><main><p>Fallback paragraph</p></main></body></html>";

  it("uses apify only when --youtube apify", async () => {
    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input) => {
      const url = typeof input === "string" ? input : (input?.url ?? "");
      if (url.includes("youtube.com/watch") || url.includes("youtu.be/")) {
        return Promise.resolve(htmlResponse(html));
      }
      if (url.includes("api.apify.com")) {
        return Promise.resolve(jsonResponse([]));
      }
      if (url.includes("youtubei/v1/get_transcript") || url.includes("youtubei/v1/player")) {
        return Promise.reject(
          new Error(`Should not fetch YouTube web endpoints in apify mode: ${url}`),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch call: ${String(url)}`));
    });

    const client = createLinkPreviewClient({
      fetch: fetchMock as unknown as typeof fetch,
      apifyApiToken: "TEST_TOKEN",
    });

    const result = await client.fetchLinkContent("https://www.youtube.com/watch?v=abcdefghijk", {
      youtubeTranscript: "apify",
    });

    expect(result.transcriptSource).toBe("unavailable");
  });

  it("does not call apify when --youtube web", async () => {
    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input, init) => {
      const url = typeof input === "string" ? input : (input?.url ?? "");
      if (url.includes("youtube.com/watch") || url.includes("youtu.be/")) {
        return Promise.resolve(htmlResponse(html));
      }
      if (url.includes("youtubei/v1/get_transcript")) {
        expect(JSON.parse((init?.body as string) ?? "{}").params).toBe("TEST_PARAMS");
        return Promise.resolve(jsonResponse({ actions: [] }));
      }
      if (url.includes("youtubei/v1/player")) {
        return Promise.resolve(jsonResponse({}));
      }
      if (url.includes("api.apify.com")) {
        return Promise.reject(new Error(`Should not call apify in web mode: ${url}`));
      }
      return Promise.reject(new Error(`Unexpected fetch call: ${String(url)}`));
    });

    const client = createLinkPreviewClient({ fetch: fetchMock as unknown as typeof fetch });
    const result = await client.fetchLinkContent("https://www.youtube.com/watch?v=abcdefghijk", {
      youtubeTranscript: "web",
    });

    expect(result.transcriptSource).toBe("unavailable");
  });

  it("errors when --youtube yt-dlp without transcription keys", async () => {
    const html =
      "<!doctype html><html><head><title>Sample</title></head><body><main></main></body></html>";

    const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>((input) => {
      const url = typeof input === "string" ? input : (input?.url ?? "");
      if (url.includes("youtube.com/watch") || url.includes("youtu.be/")) {
        return Promise.resolve(htmlResponse(html));
      }
      return Promise.reject(new Error(`Unexpected fetch call: ${String(url)}`));
    });

    const client = createLinkPreviewClient({
      fetch: fetchMock as unknown as typeof fetch,
      ytDlpPath: "/usr/bin/yt-dlp",
    });

    await expect(
      client.fetchLinkContent("https://www.youtube.com/watch?v=abcdefghijk", {
        youtubeTranscript: "yt-dlp",
      }),
    ).rejects.toThrow(/Missing transcription provider for --youtube yt-dlp/i);
  });
});
