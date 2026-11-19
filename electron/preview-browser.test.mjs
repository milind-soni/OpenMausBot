import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { acquirePreviewDebugger, withPreviewDebugger, capturePreviewPNG, PreviewBrowserSession } from "./preview-browser.mjs";
function target(attached = false) {
  const debuggerAPI = new EventEmitter();
  Object.assign(debuggerAPI, { isAttached: () => attached, attach: vi.fn(() => { attached = true; }), detach: vi.fn(() => { attached = false; }), sendCommand: vi.fn(async () => ({})) });
  return { debugger: debuggerAPI, isDestroyed: () => false, capturePage: vi.fn(), getURL: () => "http://fixture/" };
}
describe("Preview debugger ownership", () => {
  it("serializes captures without detaching an active testing session", async () => {
    const wc = target(); const release = acquirePreviewDebugger(wc); const order = [];
    await Promise.all([withPreviewDebugger(wc, async () => { order.push(1); await Promise.resolve(); order.push(2); }), withPreviewDebugger(wc, async () => order.push(3))]);
    expect(order).toEqual([1,2,3]); expect(wc.debugger.attach).toHaveBeenCalledTimes(1); expect(wc.debugger.detach).not.toHaveBeenCalled();
    release(); release(); expect(wc.debugger.detach).toHaveBeenCalledTimes(1);
  });
  it("does not detach another debugger owner and bounds oversized full-page captures", async () => {
    const wc = target(true); wc.debugger.sendCommand.mockResolvedValue({ cssContentSize: { width: 1000, height: 1000000 } });
    await expect(capturePreviewPNG(wc, true)).rejects.toThrow("too large");
    expect(wc.debugger.detach).not.toHaveBeenCalled();
  });
  it("bounds diagnostics, omits URL query credentials, and removes listeners on close", async () => {
    const wc = target(); const browser = new PreviewBrowserSession(wc, () => true); await browser.ready;
    wc.debugger.emit("message", {}, "Network.requestWillBeSent", { requestId: "1", request: { url: "https://user:secret@fixture/missing?token=secret#secret" } });
    wc.debugger.emit("message", {}, "Network.loadingFailed", { requestId: "1", errorText: "failed" });
    expect(browser.diagnostics[0].url).toBe("https://fixture/missing");
    for (let i=0;i<150;i++) browser.log({ kind: "test" });
    expect(browser.diagnostics).toHaveLength(100);
    browser.dispose(); expect(wc.debugger.listenerCount("message")).toBe(0); expect(wc.debugger.detach).toHaveBeenCalledTimes(1);
  });
});

describe("Preview page validation", () => {
  it.each(["100\u202f000 FCFA", "100\u00a0000 FCFA", "100 \n 000 FCFA"])("waits for formatted prices: %s", async text => {
    const wc = target();
    wc.executeJavaScriptInIsolatedWorld = async (_world, [{ code }]) => {
      const document = { body: { innerText: text } };
      return new Function("document", `return ${code}`)(document);
    };
    const browser = new PreviewBrowserSession(wc, () => true);
    try {
      await expect(browser.perform("wait", { text: "100 000 FCFA", timeout_ms: 0 }, new AbortController().signal)).resolves.toMatchObject({ completed: "wait" });
      await expect(browser.perform("wait", { text: "100 001 FCFA", timeout_ms: 0 }, new AbortController().signal)).rejects.toThrow("timed out");
    } finally { browser.dispose(); }
  });
  it("preserves disabled-control errors without sending mouse input", async () => {
    const wc = target();
    const el = { isConnected: true, matches: () => true };
    wc.executeJavaScriptInIsolatedWorld = async (_world, [{ code }]) => new Function("globalThis", `return ${code}`)({ __gbsPreviewNodes: new Map([["disabled", el]]) });
    const browser = new PreviewBrowserSession(wc, () => true);
    try {
      await expect(browser.perform("click", { ref: "disabled" }, new AbortController().signal)).rejects.toThrow("This control is disabled.");
      expect(wc.debugger.sendCommand.mock.calls.some(([method]) => method.startsWith("Input."))).toBe(false);
      await expect(browser.perform("click", { ref: "stale" }, new AbortController().signal)).rejects.toThrow("Stale element reference");
    } finally { browser.dispose(); }
  });
  it("types and presses keys without taking keyboard focus from the composer", async () => {
    const wc = target();
    wc.focus = vi.fn();
    // every in-page step (find, focus/select, value check) succeeds
    wc.executeJavaScriptInIsolatedWorld = async () => ({ ok: true, value: true });
    const browser = new PreviewBrowserSession(wc, () => true);
    try {
      await browser.perform("fill", { ref: "field", text: "hello" }, new AbortController().signal);
      await browser.perform("press", { key: "Enter", ref: "field" }, new AbortController().signal);
      expect(wc.focus).not.toHaveBeenCalled();
      expect(wc.debugger.sendCommand.mock.calls.some(([method]) => method === "Input.insertText")).toBe(true);
      expect(wc.debugger.sendCommand.mock.calls.some(([method]) => method === "Emulation.setFocusEmulationEnabled")).toBe(true);
    } finally { browser.dispose(); }
  });
});
