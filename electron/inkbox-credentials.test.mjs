import { describe, expect, it } from "vitest";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { createInkboxCredentialBridge } from "./inkbox-credentials.mjs";

const document = { version: 1, apiKey: "fixture-runtime-secret", signingSecret: "fixture-signing-secret" };
const request = (requestId, operation, value) => ({
  type: "openmausbot:inkbox-secret:request", requestId, operation,
  ...(operation === "write" ? { value } : {}),
});

function fixture(overrides = {}) {
  let persisted = { unrelated: "keep-me" };
  const credentials = createSecureCredentialState(persisted, async next => { persisted = next; });
  const replies = [];
  const proc = { postMessage: message => replies.push(message) };
  const bridge = createInkboxCredentialBridge({
    workspacePath: "/isolated/workspace-a", credentials,
    isAvailable: async () => true, isCurrent: candidate => candidate === proc, ...overrides,
  });
  const send = async message => {
    expect(bridge.receive(proc, message)).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    return replies.at(-1);
  };
  return { bridge, proc, replies, send, credentials, persisted: () => persisted };
}

describe("private Inkbox desktop credentials", () => {
  it("round-trips and erases one workspace without replacing other credentials", async () => {
    const f = fixture();
    expect(await f.send(request("empty", "read"))).toMatchObject({ ok: true, value: null });
    expect(await f.send(request("write", "write", document))).toMatchObject({ ok: true });
    expect(await f.send(request("read", "read"))).toMatchObject({ ok: true, value: document });
    expect(f.persisted().unrelated).toBe("keep-me");
    expect(await f.send(request("erase", "write", null))).toMatchObject({ ok: true });
    expect(await f.send(request("after-erase", "read"))).toMatchObject({ ok: true, value: null });
    expect(f.persisted()).toEqual({ unrelated: "keep-me" });
  });

  it("isolates workspace directories while normalizing equivalent paths", async () => {
    const f = fixture();
    await f.send(request("write", "write", document));
    const replies = [];
    const proc = { postMessage: message => replies.push(message) };
    for (const [workspacePath, expected] of [["/isolated/workspace-b", null], ["/isolated/./workspace-a", document]]) {
      const bridge = createInkboxCredentialBridge({ workspacePath, credentials: f.credentials, isAvailable: async () => true, isCurrent: p => p === proc });
      bridge.receive(proc, request(workspacePath.endsWith("b") ? "b" : "a", "read"));
      await new Promise(resolve => setImmediate(resolve));
      expect(replies.at(-1)).toMatchObject({ ok: true, value: expected });
    }
  });

  it("preserves concurrent credential edits using the shared serialized state", async () => {
    const f = fixture();
    f.bridge.receive(f.proc, request("inkbox", "write", document));
    await f.credentials.update(current => ({ ...current, providerKey: "another-secret" }));
    await new Promise(resolve => setImmediate(resolve));
    expect(await f.send(request("read", "read"))).toMatchObject({ value: document });
    expect(f.persisted()).toMatchObject({ unrelated: "keep-me", providerKey: "another-secret" });
  });

  it("fails closed for unavailable encryption and never exposes provider error text", async () => {
    for (const isAvailable of [async () => false, async () => { throw new Error(document.apiKey); }]) {
      const f = fixture({ isAvailable });
      for (const operation of ["read", "write"]) {
        const reply = await f.send(request(operation, operation, document));
        expect(reply.ok).toBe(false);
        expect(JSON.stringify(reply)).not.toContain(document.apiKey);
      }
      expect(f.persisted()).toEqual({ unrelated: "keep-me" });
    }
  });

  it("redacts read and write failures and leaves committed secrets untouched", async () => {
    const credentials = createSecureCredentialState({ unrelated: "keep-me" }, async () => { throw new Error(document.apiKey); });
    const f = fixture({ credentials });
    expect(await f.send(request("write", "write", document))).toMatchObject({ ok: false });
    expect(credentials.read()).toEqual({ unrelated: "keep-me" });
    expect(JSON.stringify(f.replies)).not.toContain(document.apiKey);
    const broken = fixture({ credentials: { read() { throw new Error(document.apiKey); } } });
    expect(await broken.send(request("read", "read"))).toMatchObject({ ok: false });
    expect(JSON.stringify(broken.replies)).not.toContain(document.apiKey);
  });

  it("cannot replace a credential file that failed to decrypt on this launch", async () => {
    const persisted = { unrelated: "keep-me" };
    const credentials = createSecureCredentialState({}, async next => Object.assign(persisted, next), { writable: false });
    const f = fixture({ credentials });
    expect(await f.send(request("save", "write", document))).toMatchObject({ ok: false });
    expect(persisted).toEqual({ unrelated: "keep-me" });
  });

  it("rejects non-JSON, prototype-bearing, oversized and wrong-version documents without changing the store", async () => {
    const cyclic = { version: 1 }; cyclic.self = cyclic;
    const bad = [[], { version: 2 }, new Date(), { version: 1, secret: "x".repeat(65_536) },
      JSON.parse('{"version":1,"nested":{"__proto__":{"polluted":true}}}'),
      { version: 1, nested: new Map() }, { version: 1, n: NaN }, { version: 1, unset: undefined }, cyclic];
    const f = fixture();
    for (const [i, value] of bad.entries()) {
      expect(f.bridge.receive(f.proc, request(`bad-${i}`, "write", value))).toBe(false);
    }
    expect(f.persisted()).toEqual({ unrelated: "keep-me" });
    expect(f.replies).toEqual([]);
  });

  it("ignores malformed requests and messages from a process it no longer owns", () => {
    const f = fixture();
    for (const message of [null, {}, { ...request("x", "read"), operation: "delete" },
      { ...request("x", "read"), value: document }, request("!bad", "read"), request("x".repeat(129), "read"),
      { ...request("x", "read"), renderer: true }]) {
      expect(f.bridge.receive(f.proc, message)).toBe(false);
    }
    expect(f.bridge.receive({ postMessage() { throw new Error("foreign"); } }, request("foreign", "write", document))).toBe(false);
    expect(f.replies).toEqual([]);
  });

  it("does not commit an in-flight request after ownership changes", async () => {
    let owned = true;
    let allow;
    const f = fixture({ isAvailable: () => new Promise(resolve => { allow = resolve; }), isCurrent: () => owned });
    f.bridge.receive(f.proc, request("old", "write", document));
    owned = false;
    allow(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.persisted()).toEqual({ unrelated: "keep-me" });
    expect(f.replies).toEqual([]);
  });

  it("does not replay duplicate request IDs or send completion to a replacement process", async () => {
    const f = fixture();
    await f.send(request("once", "write", document));
    expect(f.bridge.receive(f.proc, request("once", "write", null))).toBe(false);
    expect(await f.send(request("read", "read"))).toMatchObject({ value: document });
  });

  it("does not return secrets to a child replaced while secure storage was opening", async () => {
    const f = fixture();
    await f.send(request("write", "write", document));
    let allow;
    let owned = true;
    const replies = [];
    const proc = { postMessage: message => replies.push(message) };
    const bridge = createInkboxCredentialBridge({ workspacePath: "/isolated/workspace-a", credentials: f.credentials,
      isAvailable: () => new Promise(resolve => { allow = resolve; }), isCurrent: candidate => candidate === proc && owned });
    bridge.receive(proc, request("read-old", "read"));
    owned = false;
    allow(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(replies).toEqual([]);
  });

  it("rechecks ownership inside the credential queue before committing", async () => {
    let finishOtherSave;
    let persisted = { unrelated: "keep-me" };
    const credentials = createSecureCredentialState(persisted, async next => { persisted = next; });
    const otherSave = credentials.update(async current => {
      await new Promise(resolve => { finishOtherSave = resolve; });
      return { ...current, otherProvider: "new-key" };
    });
    let owned = true;
    const f = fixture({ credentials, isCurrent: () => owned });
    f.bridge.receive(f.proc, request("queued", "write", document));
    await new Promise(resolve => setImmediate(resolve));
    owned = false;
    finishOtherSave();
    await otherSave;
    await new Promise(resolve => setImmediate(resolve));
    expect(persisted).toEqual({ unrelated: "keep-me", otherProvider: "new-key" });
    expect(f.replies).toEqual([]);
  });
});
