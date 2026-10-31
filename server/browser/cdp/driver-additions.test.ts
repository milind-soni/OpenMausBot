import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTH_WAIT_MS, AuthChallenges } from "./auth.ts";
import { CdpConnection, type CdpSession, type Params } from "./connection.ts";
import { DriverError, isUnanswered } from "./errors.ts";
import { FileChoosers } from "./files.ts";
import { FrameTree } from "./frames.ts";
import { methodRefusal } from "./policy.ts";
import type { CdpTransport } from "./transport.ts";
import { Lifecycle } from "./wait.ts";

/** A session whose events the test raises and whose commands it records. */
function eventSession() {
  const sent: Array<{ method: string; params: Params }> = [];
  const listeners = new Map<string, Set<(params: Params) => void>>();
  const session = {
    id: "page",
    send: async (method: string, params: Params = {}) => { sent.push({ method, params }); return {}; },
    on: (method: string, listener: (params: Params) => void) => {
      const set = listeners.get(method) ?? new Set();
      listeners.set(method, set);
      set.add(listener);
      return () => set.delete(listener);
    },
    onDetach: (listener: () => void) => { detachListeners.add(listener); return () => detachListeners.delete(listener); },
  } as unknown as CdpSession;
  const detachListeners = new Set<() => void>();
  const emit = (method: string, params: Params) => { for (const listener of listeners.get(method) ?? []) listener(params); };
  const detach = () => { for (const listener of detachListeners) listener(); };
  return { session, sent, emit, detach };
}

afterEach(() => { vi.useRealTimers(); });

describe("HTTP authentication challenges", () => {
  it("lets every paused document request go on at once, unchanged", () => {
    const { session, sent, emit } = eventSession();
    new AuthChallenges().watch(session);
    emit("Fetch.requestPaused", { requestId: "r1", request: { url: "https://example.com/" } });
    expect(sent).toEqual([{ method: "Fetch.continueRequest", params: { requestId: "r1" } }]);
  });

  it("holds a site's challenge for an answer, then answers it once with the credentials", async () => {
    const { session, sent, emit } = eventSession();
    const auth = new AuthChallenges();
    auth.watch(session);
    const seen: unknown[] = [];
    auth.onChange((challenge) => seen.push(challenge?.realm ?? null));
    emit("Fetch.authRequired", { requestId: "a1", authChallenge: { source: "Server", origin: "https://intranet.example", scheme: "Basic", realm: "Staff" } });
    expect(auth.pending).toMatchObject({ id: "a1", origin: "https://intranet.example", realm: "Staff", scheme: "basic" });
    await auth.answer({ username: "ada", password: "pw" });
    expect(sent).toContainEqual({ method: "Fetch.continueWithAuth", params: { requestId: "a1", authChallengeResponse: { response: "ProvideCredentials", username: "ada", password: "pw" } } });
    expect(auth.pending).toBeNull();
    expect(seen).toEqual(["Staff", null]);
    await expect(auth.answer(null)).rejects.toThrow(/No sign-in prompt/);
  });

  it("cancels a challenge at once when nobody could answer it", () => {
    const { session, sent, emit } = eventSession();
    const auth = new AuthChallenges();
    auth.answerable = () => false;
    auth.watch(session);
    emit("Fetch.authRequired", { requestId: "u1", authChallenge: { source: "Server", origin: "https://intranet.example", scheme: "basic", realm: "Staff" } });
    expect(auth.pending).toBeNull();
    expect(sent.at(-1)).toEqual({ method: "Fetch.continueWithAuth", params: { requestId: "u1", authChallengeResponse: { response: "CancelAuth" } } });
  });

  it("never answers a proxy's challenge, and cancels one nobody answers", async () => {
    vi.useFakeTimers();
    const { session, sent, emit } = eventSession();
    const auth = new AuthChallenges();
    auth.watch(session);
    emit("Fetch.authRequired", { requestId: "p1", authChallenge: { source: "Proxy", origin: "socks5://127.0.0.1:1", scheme: "basic", realm: "" } });
    expect(auth.pending).toBeNull();
    expect(sent.at(-1)).toEqual({ method: "Fetch.continueWithAuth", params: { requestId: "p1", authChallengeResponse: { response: "CancelAuth" } } });
    emit("Fetch.authRequired", { requestId: "s1", authChallenge: { source: "Server", origin: "https://a.example", scheme: "digest", realm: "x" } });
    await vi.advanceTimersByTimeAsync(AUTH_WAIT_MS);
    expect(auth.pending).toBeNull();
    expect(sent.at(-1)).toEqual({ method: "Fetch.continueWithAuth", params: { requestId: "s1", authChallengeResponse: { response: "CancelAuth" } } });
  });
});

describe("file picker delivery", () => {
  it("refuses files when access is revoked while waiting for the picker", async () => {
    const { session, sent, emit } = eventSession();
    const pickers = new FileChoosers();
    pickers.watch(session);
    let current = true;
    const answering = pickers.answer([], { isCurrent: () => current });
    current = false;
    emit("Page.fileChooserOpened", { frameId: "main", backendNodeId: 1, mode: "selectMultiple" });
    expect.soft(await answering).toBe(false);
    expect(sent).toEqual([]);
    expect(pickers.open).not.toBeNull();
  });
});

describe("a tab whose session went away", () => {
  it("has no main frame left, rather than a stale one", () => {
    const { session, detach } = eventSession();
    const frames = new FrameTree(session, "main");
    expect(frames.main).toMatchObject({ id: "main", url: "about:blank" });
    detach();
    expect(frames.main).toBeUndefined();
  });
});

describe("a tab that already showed a document when it was set up", () => {
  it("takes its frames and its loaded document from Chrome's own frame tree", () => {
    const { session } = eventSession();
    const frames = new FrameTree(session, "main");
    frames.adopt({ frame: { id: "main", url: "https://example.com/restored", loaderId: "L1" }, childFrames: [{ frame: { id: "child", parentId: "main", url: "https://example.com/inner" } }] });
    expect(frames.main).toMatchObject({ url: "https://example.com/restored", loaderId: "L1" });
    expect(frames.get("child")).toMatchObject({ parentId: "main", url: "https://example.com/inner" });
    const lifecycle = new Lifecycle(session, "main");
    lifecycle.adopt("L1", true);
    expect(lifecycle.reached("load")).toBe(true);
    lifecycle.adopt("L2", false);
    expect(lifecycle.loaderId).toBe("L1");
  });
});

describe("a command Chrome never answers", () => {
  it("is told apart from a page that is merely slow", async () => {
    const transport: CdpTransport = { send: () => {}, onMessage: () => {}, onClose: () => {}, close: () => {} };
    const connection = new CdpConnection(transport, { defaultTimeoutMs: 10 });
    const unanswered = await connection.root.send("Browser.getVersion").catch((error: unknown) => error);
    expect(isUnanswered(unanswered)).toBe(true);
    expect(isUnanswered(new DriverError("timeout", "The page did not reach load within 15000 ms; it may still be loading."))).toBe(false);
    const event = await connection.root.waitFor("Target.targetCreated", { timeoutMs: 10 }).catch((error: unknown) => error);
    expect(isUnanswered(event)).toBe(false);
  });
});

describe("the method guard", () => {
  it("lets a page's viewport be emulated for a size no window can have, and HTTP authentication be handled", () => {
    expect(methodRefusal("page", "Emulation.setDeviceMetricsOverride", {})).toBeNull();
    expect(methodRefusal("page", "Emulation.clearDeviceMetricsOverride", {})).toBeNull();
    expect(methodRefusal("page", "Fetch.enable", {})).toBeNull();
    expect(methodRefusal("worker", "Emulation.setDeviceMetricsOverride", {})).toMatch(/allowlist/);
  });
});
