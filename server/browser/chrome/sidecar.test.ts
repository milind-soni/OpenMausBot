import { describe, expect, it, vi } from "vitest";

import type { Cdp, CdpListeners } from "../../browser-sites.ts";
import { NO_PASSKEY_AUTHENTICATOR } from "../cdp/passkeys.ts";
import type { ChromeIdentity } from "./identity.ts";
import { IdentitySidecars, startIdentitySidecar } from "./sidecar.ts";

const IDENTITY: ChromeIdentity = {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  userAgentMetadata: {
    brands: [{ brand: "Chromium", version: "153" }], fullVersionList: [{ brand: "Chromium", version: "153.0.8010.47" }], fullVersion: "153.0.8010.47",
    platform: "macOS", platformVersion: "26.3.1", architecture: "arm", model: "", mobile: false, bitness: "64", wow64: false, formFactors: ["Desktop"],
  },
};

/** A browser connection that records what is sent and lets the test attach targets. */
function fakeBrowser() {
  const sent: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
  let listeners: CdpListeners = {};
  const cdp: Cdp = {
    send: async (method, params, sessionId) => { sent.push({ method, params, sessionId }); return {}; },
    close: () => listeners.closed?.(),
  };
  const connect = vi.fn(async (_url: string, _timeoutMs?: number, given: CdpListeners = {}) => { listeners = given; return cdp; });
  const attach = (sessionId: string, type: string, parent?: string) =>
    listeners.event?.({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { type, url: "" }, waitingForDebugger: true }, ...(parent ? { sessionId: parent } : {}) });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const on = (sessionId: string) => sent.filter((message) => message.sessionId === sessionId).map((message) => message.method);
  return { sent, connect, attach, settle, on, drop: () => listeners.closed?.() };
}

describe("the identity sidecar", () => {
  it("holds every new page and worker until it has the browser's own identity, then lets it run", async () => {
    const browser = fakeBrowser();
    await startIdentitySidecar("ws://127.0.0.1:9/devtools/browser/x", IDENTITY, browser.connect);
    expect(browser.sent[0]).toEqual({ method: "Target.setAutoAttach", sessionId: undefined, params: {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: "page" }, { type: "service_worker" }, { type: "shared_worker" }, { exclude: true }],
    } });
    browser.attach("page-1", "page");
    browser.attach("frame-1", "iframe", "page-1");
    browser.attach("sw-1", "service_worker");
    browser.attach("worker-1", "worker", "page-1");
    await browser.settle();
    expect(browser.on("page-1")).toEqual(["Emulation.setUserAgentOverride", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]);
    expect(browser.on("frame-1")).toEqual(["Emulation.setUserAgentOverride", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]);
    expect(browser.on("sw-1")).toEqual(["Emulation.setUserAgentOverride", "Network.setUserAgentOverride", "Runtime.runIfWaitingForDebugger"]);
    expect(browser.on("worker-1")).toEqual(["Network.setUserAgentOverride", "Runtime.runIfWaitingForDebugger"]);
    const override = browser.sent.find((message) => message.sessionId === "page-1" && message.method === "Emulation.setUserAgentOverride");
    expect(override?.params).toEqual({ userAgent: IDENTITY.userAgent, userAgentMetadata: IDENTITY.userAgentMetadata });
    expect(browser.sent.find((message) => message.sessionId === "page-1" && message.method === "Target.setAutoAttach")?.params).toEqual({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  });

  it("gives a headless browser's pages an authenticator with no passkey before they run, so a passkey request ends at once", async () => {
    const headless = fakeBrowser();
    await startIdentitySidecar("ws://127.0.0.1:9/devtools/browser/x", IDENTITY, headless.connect, { noPasskeys: true });
    headless.attach("page-1", "page");
    headless.attach("frame-1", "iframe", "page-1");
    await headless.settle();
    expect(headless.on("page-1")).toEqual(["WebAuthn.enable", "WebAuthn.addVirtualAuthenticator", "Emulation.setUserAgentOverride", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]);
    expect(headless.sent.find((message) => message.method === "WebAuthn.enable")?.params).toEqual({ enableUI: false });
    expect(headless.sent.find((message) => message.method === "WebAuthn.addVirtualAuthenticator")?.params).toEqual({ options: NO_PASSKEY_AUTHENTICATOR });
    expect(NO_PASSKEY_AUTHENTICATOR).toMatchObject({ isUserVerified: false, automaticPresenceSimulation: true });
    expect(headless.on("frame-1")).not.toContain("WebAuthn.enable");
    const headed = fakeBrowser();
    await startIdentitySidecar("ws://127.0.0.1:9/devtools/browser/x", IDENTITY, headed.connect);
    headed.attach("page-1", "page");
    await headed.settle();
    expect(headed.on("page-1")).not.toContain("WebAuthn.enable");
  });

  it("never sends the calls sites detect, whatever attaches", async () => {
    const browser = fakeBrowser();
    await startIdentitySidecar("ws://127.0.0.1:9/devtools/browser/x", IDENTITY, browser.connect);
    for (const [index, type] of ["page", "iframe", "worker", "service_worker", "shared_worker", "other"].entries()) browser.attach(`s${index}`, type);
    await browser.settle();
    const methods = new Set(browser.sent.map((message) => message.method));
    expect([...methods].sort()).toEqual(["Emulation.setUserAgentOverride", "Network.setUserAgentOverride", "Runtime.runIfWaitingForDebugger", "Target.setAutoAttach"]);
    expect(browser.on("s5")).toEqual(["Runtime.runIfWaitingForDebugger"]);
  });
});

describe("one sidecar per browser session", () => {
  const spec = { command: "/engine/agent-browser", env: { AGENT_BROWSER_HEADLESS: "1" } };

  it("attaches once, and again after the browser was started anew", async () => {
    const browsers = [fakeBrowser(), fakeBrowser()];
    const cdpUrl = vi.fn(async () => "ws://127.0.0.1:9/devtools/browser/x");
    let started = 0;
    const sidecars = new IdentitySidecars({ cdpUrl, start: (url, identity) => startIdentitySidecar(url, identity, browsers[started++]!.connect) });
    await Promise.all([sidecars.ensure("bot-1", spec, IDENTITY), sidecars.ensure("bot-1", spec, IDENTITY)]);
    await sidecars.ensure("bot-1", spec, IDENTITY);
    expect(cdpUrl).toHaveBeenCalledOnce();
    expect(sidecars.attached("bot-1")).toBe(true);
    browsers[0]!.drop();
    await browsers[0]!.settle();
    expect(sidecars.attached("bot-1")).toBe(false);
    await sidecars.ensure("bot-1", spec, IDENTITY);
    expect(cdpUrl).toHaveBeenCalledTimes(2);
    expect(browsers[1]!.connect).toHaveBeenCalledOnce();
    sidecars.forget("bot-1");
    expect(sidecars.attached("bot-1")).toBe(false);
  });

  it("turns passkeys down in a headless session's browser only", async () => {
    const start = vi.fn(async () => ({ closed: new Promise<void>(() => {}), close: () => {} }));
    const sidecars = new IdentitySidecars({ cdpUrl: async () => "ws://127.0.0.1:9/devtools/browser/x", start });
    await sidecars.ensure("bot-1", spec, IDENTITY);
    await sidecars.ensure("bot-2", { ...spec, env: {} }, IDENTITY);
    expect(start.mock.calls.map((call) => (call as unknown[])[3])).toEqual([{ noPasskeys: true }, { noPasskeys: false }]);
  });

  it("does nothing when the session has no browser to reach", async () => {
    const start = vi.fn();
    const sidecars = new IdentitySidecars({ cdpUrl: async () => null, start });
    await sidecars.ensure("bot-1", spec, IDENTITY);
    expect(start).not.toHaveBeenCalled();
    expect(sidecars.attached("bot-1")).toBe(false);
  });
});
