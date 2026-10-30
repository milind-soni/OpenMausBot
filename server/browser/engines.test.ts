import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserLive } from "../browser-live.ts";
import { attachesToChrome, type BrowserRuntime } from "../browser-runtime.ts";
import type { ListenerOwnership } from "./egress/ownership.ts";
import type { EgressHost } from "./egress/policy.ts";
import { REDDIT_REFUSAL } from "./egress/reddit.ts";
import { BrowserEgress, OwnListeners } from "./egress/registry.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ProcessRegistry } from "./chrome/processes.ts";
import { browserRoot } from "./chrome/profile.ts";
import { CHROME_ENGINE, ChromeEngine, chromeTarget, LiveRouter, profileKey, RuntimeRouter, type RuntimeRouterOptions } from "./engines.ts";

const AGENT_BROWSER = { command: "/opt/agent-browser", args: ["--session", "s"], env: { AGENT_BROWSER_SESSION: "s" } };
const CHROME = { command: CHROME_ENGINE, args: ["bot:a"], env: {} };

function engines(options: RuntimeRouterOptions = {}) {
  const old = {
    agentRpc: vi.fn(async (_session: string, _spec: unknown, _method: string, _params: unknown, beforeDispatch?: () => void) => { beforeDispatch?.(); return "agent-browser"; }),
    previewFrame: vi.fn(async (_session: string, capture: () => Promise<unknown>) => capture()),
    withSecretInput: vi.fn(async (_session: string, _spec: unknown, fn: () => Promise<unknown>) => fn()),
    heldBy: vi.fn(() => "person"),
    interrupted: vi.fn(() => false),
    interruptedCount: vi.fn(() => 1),
    closeIfIdle: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
    closeAll: vi.fn(async () => undefined),
  };
  const oldLive = { open: vi.fn(async () => undefined), action: vi.fn(async () => "agent-browser"), handBack: vi.fn(), closeForSession: vi.fn(), closeForOwner: vi.fn(), closeForBot: vi.fn(), closeAll: vi.fn() };
  const chrome = {
    service: {
      agentRpc: vi.fn(async (_target: unknown, _method: string, _params: unknown, beforeDispatch?: () => void) => { beforeDispatch?.(); return "chrome"; }),
      previewFrame: vi.fn(async () => ({ png: "frame", format: "jpeg" })),
      withSecretInput: vi.fn(async (_target: unknown, fn: () => Promise<unknown>) => fn()),
      heldBy: vi.fn((): string | null => null),
      interrupted: vi.fn(() => true),
      interruptedCount: vi.fn(() => 2),
      close: vi.fn(async () => undefined),
      fileChooserOffered: vi.fn(() => true),
      answerFileChooser: vi.fn(async () => true),
      download: vi.fn(() => ({ id: "d1" })),
    },
    live: { open: vi.fn(async () => undefined), action: vi.fn(async () => "chrome"), has: vi.fn((viewerId: string) => viewerId === "v-chrome"), handBack: vi.fn(), closeForSession: vi.fn(), closeForOwner: vi.fn(), closeForBot: vi.fn(), closeAll: vi.fn() },
    stream: { open: vi.fn(), closeForSession: vi.fn(), closeForOwner: vi.fn(), closeForBot: vi.fn(), closeAll: vi.fn(), recheck: vi.fn() },
    close: vi.fn(async () => undefined),
  };
  const runtime = new RuntimeRouter(old as unknown as BrowserRuntime, chrome as unknown as ChromeEngine, options);
  const live = new LiveRouter(oldLive as unknown as BrowserLive, chrome as unknown as ChromeEngine);
  return { old, oldLive, chrome, runtime, live };
}

describe("which engine runs a session", () => {
  it("is the new engine only for a spec that names a profile key", () => {
    expect(chromeTarget("s", CHROME)).toEqual({ session: "s", key: "bot:a" });
    expect(chromeTarget("s", AGENT_BROWSER)).toBeNull();
    expect(chromeTarget("s", { command: CHROME_ENGINE, args: [] })).toBeNull();
    expect(chromeTarget("s", undefined)).toBeNull();
  });

  it("gives a bot its own profile, a shared profile's bots one profile, and a temporary browser its session's", () => {
    expect(profileKey("a", "omb-a", { guest: false, partitionId: null })).toBe("bot:a");
    expect(profileKey("a", "omb-p", { guest: false, partitionId: "p1" })).toBe("shared:p1");
    expect(profileKey("a", "omb-a-guest-1", { guest: true, partitionId: null })).toBe("temp:omb-a-guest-1");
  });
});

describe("the runtime router", () => {
  it("sends a new-engine session's calls to the browser service and every other to agent-browser", async () => {
    const { old, chrome, runtime } = engines();
    await expect(runtime.agentRpc("s", CHROME, "tools/call", { name: "agent_browser_open" })).resolves.toBe("chrome");
    expect(chrome.service.agentRpc).toHaveBeenCalledWith({ session: "s", key: "bot:a" }, "tools/call", { name: "agent_browser_open" }, undefined);
    await expect(runtime.agentRpc("s", AGENT_BROWSER, "tools/list", {})).resolves.toBe("agent-browser");
    expect(old.agentRpc).toHaveBeenCalledOnce();
    expect(chrome.service.agentRpc).toHaveBeenCalledOnce();
  });

  it("takes a preview frame from the engine the spec names", async () => {
    const { old, chrome, runtime } = engines();
    await expect(runtime.previewFrame("s", async () => "relayed", CHROME)).resolves.toEqual({ png: "frame", format: "jpeg" });
    await expect(runtime.previewFrame("s", async () => "relayed", AGENT_BROWSER)).resolves.toBe("relayed");
    expect(chrome.service.previewFrame).toHaveBeenCalledOnce();
    expect(old.previewFrame).toHaveBeenCalledOnce();
  });

  it("leaves idle closing of new-engine browsers to the service", async () => {
    const { old, runtime } = engines();
    await expect(runtime.closeIfIdle("s", 1000, CHROME)).resolves.toBe(false);
    expect(old.closeIfIdle).not.toHaveBeenCalled();
    await expect(runtime.closeIfIdle("s", 1000, AGENT_BROWSER)).resolves.toBe(true);
    expect(old.closeIfIdle).toHaveBeenCalledWith("s", 1000, AGENT_BROWSER);
  });

  /** As server/host/browser.ts wires it. */
  const onHost = (host: EgressHost) => {
    const egress = new BrowserEgress();
    egress.configure({ host, config: () => ({}), ownership: { botOwned: async () => false } as unknown as ListenerOwnership, listeners: new OwnListeners(host, { env: {}, streamPorts: () => [], devToolsPorts: () => [] }) });
    return engines({ refusal: (_session, spec, params) => (attachesToChrome(spec.env) ? null : egress.callRefusal(params)) });
  };
  const OPENS_REDDIT = [
    { name: "agent_browser_open", arguments: { url: "https://www.reddit.com/r/test/" } },
    { name: "agent_browser_navigate", arguments: { url: "old.reddit.com/r/test" } },
    { name: "agent_browser_tabs", arguments: { action: "new", url: "https://i.redd.it/a.png" } },
    { name: "agent_browser_tab_new", arguments: { url: "https://www.reddit.com/" } },
  ];

  it("tells a bot on MausBot Cloud why its browser doesn't open Reddit, on either engine, without reaching it", async () => {
    const { old, chrome, runtime } = onHost("cloud");
    for (const spec of [AGENT_BROWSER, CHROME]) {
      for (const call of OPENS_REDDIT) {
        await expect(runtime.agentRpc("s", spec, "tools/call", call), `${spec.command} ${call.name}`).resolves.toEqual({ isError: true, content: [{ type: "text", text: REDDIT_REFUSAL }] });
      }
    }
    expect(old.agentRpc).not.toHaveBeenCalled();
    expect(chrome.service.agentRpc).not.toHaveBeenCalled();
    await expect(runtime.agentRpc("s", CHROME, "tools/call", { name: "agent_browser_open", arguments: { url: "https://example.com/" } })).resolves.toBe("chrome");
    await expect(runtime.agentRpc("s", AGENT_BROWSER, "tools/list", OPENS_REDDIT[0])).resolves.toBe("agent-browser");
  });

  it("opens Reddit on the desktop, on a self-hosted server and in the person's own Chrome", async () => {
    for (const host of ["desktop", "server"] as const) {
      const { old, chrome, runtime } = onHost(host);
      for (const call of OPENS_REDDIT) {
        await expect(runtime.agentRpc("s", AGENT_BROWSER, "tools/call", call)).resolves.toBe("agent-browser");
        await expect(runtime.agentRpc("s", CHROME, "tools/call", call)).resolves.toBe("chrome");
      }
      expect(old.agentRpc).toHaveBeenCalledTimes(OPENS_REDDIT.length);
      expect(chrome.service.agentRpc).toHaveBeenCalledTimes(OPENS_REDDIT.length);
    }
    const { runtime } = onHost("cloud");
    const myChrome = { ...AGENT_BROWSER, env: { ...AGENT_BROWSER.env, AGENT_BROWSER_AUTO_CONNECT: "1" } };
    await expect(runtime.agentRpc("s", myChrome, "tools/call", OPENS_REDDIT[0])).resolves.toBe("agent-browser");
  });

  it("refusal and afterCall see the session", async () => {
    const refused: string[] = [];
    const afterCall = vi.fn((_session: string, _spec: unknown, result: unknown) => ({ after: result }));
    const { old, runtime } = engines({
      refusal: (session) => { refused.push(session); return null; },
      annotate: (_spec, result) => ({ annotated: result }),
      afterCall,
    });
    await expect(runtime.agentRpc("s1", AGENT_BROWSER, "tools/call", { name: "agent_browser_snapshot" })).resolves.toEqual({ after: { annotated: "agent-browser" } });
    expect(refused).toEqual(["s1"]);
    expect(afterCall).toHaveBeenCalledWith("s1", AGENT_BROWSER, { annotated: "agent-browser" });
    await expect(runtime.agentRpc("s1", AGENT_BROWSER, "tools/list", {}), "a listing is neither refused nor passed on").resolves.toBe("agent-browser");
    expect(refused).toEqual(["s1"]);
    expect(afterCall).toHaveBeenCalledOnce();
    expect(old.agentRpc).toHaveBeenCalledTimes(2);
  });

  it("asks afterClaim once beforeDispatch has claimed, and its refusal reaches neither engine", async () => {
    const order: string[] = [];
    let refuse: string | null = null;
    const { old, chrome, runtime } = engines({ afterClaim: (session) => { order.push(`afterClaim ${session}`); return refuse; } });
    const claim = () => { order.push("claim"); };
    await expect(runtime.agentRpc("s1", AGENT_BROWSER, "tools/call", { name: "agent_browser_snapshot" }, claim)).resolves.toBe("agent-browser");
    expect(order).toEqual(["claim", "afterClaim s1"]);
    refuse = "Not this conversation.";
    const refused = { isError: true, content: [{ type: "text", text: "Not this conversation." }] };
    let reached = 0;
    old.agentRpc.mockImplementationOnce(async (_session, _spec, _method, _params, beforeDispatch) => { beforeDispatch?.(); reached++; return "agent-browser"; });
    await expect(runtime.agentRpc("s1", AGENT_BROWSER, "tools/call", { name: "agent_browser_snapshot" }, claim)).resolves.toEqual(refused);
    chrome.service.agentRpc.mockImplementationOnce(async (_target, _method, _params, beforeDispatch) => { beforeDispatch?.(); reached++; return "chrome"; });
    await expect(runtime.agentRpc("s", CHROME, "tools/call", { name: "agent_browser_snapshot" }, claim)).resolves.toEqual(refused);
    expect(reached, "nothing after the claim ran").toBe(0);
    order.length = 0;
    await expect(runtime.agentRpc("s1", AGENT_BROWSER, "tools/list", {}, claim), "a listing is not judged").resolves.toBe("agent-browser");
    expect(order).toEqual(["claim"]);
    const taken = () => { throw new Error("another thread is using this browser"); };
    await expect(runtime.agentRpc("s1", AGENT_BROWSER, "tools/call", { name: "agent_browser_snapshot" }, taken), "beforeDispatch's own refusal is unchanged").rejects.toThrow("another thread is using this browser");
  });

  it("answers who holds a session and what was interrupted across both engines", () => {
    const { chrome, runtime } = engines();
    expect(runtime.heldBy("s")).toBe("person");
    chrome.service.heldBy.mockReturnValue("viewer-1");
    expect(runtime.heldBy("s")).toBe("viewer-1");
    expect(runtime.interrupted("s")).toBe(true);
    expect(runtime.interruptedCount()).toBe(3);
  });
});

describe("the live view router", () => {
  it("opens a new-engine session's viewer on the v1 adapter, without the spec, and any other on agent-browser's", async () => {
    const { oldLive, chrome, live } = engines();
    const res = {} as never;
    const isCurrent = () => true;
    await live.open({ botId: "a", session: "s", spec: CHROME, owner: "o", isCurrent, res });
    expect(chrome.live.open).toHaveBeenCalledWith({ botId: "a", session: "s", owner: "o", isCurrent, res });
    await live.open({ botId: "a", session: "s", spec: AGENT_BROWSER, owner: "o", isCurrent, res });
    expect(oldLive.open).toHaveBeenCalledOnce();
  });

  it("sends an action to the engine whose viewer sent it", async () => {
    const { oldLive, live } = engines();
    await expect(live.action({ viewerId: "v-chrome", botId: "a", owner: "o", body: { type: "take" } })).resolves.toBe("chrome");
    await expect(live.action({ viewerId: "v-old", botId: "a", owner: "o", body: { type: "take" } })).resolves.toBe("agent-browser");
    expect(oldLive.action).toHaveBeenCalledOnce();
  });

  it("closes viewers on both engines, streams included, and streams no longer allowed", () => {
    const { oldLive, chrome, live } = engines();
    live.closeForSession("s");
    live.closeForOwner("o");
    live.closeAll();
    live.recheck();
    expect(chrome.stream.recheck).toHaveBeenCalledOnce();
    expect(chrome.live.closeForSession).toHaveBeenCalledWith("s");
    expect(chrome.stream.closeForSession).toHaveBeenCalledWith("s");
    expect(chrome.stream.closeForOwner).toHaveBeenCalledWith("o");
    expect(oldLive.closeForSession).toHaveBeenCalledWith("s");
    expect(chrome.live.closeAll).toHaveBeenCalledOnce();
    expect(chrome.stream.closeAll).toHaveBeenCalledOnce();
    expect(oldLive.closeAll).toHaveBeenCalledOnce();
  });

  it("streams, takes uploads for and serves downloads of new-engine sessions only", async () => {
    const { chrome, live } = engines();
    const request = { botId: "a", owner: "o", canOperate: true, params: new URLSearchParams(), req: {} as never, socket: {} as never, head: Buffer.alloc(0), isCurrent: () => true, restartRefusal: () => null };
    expect(live.stream({ session: "s", spec: AGENT_BROWSER, ...request })).toBe(false);
    expect(chrome.stream.open).not.toHaveBeenCalled();
    expect(live.stream({ session: "s", spec: CHROME, ...request })).toBe(true);
    expect(chrome.stream.open).toHaveBeenCalledWith({ ...request, target: { session: "s", key: "bot:a" } });
    expect(live.fileChooserOffered({ session: "s", spec: AGENT_BROWSER }, "o", "c")).toBe(false);
    expect(live.fileChooserOffered({ session: "s", spec: CHROME }, "o", "c")).toBe(true);
    expect(chrome.service.fileChooserOffered).toHaveBeenCalledWith("s", "o", "c");
    await expect(live.answerFileChooser({ session: "s", spec: AGENT_BROWSER }, "o", "c", [])).resolves.toBe(false);
    await expect(live.answerFileChooser({ session: "s", spec: CHROME }, "o", "c", ["/f"])).resolves.toBe(true);
    expect(chrome.service.answerFileChooser).toHaveBeenCalledWith("s", "o", "c", ["/f"]);
    expect(live.download({ session: "s", spec: AGENT_BROWSER }, "d1")).toBeUndefined();
    expect(live.download({ session: "s", spec: CHROME }, "d1")).toEqual({ id: "d1" });
  });
});

describe("the new engine's minute", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  function engine() {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-chrome-engine-"));
    const value = new ChromeEngine({ dataDir, host: "container", env: {}, platform: "linux", egressPort: async () => 0, idleMs: () => 180_000, egressNotice: () => null });
    cleanups.push(async () => { await value.close(); await removeTempDir(dataDir); });
    const closeIdle = vi.spyOn(value.service, "closeIdle").mockResolvedValue([]);
    const registry = new ProcessRegistry(browserRoot(dataDir));
    const launched = () => registry.add({ pid: process.pid, startTime: null, userDataDir: join(browserRoot(dataDir), "profiles", "p"), ownerPid: process.pid, launchedAt: new Date().toISOString() });
    return { value, closeIdle, launched, exited: () => registry.remove(process.pid) };
  }

  it("closes idle browsers every minute while the engine is in use", async () => {
    vi.useFakeTimers();
    const { value, closeIdle } = engine();
    value.start({ inUse: true, prepare: false });
    expect(closeIdle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(closeIdle).toHaveBeenCalledTimes(3);
  });

  it("keeps closing idle browsers once switched off while a Chrome it started still runs, and does nothing once none does", async () => {
    vi.useFakeTimers();
    const { value, closeIdle, launched, exited } = engine();
    value.start({ inUse: false, prepare: false });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(closeIdle).not.toHaveBeenCalled();
    launched();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closeIdle).toHaveBeenCalledTimes(1);
    value.start({ inUse: true, prepare: false });
    value.start({ inUse: false, prepare: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closeIdle).toHaveBeenCalledTimes(3);
    exited();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(closeIdle).toHaveBeenCalledTimes(3);
  });
});
