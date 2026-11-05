import { mkdtempSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createImageDailyCap } from "../image-daily-cap.ts";
import type { GeneratedImage } from "../image-generation.ts";
import { createImageToolRoutes, generateImageForTurn, IMAGE_MESSAGES } from "./image-tools.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const CFG = {
  imageGen: { key: "openai-secret", primary: { provider: "openai" as const }, fallback: { provider: "xai" as const } },
  xai: { key: "xai-secret" },
};

function okFetch(): typeof fetch {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] })));
}

const scratch = () => mkdtempSync(join(tmpdir(), "omb-image-tools-"));

function deps(overrides: { cfg?: Parameters<typeof generateImageForTurn>[1]["cfg"]; fetchImpl?: typeof fetch; parked?: number; live?: boolean; noTurn?: boolean; personTurn?: boolean; dailyCap?: number; dataDir?: string } = {}) {
  const attached: GeneratedImage[] = [];
  const live = overrides.live ?? true;
  return {
    attached,
    deps: {
      cfg: overrides.cfg ?? CFG,
      personTurn: overrides.personTurn ?? true,
      daily: createImageDailyCap(overrides.dataDir ?? scratch(), { cap: overrides.dailyCap }),
      fetchImpl: overrides.fetchImpl ?? okFetch(),
      inFlight: new Map<string, number>(),
      turn: overrides.noTurn ? null : {
        key: "thread:turn",
        parked: () => (overrides.parked ?? 0) + attached.length,
        attach: (image: GeneratedImage) => { if (live) attached.push(image); return live; },
      },
    },
  };
}

describe("generate_image for a turn", () => {
  it("attaches the base provider's image to the turn and says which provider made it", async () => {
    const { deps: d, attached } = deps();
    const result = await generateImageForTurn({ prompt: "a navy owl" }, d);
    expect(result).toEqual({ status: 201, body: { text: expect.stringContaining("OpenAI (gpt-image-2)") } });
    expect(attached).toEqual([{ bytes: PNG, mime: "image/png" }]);
  });

  it("says so when the backup made the image, and why the base did not", async () => {
    const { deps: d } = deps({ cfg: { ...CFG, imageGen: { ...CFG.imageGen, key: "" } } });
    const result = await generateImageForTurn({ prompt: "owl" }, d);
    expect(result.body).toEqual({ text: expect.stringMatching(/xAI .*backup image provider, because the base failed: Add an OpenAI image API key first/) });
  });

  it("still moves to the backup when the person names a provider the base and backup share", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] })));
    const cfg = { imageGen: { key: "openai-secret", primary: { provider: "openai" as const }, fallback: { provider: "openai" as const, model: "gpt-image-1" } } };
    const { deps: d } = deps({ cfg, fetchImpl });
    const result = await generateImageForTurn({ prompt: "owl", provider: "openai" }, d);
    expect(result).toEqual({ status: 201, body: { text: expect.stringContaining("OpenAI (gpt-image-1), the person's backup image provider") } });
  });

  it("keeps a failure outside the provider, such as saving the file, away from the model", async () => {
    const { deps: d } = deps();
    d.turn!.attach = () => { throw new Error("ENOSPC: no space left on device, open 'C:/private/attachments/x.png'"); };
    expect(await generateImageForTurn({ prompt: "owl" }, d)).toEqual({ status: 500, body: { error: IMAGE_MESSAGES.notSaved } });
  });

  it("uses the provider the person named when it is their backup", async () => {
    const fetchImpl = okFetch();
    const { deps: d } = deps({ fetchImpl });
    await generateImageForTurn({ prompt: "owl", provider: "xai" }, d);
    expect(String(vi.mocked(fetchImpl).mock.calls[0]![0])).toContain("api.x.ai");
  });

  it("refuses a provider that is neither the base nor the backup, naming the ones set", async () => {
    const { deps: d, attached } = deps();
    const result = await generateImageForTurn({ prompt: "owl", provider: "gemini" }, d);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: expect.stringMatching(/Gemini.*base is OpenAI.*backup is xAI/) });
    expect(attached).toEqual([]);
  });

  it("points the person to Settings when nothing is set up", async () => {
    const { deps: d } = deps({ cfg: { imageGen: {} } });
    const result = await generateImageForTurn({ prompt: "owl" }, d);
    expect(result).toEqual({ status: 409, body: { error: IMAGE_MESSAGES.notSetUp } });
  });

  it("stops at the turn's image limit without calling a provider", async () => {
    const fetchImpl = okFetch();
    const { deps: d } = deps({ fetchImpl, cfg: { ...CFG, imageGen: { ...CFG.imageGen, maxPerTurn: 2 } }, parked: 2 });
    const result = await generateImageForTurn({ prompt: "owl" }, d);
    expect(result.status).toBe(429);
    expect(result.body).toEqual({ error: expect.stringContaining("2 images") });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("counts an image still being made, so parallel calls cannot pass the limit", async () => {
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { finish = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await started;
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
    });
    const { deps: d, attached } = deps({ fetchImpl, cfg: { ...CFG, imageGen: { ...CFG.imageGen, maxPerTurn: 1 } } });
    const first = generateImageForTurn({ prompt: "owl" }, d);
    const second = generateImageForTurn({ prompt: "fox" }, d);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish();
    expect((await Promise.all([first, second])).map((result) => result.status)).toEqual([201, 429]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(attached).toHaveLength(1);
  });

  it("frees the slot of an image that failed, so the next call can still make one", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] })));
    const { deps: d, attached } = deps({ fetchImpl, cfg: { ...CFG, imageGen: { ...CFG.imageGen, maxPerTurn: 1 } } });
    expect((await generateImageForTurn({ prompt: "owl" }, d)).status).toBe(502);
    expect((await generateImageForTurn({ prompt: "owl" }, d)).status).toBe(201);
    expect(attached).toHaveLength(1);
  });

  it("makes no image in a turn no person started, such as a routine's or a webhook's", async () => {
    const fetchImpl = okFetch();
    const { deps: d, attached } = deps({ fetchImpl, personTurn: false });
    expect(await generateImageForTurn({ prompt: "owl" }, d)).toEqual({ status: 403, body: { error: IMAGE_MESSAGES.notPerson } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(attached).toEqual([]);
  });

  it("stops at the day's image cap without calling a provider, across turns and restarts", async () => {
    const dataDir = scratch();
    const first = deps({ dataDir, dailyCap: 2 });
    expect((await generateImageForTurn({ prompt: "owl" }, first.deps)).status).toBe(201);
    const fetchImpl = okFetch();
    const restarted = deps({ dataDir, dailyCap: 2, fetchImpl, cfg: { ...CFG, imageGen: { ...CFG.imageGen, maxPerTurn: 9 } } });
    expect((await generateImageForTurn({ prompt: "fox" }, restarted.deps)).status).toBe(201);
    expect(await generateImageForTurn({ prompt: "cat" }, restarted.deps)).toEqual({ status: 429, body: { error: IMAGE_MESSAGES.dailyCap(2) } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses when no turn is running, and drops an image whose turn ended meanwhile", async () => {
    const idle = deps({ noTurn: true });
    expect((await generateImageForTurn({ prompt: "owl" }, idle.deps)).status).toBe(409);

    const ended = deps({ live: false });
    expect((await generateImageForTurn({ prompt: "owl" }, ended.deps)).status).toBe(409);
    expect(ended.attached).toEqual([]);
  });

  it.each([{}, { prompt: " " }, { prompt: "x".repeat(4001) }, { prompt: "owl", aspect: "4:3" }])("rejects a malformed call: %j", async (body) => {
    const { deps: d } = deps();
    expect((await generateImageForTurn(body, d)).status).toBe(400);
  });

  it("returns the provider's redacted error, not its body", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("Bearer openai-secret", { status: 500 }));
    const { deps: d } = deps({ fetchImpl });
    const result = await generateImageForTurn({ prompt: "owl" }, d);
    expect(result).toEqual({ status: 502, body: { error: "OpenAI image generation failed (HTTP 500, model gpt-image-2)" } });
  });
});

describe("the generate_image route", () => {
  function route(options: { fetchImpl: typeof fetch; requireActive?: () => void; personTurn?: boolean }) {
    const live = new Map([["thread", "turn-1"]]);
    const parked = new Map<string, GeneratedImage[]>();
    const routes = createImageToolRoutes({
      config: () => ({ ...CFG, imageGen: { ...CFG.imageGen, maxPerTurn: 1 } }),
      dataDir: scratch(),
      fetchImpl: options.fetchImpl,
      liveTurn: (threadId) => live.get(threadId),
      key: (threadId, turnId) => `${threadId}:${turnId}`,
      images: (key) => parked.get(key)?.length ?? 0,
      park: (key, image) => { parked.set(key, [...parked.get(key) ?? [], image]); },
    });
    const res = new ServerResponse(new IncomingMessage(new Socket()));
    const call = async () => {
      let answer: { status: number; body: unknown } | undefined;
      await routes.internal({
        method: "POST", path: "/api/internal/images/generate", res,
        json: (_res: ServerResponse, status: number, body: unknown) => { answer = { status, body }; },
        readBody: async () => ({ prompt: "owl" }),
        threadId: "thread", requireActive: options.requireActive ?? (() => {}), personTurn: options.personTurn ?? true,
      });
      return answer!;
    };
    return { call, live, parked, res };
  }

  it("drops an image whose turn was replaced while it was made, and frees its slot", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await held;
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
    });
    const r = route({ fetchImpl });
    const pending = r.call();
    await new Promise((resolve) => setTimeout(resolve, 0));
    r.live.set("thread", "turn-2");
    release();
    expect(await pending).toEqual({ status: 409, body: { error: IMAGE_MESSAGES.noTurn } });
    expect([...r.parked.values()].flat()).toEqual([]);
    expect((await r.call()).status).toBe(201);
    expect(r.parked.get("thread:turn-2")).toHaveLength(1);
  });

  it("answers 401 and parks nothing when the capability expired while the image was made", async () => {
    let checks = 0;
    const requireActive = () => {
      if (++checks === 2) throw Object.assign(new Error("the internal turn capability has expired"), { status: 401 });
    };
    const r = route({ fetchImpl: okFetch(), requireActive });
    expect(await r.call()).toEqual({ status: 401, body: { error: "the internal turn capability has expired" } });
    expect([...r.parked.values()].flat()).toEqual([]);
    expect((await r.call()).status).toBe(201);
  });

  it("answers a turn no person started with a refusal the bot can pass on, and parks nothing", async () => {
    const fetchImpl = okFetch();
    const r = route({ fetchImpl, personTurn: false });
    expect(await r.call()).toEqual({ status: 403, body: { error: IMAGE_MESSAGES.notPerson } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect([...r.parked.values()].flat()).toEqual([]);
  });

  it("leaves other requests to the next route", async () => {
    const routes = createImageToolRoutes({ config: () => CFG, dataDir: scratch(), liveTurn: () => "turn", key: (a, b) => a + b, images: () => 0, park: () => {} });
    const answered = vi.fn<(res: ServerResponse, status: number, body: unknown) => void>();
    const res = new ServerResponse(new IncomingMessage(new Socket()));
    const out = await routes.internal({ method: "POST", path: "/api/internal/voice-note", res, json: answered, readBody: async () => ({}), threadId: "t", requireActive: () => {}, personTurn: true });
    expect(typeof out).toBe("symbol");
    expect(answered).not.toHaveBeenCalled();
  });

  it("cancels the provider call when the bot's tool call goes away", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      signal = init!.signal!;
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const r = route({ fetchImpl });
    const pending = r.call();
    await new Promise((resolve) => setTimeout(resolve, 0));
    r.res.emit("close");
    expect(await pending).toEqual({ status: 409, body: { error: "Image generation was cancelled" } });
    expect(signal!.aborted).toBe(true);
    expect([...r.parked.values()].flat()).toEqual([]);
  });
});
