import { afterEach, describe, expect, it, vi } from "vitest";

import { generateImage, imageSlotConfigured } from "./image-generation.ts";
import { configureHiggsfield, createHiggsfieldBackend, generateHiggsfieldImage, higgsfieldReady, HiggsfieldError } from "./higgsfield-mcp.ts";
import { startFakeHttpMcp, type FakeHttpMcp } from "./testing/fake-http-mcp-server.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const FILE = "https://cdn.higgsfield.ai/out/1.png";
const TOOLS = ["generate_image", "job_status"].map((name) => ({ name, inputSchema: { type: "object" } }));

type Call = { name: string; arguments: Record<string, unknown> };
type Script = { generate?: Record<string, unknown>; status?: Record<string, unknown>[]; failStatus?: boolean };

let fake: FakeHttpMcp | undefined;
afterEach(async () => {
  configureHiggsfield(null);
  await fake?.close();
  fake = undefined;
});

const structured = (value: Record<string, unknown>) => ({ structuredContent: value });

async function setup(script: Script, files: Record<string, Response | (() => Response)> = { [FILE]: () => new Response(PNG) }) {
  const statuses = [...(script.status ?? [])];
  fake = await startFakeHttpMcp({
    tools: TOOLS,
    callResult: (params) => {
      const call = params as Call;
      if (call.name === "generate_image") return structured(script.generate ?? { results: [{ id: "job-1", status: "queued" }] });
      return structured(statuses.shift() ?? { generation: { status: "queued" } });
    },
    callError: (params) => ((params as Call).name === "job_status" && script.failStatus ? { code: -32000, message: "down" } : undefined),
  });
  const sleeps: number[] = [];
  const downloads: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const served = files[url];
    if (served) {
      downloads.push(url);
      return typeof served === "function" ? served() : served;
    }
    return fetch(input, init);
  }) as typeof fetch;
  configureHiggsfield({
    ready: () => true,
    spec: async () => ({ type: "http", url: fake!.url, headers: {} }),
    fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  const calls = () => fake!.calls as Call[];
  return { sleeps, downloads, calls, generated: () => calls().filter((call) => call.name === "generate_image") };
}

const done = (url: string = FILE) => ({ generation: { status: "completed", results: { rawUrl: url } } });
const request = { model: "nano_banana_pro", prompt: "owl", aspect: "16:9" as const };

describe("generateHiggsfieldImage", () => {
  it("asks for one image on credits only, then downloads the finished file", async () => {
    const run = await setup({ generate: { results: [{ id: "job-1", status: "completed", results: { rawUrl: FILE } }] } });
    const image = await generateHiggsfieldImage(request);
    expect(image.mime).toBe("image/png");
    expect(image.bytes.equals(PNG)).toBe(true);
    expect(run.generated()).toHaveLength(1);
    expect(run.generated()[0]!.arguments).toEqual({
      params: { model: "nano_banana_pro", prompt: "owl", count: 1, use_unlim: false, aspect_ratio: "16:9" },
    });
  });

  it("polls job_status, waits Higgsfield's poll_after_seconds kept between 1 and 15 s, and never sends generate again", async () => {
    const run = await setup({ status: [
      { generation: { status: "in_progress" }, poll_after_seconds: 0.2 },
      { generation: { status: "queued" }, poll_after_seconds: 99 },
      { generation: { status: "queued" } },
      done(),
    ] });
    await generateHiggsfieldImage(request);
    expect(run.sleeps).toEqual([1000, 15000, 3000]);
    expect(run.generated()).toHaveLength(1);
    expect(run.calls().filter((call) => call.name === "job_status")[0]!.arguments).toEqual({ jobId: "job-1", sync: true });
  });

  it.each([["failed", 502, false], ["canceled", 502, false], ["nsfw", 422, false], ["ip_detected", 422, false]])("ends a %s job with status %i and no fallback", async (status, code, never) => {
    await setup({ status: [{ generation: { status, error: "no go" } }] });
    await expect(generateHiggsfieldImage(request)).rejects.toMatchObject({ status: code, neverStarted: never });
  });

  it("stops after three failed polls without sending generate again", async () => {
    const run = await setup({ failStatus: true });
    await expect(generateHiggsfieldImage(request)).rejects.toBeInstanceOf(HiggsfieldError);
    expect(run.generated()).toHaveLength(1);
    expect(run.calls().filter((call) => call.name === "job_status")).toHaveLength(3);
  });

  it.each([
    [{ error: "Payment required", monetization_intent: "topup" }, 402],
    [{ error: "Not enough credits" }, 402],
    [{ error: "Blocked", monetization_intent: "upgrade" }, 403],
    [{ upgrade_url: "https://higgsfield.ai/pricing" }, 403],
    [{ recovery_tool: "show_plans_and_credits" }, 403],
  ])("refuses %j as a failure that never started, so a backup can run", async (answer, code) => {
    await setup({ generate: answer });
    await expect(generateHiggsfieldImage(request)).rejects.toMatchObject({ status: code, neverStarted: true });
  });

  it("refuses the question about unlimited generations instead of answering it", async () => {
    await setup({ generate: { unlim_choice: { ask: true } } });
    await expect(generateHiggsfieldImage(request)).rejects.toBeInstanceOf(HiggsfieldError);
  });

  it("quotes Higgsfield's reason on one line, capped, with no address in it", async () => {
    await setup({ generate: { error: `bad\nhttps://higgsfield.ai/secret?token=abc ${"x".repeat(500)}` } });
    const error = await generateHiggsfieldImage(request).then(() => new Error("it did not fail"), (cause: Error) => cause);
    expect(error.message).toContain("[link]");
    expect(error.message).not.toContain("token=abc");
    expect(error.message).not.toContain("\n");
    expect(error.message.length).toBeLessThan(400);
  });

  it("refuses a file on any other host", async () => {
    const run = await setup({ status: [done("https://evil.example/x.png")] });
    await expect(generateHiggsfieldImage(request)).rejects.toThrow("finished without an image");
    expect(run.downloads).toEqual([]);
  });

  it("refuses a redirect off Higgsfield's hosts", async () => {
    await setup({ generate: { results: [{ id: "j", status: "completed", results: { rawUrl: FILE } }] } }, {
      [FILE]: () => new Response(null, { status: 302, headers: { location: "https://evil.example/y.png" } }),
    });
    await expect(generateHiggsfieldImage(request)).rejects.toThrow("unexpected address");
  });

  it("follows a redirect that stays on Higgsfield's hosts", async () => {
    await setup({ generate: { results: [{ id: "j", status: "completed", results: { rawUrl: FILE } }] } }, {
      [FILE]: () => new Response(null, { status: 302, headers: { location: "https://d8j0ntlcm91z4.cloudfront.net/2.png" } }),
      "https://d8j0ntlcm91z4.cloudfront.net/2.png": () => new Response(PNG),
    });
    expect((await generateHiggsfieldImage(request)).bytes.equals(PNG)).toBe(true);
  });

  it("refuses a file that is not an image", async () => {
    await setup({ generate: { results: [{ id: "j", status: "completed", results: { rawUrl: FILE } }] } }, { [FILE]: () => new Response("<html></html>") });
    await expect(generateHiggsfieldImage(request)).rejects.toThrow("not a supported image");
  });

  it("stops a file over the size limit", async () => {
    await setup({ generate: { results: [{ id: "j", status: "completed", results: { rawUrl: FILE } }] } }, {
      [FILE]: () => new Response(PNG, { headers: { "content-length": String(11 * 1024 * 1024) } }),
    });
    await expect(generateHiggsfieldImage(request)).rejects.toThrow("larger than the limit");
  });

  it("is cancelled by the caller", async () => {
    await setup({});
    const controller = new AbortController();
    controller.abort();
    await expect(generateHiggsfieldImage(request, { signal: controller.signal })).rejects.toMatchObject({ status: 409 });
  });

  it("says to sign in again when there is no sign-in, as a failure that never started", async () => {
    configureHiggsfield({ ready: () => true, spec: async () => null });
    await expect(generateHiggsfieldImage(request)).rejects.toMatchObject({ status: 401, neverStarted: true });
  });

  it("says to connect Higgsfield when nothing is configured", async () => {
    await expect(generateHiggsfieldImage(request)).rejects.toMatchObject({ status: 409, neverStarted: true });
    expect(higgsfieldReady()).toBe(false);
  });
});

describe("the image provider", () => {
  const cfg = { imageGen: { key: "openai-secret", primary: { provider: "higgsfield" as const }, fallback: { provider: "openai" as const } } };

  it("counts a Higgsfield slot as set up only while Higgsfield is connected", async () => {
    const slot = { provider: "higgsfield" as const, model: "nano_banana_pro" };
    expect(imageSlotConfigured(cfg, slot)).toBe(false);
    await setup({});
    expect(imageSlotConfigured(cfg, slot)).toBe(true);
  });

  it("makes the image through Higgsfield", async () => {
    await setup({ generate: { results: [{ id: "j", status: "completed", results: { rawUrl: FILE } }] } });
    const image = await generateImage(cfg, { prompt: "owl", aspect: "9:16" });
    expect(image).toMatchObject({ provider: "higgsfield", model: "nano_banana_pro", usedFallback: false });
  });

  it("falls back to the backup when Higgsfield is out of credits", async () => {
    await setup({ generate: { error: "Payment required", monetization_intent: "topup" } });
    const backup = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] })));
    const image = await generateImage(cfg, { prompt: "owl" }, { fetchImpl: backup });
    expect(image).toMatchObject({ provider: "openai", usedFallback: true });
    expect(image.baseError).toContain("out of credits");
  });

  it("does not fall back after a job that ran and failed", async () => {
    await setup({ status: [{ generation: { status: "failed", error: "model error" } }] });
    const backup = vi.fn();
    await expect(generateImage(cfg, { prompt: "owl" }, { fetchImpl: backup as unknown as typeof fetch })).rejects.toThrow("model error");
    expect(backup).not.toHaveBeenCalled();
  });

  it("refuses edits and GIFs without calling Higgsfield", async () => {
    const run = await setup({});
    const only = { imageGen: { primary: { provider: "higgsfield" as const } } };
    const edit = { image: { bytes: PNG, mime: "image/png" } };
    await expect(generateImage(only, { prompt: "x", edit })).rejects.toMatchObject({ status: 409 });
    await expect(generateImage(only, { prompt: "x", gif: {} })).rejects.toMatchObject({ status: 409 });
    expect(run.calls()).toHaveLength(0);
  });
});

describe("the Higgsfield connection", () => {
  const row = (url: string, extra: Record<string, unknown> = {}) => ({ type: "http", url, headers: {}, enabled: true, ...extra });
  const oauth = (state: "signed-in" | "needs-sign-in" = "signed-in") => ({
    authState: () => state,
    accessToken: async () => "token-1",
    tokenRefused: async () => "refreshed" as const,
  }) as never;

  it("is the enabled row at Higgsfield's exact address, signed in", () => {
    expect(createHiggsfieldBackend({ servers: () => ({ higgsfield: row("https://mcp.higgsfield.ai/mcp") }), oauth: oauth() }).ready()).toBe(true);
    expect(createHiggsfieldBackend({ servers: () => ({ other: row("https://mcp.higgsfield.ai/mcp/") }), oauth: oauth() }).ready()).toBe(true);
  });

  it.each([
    ["a look-alike host", row("https://mcp.higgsfield.ai.evil.test/mcp")],
    ["plain http", row("http://mcp.higgsfield.ai/mcp")],
    ["another path", row("https://mcp.higgsfield.ai/other")],
    ["a query", row("https://mcp.higgsfield.ai/mcp?key=1")],
    ["a user in the address", row("https://key@mcp.higgsfield.ai/mcp")],
    ["a disabled row", row("https://mcp.higgsfield.ai/mcp", { enabled: false })],
    ["the older SSE transport", row("https://mcp.higgsfield.ai/mcp", { type: "sse" })],
  ])("is not %s", (_name, server) => {
    expect(createHiggsfieldBackend({ servers: () => ({ higgsfield: server }), oauth: oauth() }).ready()).toBe(false);
  });

  it("is not ready while the sign-in is pending, and without any rows", () => {
    expect(createHiggsfieldBackend({ servers: () => ({ higgsfield: row("https://mcp.higgsfield.ai/mcp") }), oauth: oauth("needs-sign-in") }).ready()).toBe(false);
    expect(createHiggsfieldBackend({ servers: () => undefined, oauth: oauth() }).ready()).toBe(false);
  });

  it("sends the sign-in token as the bearer and no other Authorization header", async () => {
    const backend = createHiggsfieldBackend({
      servers: () => ({ higgsfield: row("https://mcp.higgsfield.ai/mcp", { headers: { authorization: "Bearer stale", "x-other": "1" } }) }),
      oauth: oauth(),
    });
    const spec = await backend.spec();
    expect(spec?.headers).toEqual({ "x-other": "1", Authorization: "Bearer token-1" });
  });
});
