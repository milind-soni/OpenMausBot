import { createServer, request, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import * as openai from "../tts/openai.ts";
import { createTtsRoutes } from "./tts.ts";

let server: Server;
let url: string;
let cfg: AppConfig = {};
beforeAll(async () => {
  const route = createTtsRoutes({ config: () => cfg });
  server = createServer((req, res) => {
    const address = new URL(req.url ?? "/", "http://localhost");
    void route({ req, res, url: address, path: address.pathname, method: req.method ?? "GET", json, readBody,
      auth: { kind: "loopback", scopes: ["admin", "client"] } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP fixture");
  url = `http://127.0.0.1:${address.port}/api/tts/speak`;
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
const post = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "fixture text", voiceId: "marin" }) });

describe("OpenAI speech HTTP boundary", () => {
  it("keeps a missing key on the server and sends an English fallback with a translation key", async () => {
    cfg = { live: { key: "never-use-live-key" }, tts: { provider: "openai" } };
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: new openai.OpenAiVoiceError("key").message, errorKey: "voice.openai.error.key" });
  });
  it("returns a safe translated error without remote details or the credential", async () => {
    cfg = { openai: { key: "fixture-key" }, tts: { provider: "openai" } };
    vi.spyOn(openai, "synthesize").mockRejectedValue(new openai.OpenAiVoiceError("auth"));
    const response = await post();
    expect(response.status).toBe(502);
    const body = await response.json() as { errorKey: string };
    expect(body.errorKey).toBe("voice.openai.error.auth");
    expect(JSON.stringify(body)).not.toContain("fixture-key");
    expect(JSON.stringify(body)).not.toContain("fixture text");
  });
  it("leaves normal completed requests alive until audio is ready and returns WAV", async () => {
    cfg = { openai: { key: "fixture-key" }, tts: { provider: "openai" } };
    let release!: () => void;
    let pendingSignal: AbortSignal | undefined;
    const spy = vi.spyOn(openai, "synthesize").mockImplementation((_text, _voice, _key, signal) => new Promise((resolve) => {
      pendingSignal = signal;
      release = () => resolve({ mime: "audio/wav", bytes: Buffer.from("fixture-wav") });
    }));
    const pending = post();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
    expect(pendingSignal?.aborted).toBe(false);
    release();
    const response = await pending;
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("fixture-wav");
    expect(spy).toHaveBeenCalledOnce();
  });
  it("aborts server speech generation when the client cancels after sending the text", async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(openai, "synthesize").mockImplementation((_text, _voice, _key, supplied) => new Promise((_resolve, reject) => {
      signal = supplied;
      supplied?.addEventListener("abort", () => reject(new openai.OpenAiVoiceError("cancelled")), { once: true });
    }));
    const req = request(url, { method: "POST", headers: { "content-type": "application/json" } });
    req.on("error", () => {});
    req.end(JSON.stringify({ text: "fixture text", voiceId: "marin" }));
    await vi.waitFor(() => expect(signal).toBeDefined());
    req.destroy();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });
});
