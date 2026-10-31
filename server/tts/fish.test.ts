import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const listen = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

describe("Fish Audio redirects", () => {
  const reached: Array<{ url: string; key: string | undefined; body: string }> = [];
  const elsewhere = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      reached.push({ url: req.url ?? "", key: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ items: [], has_more: false }));
    });
  });
  let elsewhereBase = "";
  const redirector = createServer((req, res) => {
    req.resume();
    res.writeHead(307, { location: `${elsewhereBase}${req.url}` });
    res.end();
  });
  const fish = () => import("./fish.ts");

  beforeAll(async () => {
    elsewhereBase = await listen(elsewhere);
    vi.stubEnv("OMB_FISH_AUDIO_API", await listen(redirector));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all([elsewhere, redirector].map((s) => new Promise((r) => s.close(r))));
  });

  it("does not follow a redirect when checking the key", async () => {
    reached.length = 0;
    expect((await (await fish()).verifyKey("fish-secret")).ok).toBe(false);
    expect(reached).toEqual([]);
  });

  it("does not follow a redirect when listing voices", async () => {
    reached.length = 0;
    await expect((await fish()).listVoices("fish-secret")).rejects.toThrow();
    expect(reached).toEqual([]);
  });

  it("does not send the text to another origin when speaking", async () => {
    reached.length = 0;
    await expect((await fish()).synthesize("private words", "v-1", "fish-secret")).rejects.toThrow();
    expect(reached).toEqual([]);
  });
});
