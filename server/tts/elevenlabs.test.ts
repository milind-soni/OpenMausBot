import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addSharedVoice, listVoices, synthesize, verifyKey } from "./elevenlabs.ts";

const listen = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

describe("ElevenLabs redirects", () => {
  const reached: Array<{ url: string; key: string | undefined; body: string }> = [];
  const elsewhere = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      reached.push({ url: req.url ?? "", key: req.headers["xi-api-key"] as string | undefined, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ voices: [] }));
    });
  });
  let elsewhereBase = "";
  const redirector = createServer((req, res) => {
    req.resume();
    res.writeHead(307, { location: `${elsewhereBase}${req.url}` });
    res.end();
  });
  let api = "";
  const savedApi = process.env.OMB_ELEVENLABS_API;

  beforeAll(async () => {
    elsewhereBase = await listen(elsewhere);
    api = `${await listen(redirector)}/v1`;
    process.env.OMB_ELEVENLABS_API = api;
  });

  afterAll(async () => {
    if (savedApi === undefined) delete process.env.OMB_ELEVENLABS_API;
    else process.env.OMB_ELEVENLABS_API = savedApi;
    await Promise.all([elsewhere, redirector].map((s) => new Promise((r) => s.close(r))));
  });

  it("does not send the key to another origin when checking it", async () => {
    reached.length = 0;
    expect((await verifyKey("el-secret")).ok).toBe(false);
    expect(reached).toEqual([]);
  });

  it("does not send the key to another origin when listing voices", async () => {
    reached.length = 0;
    await expect(listVoices("el-secret", api)).rejects.toThrow();
    expect(reached).toEqual([]);
  });

  it("does not send the key to another origin when adding a shared voice", async () => {
    reached.length = 0;
    await expect(addSharedVoice("el-secret", api, "owner-1", "v-1", "Shared")).rejects.toThrow();
    expect(reached).toEqual([]);
  });

  it("does not send the key or the text to another origin when speaking", async () => {
    reached.length = 0;
    await expect(synthesize("private words", "v-1", "el-secret", api).audio).rejects.toThrow();
    expect(reached).toEqual([]);
  });
});
