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
