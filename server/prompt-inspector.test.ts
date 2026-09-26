import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configurePromptInspector, diagnosticHeaders, forgetPromptCaptures, inspectProvider, PromptInspector, promptUsage } from "./prompt-inspector.ts";
import { OpenAICompatDriver } from "./drivers/openai-compat.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import type { RuntimeEvent } from "./contracts.ts";
const dirs: string[] = [];
const stores: PromptInspector[] = [];
const createStore = (dir: string) => { const store = new PromptInspector(dir); stores.push(store); return store; };
const configureStore = (dir: string) => { const store = configurePromptInspector(dir); if (!store) throw new Error("fixture inspector unavailable"); stores.push(store); return store; };
const directory = () => { const path = mkdtempSync(join(tmpdir(), "omb-prompt-inspector-")); dirs.push(path); return path; };
afterEach(async () => { for (const store of stores.splice(0)) await store.flush(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const meta = { threadId: "thread", botId: "bot", provider: "fixture" };
describe("provider prompt captures", () => {
  it("keeps unknown caching unknown and records known zero accurately", () => {
    expect(promptUsage({ input: 100, output: 2 })).toEqual({ input: 100, cached: null, uncached: null, output: 2 });
    expect(promptUsage({ prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } })).toEqual({ input: 100, cached: 0, uncached: 100, output: 2 });
    expect(promptUsage({ input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 80 } })?.uncached).toBe(20);
  });
  it("redacts credentials before writing and never retains unrecognized response headers", async () => {
    const dir = directory(), store = createStore(dir);
    store.capture(meta, "agent-input", { integrations: { env: { API_KEY: "fixture-secret", PASSWORD: "private-password" } }, text: "Hello" }).finish("completed");
    await store.flush();
    const raw = readFileSync(join(dir, "thread.json"), "utf8");
    expect(raw).not.toContain("fixture-secret"); expect(raw).not.toContain("private-password"); expect(raw).toContain("Hello");
    expect(diagnosticHeaders(new Headers({ "set-cookie": "private", "x-unexpected": "private", "x-request-id": "req-7", "x-cache": "HIT" }))).toEqual({ "x-request-id": "req-7", "x-cache": "HIT" });
  });
  it("bounds retention and bodies without altering the observed input", () => {
    const store = createStore(directory()), body = { text: "x".repeat(4 * 1024 * 1024) };
    store.capture(meta, "agent-input", body).finish("completed");
    expect(store.read("thread")[0]).toMatchObject({ body: null, omitted: true }); expect(body.text.length).toBe(4 * 1024 * 1024);
    for (let n = 0; n < 9; n++) store.capture(meta, "agent-input", { text: String(n) }).finish("completed");
    expect(store.read("thread")).toHaveLength(6);
  });
  it("does not revive deleted captures and removes cross-thread copies", () => {
    const store = createStore(directory());
    const pending = store.capture(meta, "agent-input", { text: "a" });
    store.capture({ ...meta, threadId: "other" }, "agent-input", { source: "thread" });
    store.forget("thread"); pending.finish("completed");
    expect(store.read("thread")).toEqual([]); expect(store.read("other")).toEqual([]);
    expect(() => store.capture({ ...meta, epoch: 0 }, "api-request", {})).toThrow("invalidated");
  });
  it("marks interrupted requests after a restart and rejects traversal", async () => {
    const dir = directory(), store = createStore(dir); store.capture(meta, "agent-input", {});
    expect(store.read("thread")[0].status).toBe("sending"); await store.flush(); expect(createStore(dir).read("thread")[0].status).toBe("interrupted");
    expect(() => store.capture({ ...meta, threadId: "../outside" }, "agent-input", {})).toThrow("Invalid thread");
  });
  it("captures real HTTP request bodies, separates call usage from turn totals, and keeps auth off disk", async () => {
    const requests: unknown[] = [], store = configureStore(directory());
    const server = createServer(async (req, res) => {
      if (req.url?.endsWith("/models")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fixture" }] })); return; }
      let body = ""; for await (const chunk of req) body += String(chunk); requests.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "loopback-123", "set-cookie": "never-save-this" });
      res.end('data: {"choices":[{"index":0,"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":80}}}\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const instance = inspectProvider(await OpenAICompatDriver.create({ instanceId: "fixture", displayName: "Fixture", enabled: true,
      config: OpenAICompatDriver.decodeConfig({ url: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "FIXTURE_API_KEY", model: "fixture" }), environment: { FIXTURE_API_KEY: "fixture-secret" } }));
    const events: RuntimeEvent[] = []; instance.adapter.onEvent(event => events.push(event));
    try {
      const turn = { threadId: "thread", botId: "bot", text: "Hello", system: "Be concise" };
      await instance.adapter.sendTurn(turn);
      await expect.poll(() => events.some(event => event.type === "turn.completed"), { timeout: 5000 }).toBe(true);
      const records = store.read("thread"), api = records.find(record => record.kind === "api-request")!;
      expect(api.body).toEqual(requests[0]); expect(api.usage).toEqual({ input: 100, cached: 80, uncached: 20, output: 3 });
      expect(api.responseHeaders).toEqual({ "x-request-id": "loopback-123" }); expect(api.status).toBe("completed");
      expect(records.find(record => record.kind === "agent-input")).toMatchObject({ status: "completed", body: turn });
      expect(JSON.stringify(records)).not.toContain("fixture-secret"); expect(JSON.stringify(records)).not.toContain("never-save-this");
    } finally { await instance.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});


it("isolates concurrent turns, ignores stale events, and never labels running thread totals as turn usage", async () => {
  const store = configureStore(directory()), fake = makeFakeDriver({ kind: "acp-fixture" });
  const instance = await fake.driver.create({ instanceId: "fixture", displayName: undefined, enabled: true, environment: {}, config: {} });
  let sequence = 0;
  instance.adapter.sendTurn = async () => ({ turnId: `turn-${++sequence}` });
  const wrapped = inspectProvider(instance), emit = fake.created.get("fixture")!.emit;
  const event = (threadId: string, turnId: string, fields: Partial<RuntimeEvent>) => emit({ eventId: String(++sequence), createdAt: new Date().toISOString(), provider: "acp-fixture", threadId, turnId, ...fields } as RuntimeEvent);
  try {
    const a = await wrapped.adapter.sendTurn({ threadId: "a", text: "First" });
    const b = await wrapped.adapter.sendTurn({ threadId: "b", text: "Second" });
    event("a", "stale-turn", { type: "turn.completed", ok: true, usage: { input: 999, output: 999 } });
    event("a", a.turnId, { type: "thread.token-usage.updated", input: 999, output: 999 });
    expect(store.read("a")[0]).toMatchObject({ status: "sending" }); expect(store.read("a")[0].usage).toBeUndefined();
    event("b", b.turnId, { type: "turn.completed", ok: true, usage: { input: 40, output: 4, cachedInput: 30 } });
    event("a", a.turnId, { type: "turn.completed", ok: true, usage: { input: 50, output: 5, cachedInput: 0 } });
    expect(store.read("a")[0].usage).toEqual({ input: 50, output: 5, cached: 0, uncached: 50 });
    expect(store.read("b")[0].usage).toEqual({ input: 40, output: 4, cached: 30, uncached: 10 });
    await wrapped.adapter.sendTurn({ threadId: "a", text: "Next" });
    expect(store.read("a")).toHaveLength(2);
  } finally { await wrapped.dispose(); }
  expect(store.read("a")[0].status).toBe("interrupted");
});

it("preserves provider failures and operates when capture storage cannot be written", async () => {
  const dir = directory(), store = configureStore(dir), fake = makeFakeDriver();
  const instance = await fake.driver.create({ instanceId: "fixture", displayName: undefined, enabled: true, environment: {}, config: {} });
  instance.adapter.sendTurn = async () => { throw new Error("fixture failure"); };
  inspectProvider(instance);
  try {
    await expect(instance.adapter.sendTurn({ threadId: "a", text: "First" })).rejects.toThrow("fixture failure");
    expect(store.read("a")[0]).toMatchObject({ status: "failed", error: "fixture failure" });
    rmSync(dir, { recursive: true });
    await expect(instance.adapter.sendTurn({ threadId: "a", text: "Second" })).rejects.toThrow("fixture failure");
  } finally { await instance.dispose(); }
});

it("coalesces metadata patches into a finished asynchronous write and restores it", async () => {
  const dir = directory(), store = createStore(dir);
  const turn = store.capture(meta, "api-request", { text: "x".repeat(1024 * 1024) });
  for (let n = 0; n < 100; n++) turn.patch({ httpStatus: 200, durationMs: n });
  expect(existsSync(join(dir, "thread.json"))).toBe(false);
  turn.finish("completed");
  expect(existsSync(join(dir, "thread.json"))).toBe(false);
  await store.flush();
  expect(createStore(dir).read("thread")[0]).toMatchObject({ status: "completed", httpStatus: 200 });
});

it("journals deletion before an in-flight write can recreate a capture", async () => {
  const dir = directory(), store = createStore(dir);
  const turn = store.capture(meta, "agent-input", { text: "private record" });
  turn.finish("completed");
  // Let the queued writer enter asynchronous I/O before deleting.
  await Promise.resolve();
  store.forget("thread");
  expect(store.read("thread")).toEqual([]);
  await store.flush();
  expect(existsSync(join(dir, "thread.json"))).toBe(false);
  expect(existsSync(join(dir, "thread.json.tmp"))).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, ".pending-deletions.json"), "utf8"))).toEqual([]);
});

it("reports unlink failure, hides pending captures and retries a durable deletion after restart", async () => {
  const dir = directory(), store = createStore(dir);
  store.capture(meta, "agent-input", { text: "private record" }).finish("completed");
  await store.flush();
  mkdirSync(join(dir, "thread.json.tmp")); // Real unlink failure on all platforms.
  expect(() => store.forget("thread")).toThrow();
  expect(store.read("thread")).toEqual([]);
  expect(JSON.parse(readFileSync(join(dir, ".pending-deletions.json"), "utf8"))).toEqual(["thread"]);
  rmdirSync(join(dir, "thread.json.tmp"));
  const restarted = createStore(dir);
  expect(restarted.read("thread")).toEqual([]);
  expect(JSON.parse(readFileSync(join(dir, ".pending-deletions.json"), "utf8"))).toEqual([]);
});


it("scans uncached captures without parsing them or retaining unrelated files", () => {
  const dir = directory(), store = createStore(dir);
  writeFileSync(join(dir, "thread.json"), "invalid target JSON");
  writeFileSync(join(dir, "referencing.json"), '{"incomplete": "thread"');
  writeFileSync(join(dir, "unrelated.json"), "unrelated invalid JSON");
  for (let n = 0; n < 12; n++) writeFileSync(join(dir, `other-${n}.json`), "[]");
  const read = vi.spyOn(store, "read");
  store.forget("thread");
  expect(read).not.toHaveBeenCalled();
  expect(existsSync(join(dir, "thread.json"))).toBe(false);
  expect(existsSync(join(dir, "referencing.json"))).toBe(false);
  expect(readFileSync(join(dir, "unrelated.json"), "utf8")).toBe("unrelated invalid JSON");
  // A fresh disk edit must be observed: cleanup did not cache the old rows.
  writeFileSync(join(dir, "other-0.json"), "invalid after cleanup");
  expect(() => store.read("other-0")).toThrow();
});

it("does not discard a malformed durable deletion journal", () => {
  const dir = directory();
  writeFileSync(join(dir, ".pending-deletions.json"), "{invalid");
  expect(configurePromptInspector(dir)).toBeNull();
  expect(() => forgetPromptCaptures("thread")).toThrow("cleanup is unavailable");
  expect(readFileSync(join(dir, ".pending-deletions.json"), "utf8")).toBe("{invalid");
});

it("does not let capture flush failure replace provider disposal", async () => {
  const store = configureStore(directory()), fake = makeFakeDriver();
  const instance = inspectProvider(await fake.driver.create({ instanceId: "fixture", displayName: undefined, enabled: true, environment: {}, config: {} }));
  vi.spyOn(store, "flush").mockRejectedValueOnce(new Error("capture disk failed"));
  await expect(instance.dispose()).resolves.toBeUndefined();
});
