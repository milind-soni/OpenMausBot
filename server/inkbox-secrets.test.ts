import { afterEach, describe, expect, it, vi } from "vitest";
import { createInkboxSecretStore } from "./inkbox-secrets.ts";
import { createInkboxCredentialBridge } from "../electron/inkbox-credentials.mjs";
import { createSecureCredentialState } from "../electron/secure-credential-state.mjs";

const document = { version: 1, apiKey: "fixture-secret" };
afterEach(() => vi.useRealTimers());

function portFixture() {
  let listener: (event: { data?: unknown }) => void = () => {};
  const messages: Record<string, unknown>[] = [];
  const port = {
    on(_name: "message", callback: typeof listener) { listener = callback; },
    postMessage(message: object) { messages.push(message as Record<string, unknown>); },
  };
  return { port, messages, reply: (data: unknown) => listener({ data }) };
}

describe("Inkbox utility secret store", () => {
  it("is unavailable without an Electron private parent and refuses reads and writes", async () => {
    const store = createInkboxSecretStore();
    expect(store.available).toBe(false);
    await expect(store.read()).rejects.toThrow(/storage/i);
    await expect(store.write(document)).rejects.toThrow(/storage/i);
    store.close();
  });

  it("round-trips secrets through the production bridge without losing other credentials", async () => {
    let listener: (event: { data?: unknown }) => void = () => {};
    const proc = { postMessage: (data: object) => listener({ data }) };
    let persisted = {};
    const credentials = createSecureCredentialState({ other: "existing" }, next => { persisted = next; });
    const bridge = createInkboxCredentialBridge({ workspacePath: "/fixture", credentials, isAvailable: async () => true, isCurrent: p => p === proc });
    const store = createInkboxSecretStore({ on: (_name, callback) => { listener = callback; }, postMessage: message => { bridge.receive(proc, message); } });
    expect(store.available).toBe(true);
    expect(await store.read()).toBeNull();
    await store.write(document);
    expect(await store.read()).toEqual(document);
    expect(persisted).toMatchObject({ other: "existing" });
    await store.write(null);
    expect(await store.read()).toBeNull();
    store.close();
  });

  it("correlates out-of-order responses and ignores unrelated or stale messages", async () => {
    const f = portFixture(); const store = createInkboxSecretStore(f.port);
    const a = store.read(); const b = store.read();
    const [first, second] = f.messages;
    f.reply({ type: "other", requestId: first.requestId, ok: true, value: null });
    f.reply({ type: "openmausbot:inkbox-secret:response", requestId: "stale", ok: true, value: null });
    f.reply({ type: "openmausbot:inkbox-secret:response", requestId: second.requestId, ok: true, value: document });
    expect(await b).toEqual(document);
    f.reply({ type: "openmausbot:inkbox-secret:response", requestId: first.requestId, ok: true, value: null });
    expect(await a).toBeNull(); store.close();
  });

  it("redacts parent errors, transport throws and malformed successful data", async () => {
    const f = portFixture(); const store = createInkboxSecretStore(f.port);
    const a = store.read();
    f.reply({ type: "openmausbot:inkbox-secret:response", requestId: f.messages[0].requestId, ok: false, error: document.apiKey });
    await expect(a).rejects.toThrow(/^Secure Inkbox storage is unavailable\.$/);
    const b = store.read();
    f.reply({ type: "openmausbot:inkbox-secret:response", requestId: f.messages[1].requestId, ok: true, value: { version: 2, apiKey: document.apiKey } });
    await expect(b).rejects.toThrow(/^Secure Inkbox storage is unavailable\.$/);
    const throwing = createInkboxSecretStore({ on() {}, postMessage() { throw new Error(document.apiKey); } });
    await expect(throwing.read()).rejects.toThrow(/^Secure Inkbox storage is unavailable\.$/);
    store.close(); throwing.close();
  });

  it("bounds requests when the parent stops answering, and rejects pending work on close", async () => {
    vi.useFakeTimers();
    const f = portFixture(); const store = createInkboxSecretStore(f.port);
    const first = expect(store.read()).rejects.toThrow(/storage/i);
    await vi.advanceTimersByTimeAsync(5_000); await first;
    const second = expect(store.read()).rejects.toThrow(/storage/i);
    store.close(); await second;
    await expect(store.read()).rejects.toThrow(/storage/i);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses invalid documents before sending them to the parent", async () => {
    const f = portFixture(); const store = createInkboxSecretStore(f.port);
    await expect(store.write({ version: 1, apiKey: "x".repeat(65_536) })).rejects.toThrow(/storage/i);
    await expect(store.write({ version: 1, nested: JSON.parse('{"constructor":"unsafe"}') })).rejects.toThrow(/storage/i);
    expect(f.messages).toEqual([]); store.close();
  });

  it("caps outstanding requests and frees capacity after completion", async () => {
    const f = portFixture(); const store = createInkboxSecretStore(f.port);
    const reads = Array.from({ length: 32 }, () => store.read().catch(error => error));
    await expect(store.read()).rejects.toThrow(/storage/i);
    expect(f.messages).toHaveLength(32);
    f.reply({ type: "openmausbot:inkbox-secret:response", requestId: f.messages[0].requestId, ok: true, value: null });
    expect(await reads[0]).toBeNull();
    const next = store.read().catch(error => error);
    expect(f.messages).toHaveLength(33);
    store.close();
    await Promise.all([...reads, next]);
  });
});
