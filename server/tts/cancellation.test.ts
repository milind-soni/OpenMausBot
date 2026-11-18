import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { json, readBody } from "../harness/http.ts";

let provider: Server;
let api: Server;
let providerUrl = "";
let apiUrl = "";
let config: AppConfig = {};
let entered: (response: ServerResponse) => void;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP fixture");
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  provider = createServer((req, res) => {
    req.resume();
    const gemini = req.url === "/interactions";
    res.writeHead(200, { "content-type": gemini ? "application/json" : "audio/mpeg" });
    res.write(gemini
      ? '{"steps":[{"type":"model_output","content":[{"type":"audio","mime_type":"audio/wav","data":"'
      : Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    entered(res);
  });
  providerUrl = await listen(provider);
  vi.stubEnv("OMB_ELEVENLABS_API", `${providerUrl}/v1`);
  vi.stubEnv("OMB_FISH_AUDIO_API", providerUrl);
  vi.stubEnv("OMB_XAI_TTS_API", `${providerUrl}/v1`);
  vi.stubEnv("OMB_GEMINI_TTS_API", providerUrl);
  const { createTtsRoutes } = await import("../routes/tts.ts");
  const route = createTtsRoutes({ config: () => config });
  api = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await route({
      req, res, url, path: url.pathname, method: req.method ?? "GET", json, readBody,
      auth: { kind: "loopback", scopes: ["admin", "client"] },
    });
  });
  apiUrl = await listen(api);
});

afterEach(() => {
  api.closeAllConnections();
  provider.closeAllConnections();
});

afterAll(async () => {
  await Promise.all([api, provider].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.unstubAllEnvs();
});

describe("stopping read aloud", () => {
  it.each(["elevenlabs", "fish", "gemini", "xai", "chatterbox"] as const)(
    "closes the in-flight %s request when the reader disconnects", async (kind) => {
      config = {
        xai: { key: "local-fixture-only" },
        tts: {
          provider: kind, voice: kind === "gemini" ? "Kore" : "test-voice", baseUrl: providerUrl,
          key: "local-fixture-only", fishKey: "local-fixture-only", geminiKey: "local-fixture-only",
        },
      };
      const receiving = new Promise<ServerResponse>((resolve) => { entered = resolve; });
      const controller = new AbortController();
      const response = fetch(`${apiUrl}/api/tts/speak`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "A reply the person stopped reading aloud." }), signal: controller.signal,
      }).catch((error: unknown) => error);
      const streaming = await receiving;
      const closed = once(streaming, "close", { signal: AbortSignal.timeout(2_000) });
      controller.abort();
      expect(await response).toBeInstanceOf(Error);
      await closed;
      expect(streaming.writableEnded).toBe(false);
    },
  );
});
