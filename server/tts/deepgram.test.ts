import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";

let server: Server;
let status = 200;
let contentType = "audio/mpeg";
let audio = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
const seen: Array<{ url: string; authorization?: string; body: string }> = [];
const config: AppConfig = { tts: { provider: "deepgram", voice: "aura-2-asteria-en", deepgramKey: "fake-deepgram-key" } };
const voice = () => import("./index.ts");

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ url: req.url ?? "", authorization: req.headers.authorization, body });
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "fixture-error" }));
      } else if (req.url?.includes("/listen")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          results: {
            channels: [{ alternatives: [{ transcript: "hello from deepgram" }] }]
          }
        }));
      } else {
        res.writeHead(200, { "content-type": contentType });
        res.end(audio);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP fixture");
  vi.stubEnv("OMB_DEEPGRAM_API", `http://127.0.0.1:${address.port}/v1`);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

beforeEach(() => {
  status = 200;
  contentType = "audio/mpeg";
  audio = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  seen.length = 0;
});

describe("Deepgram voice", () => {
  it("lists available Deepgram Aura voices", async () => {
    const { listVoices } = await voice();
    const voices = await listVoices(config);
    expect(voices.length).toBeGreaterThan(0);
    expect(voices.some((v) => v.id === "aura-2-asteria-en")).toBe(true);
  });

  it("synthesizes speech using Deepgram Aura API", async () => {
    const { speak } = await voice();
    const result = await speak(config, "Hello world", "aura-2-asteria-en");
    expect(result.mime).toBe("audio/mpeg");
    expect(seen.length).toBe(1);
    expect(seen[0]?.authorization).toBe("Token fake-deepgram-key");
    expect(seen[0]?.url).toContain("aura-2-asteria-en");
  });
});
