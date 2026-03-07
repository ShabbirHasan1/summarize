import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDaemonServer } from "../src/daemon/server.js";

const findFreePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve port")));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });

describe("daemon auth", () => {
  it("accepts any configured token in v2 config", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-daemon-auth-"));
    const port = await findFreePort();
    const primaryToken = "test-token-primary-1234";
    const secondaryToken = "test-token-secondary-5678";
    const abortController = new AbortController();

    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const serverPromise = runDaemonServer({
      env: { HOME: home },
      fetchImpl: fetch,
      config: {
        version: 2,
        token: primaryToken,
        tokens: [primaryToken, secondaryToken],
        port,
        env: {},
        installedAt: new Date().toISOString(),
      },
      port,
      signal: abortController.signal,
      onListening: () => resolveReady?.(),
    });

    await ready;

    try {
      const primaryRes = await fetch(`http://127.0.0.1:${port}/v1/ping`, {
        headers: { Authorization: `Bearer ${primaryToken}` },
      });
      expect(primaryRes.status).toBe(200);

      const secondaryRes = await fetch(`http://127.0.0.1:${port}/v1/ping`, {
        headers: { Authorization: `Bearer ${secondaryToken}` },
      });
      expect(secondaryRes.status).toBe(200);

      const invalidRes = await fetch(`http://127.0.0.1:${port}/v1/ping`, {
        headers: { Authorization: "Bearer invalid-token-123456" },
      });
      expect(invalidRes.status).toBe(401);
    } finally {
      abortController.abort();
      await serverPromise;
    }
  });
});
