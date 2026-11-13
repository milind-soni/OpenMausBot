import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrollSyncGuard, scrollRatio, scrollSyncSupport, syncWebviewScroll } from "./previewScrollSync";
import type { PreviewSource } from "./mobilePreviewUrl";
const file = (fileType: "markdown" | "html" | "pdf" | "image"): PreviewSource => ({ kind: "file", fileType, filePath: `sample.${fileType}`, projectId: "test" });
afterEach(() => vi.useRealTimers());
describe("scroll sync support", () => {
  it("offers only the supported document/host combinations with plain guidance", () => {
    expect(scrollSyncSupport(file("markdown"), false).supported).toBe(false);
    expect(scrollSyncSupport(file("html"), true).supported).toBe(true);
    expect(scrollSyncSupport(file("html"), false)).toMatchObject({ supported: false, guidance: expect.stringContaining("desktop app") });
    expect(scrollSyncSupport(file("pdf"), true)).toMatchObject({ supported: false, guidance: expect.stringContaining("only") });
    expect(scrollSyncSupport(file("image"), true).supported).toBe(false);
    const page: PreviewSource = { kind: "url", url: "https://example.com", raw: "example.com", isLocalOrPrivate: false };
    expect(scrollSyncSupport(page, true).supported).toBe(true);
    expect(scrollSyncSupport(page, false).supported).toBe(false);
    expect(scrollSyncSupport(null, false).supported).toBe(false);
  });
  it("rejects invalid transport values and bounds ratios", () => {
    for (const value of [NaN, Infinity, undefined, null, "0.5", {}]) expect(scrollRatio(value)).toBeNull();
    expect(scrollRatio(-1)).toBe(0); expect(scrollRatio(2)).toBe(1);
  });
});
describe("programmatic follower guard", () => {
  it("suppresses rounded/clamped follower positions while allowing the next real scroll", () => {
    const guard = new ScrollSyncGuard();
    guard.applied(187);
    expect(guard.observe(187, 374)).toBeNull();
    expect(guard.observe(187.25, 374)).toBeNull();
    expect(guard.observe(200, 400)).toBe(0.5);
    expect(guard.observe(200, 400)).toBeNull();
    guard.applied(0); expect(guard.observe(0, 0)).toBeNull();
    expect(guard.observe(NaN, 100)).toBeNull();
  });
});
describe("serialized webview scroll bridge", () => {
  it("does not echo writes, but reports later user movement and cleans its timer", async () => {
    vi.useFakeTimers(); let top = 0;
    const view = { executeJavaScript: vi.fn(async (code: string) => { if (code.includes("window.scrollTo")) top = 500; return { top, maximum: 1000 }; }) };
    const report = vi.fn(), bridge = syncWebviewScroll(view, report);
    await vi.advanceTimersByTimeAsync(0);
    bridge.apply(0.5); await vi.advanceTimersByTimeAsync(150);
    expect(view.executeJavaScript.mock.calls.some(([code]) => code.includes("* 0.5"))).toBe(true);
    expect(report).not.toHaveBeenCalled();
    top = 650; await vi.advanceTimersByTimeAsync(150); expect(report).toHaveBeenCalledExactlyOnceWith(0.65);
    bridge.close(); const calls = view.executeJavaScript.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500); bridge.apply(0.1);
    expect(view.executeJavaScript).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0);
  });
  it("coalesces pending writes and ignores late results after close", async () => {
    vi.useFakeTimers(); let finish!: (value: unknown) => void;
    const view = { executeJavaScript: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ top: 900, maximum: 1000 }) };
    const report = vi.fn(), bridge = syncWebviewScroll(view, report);
    bridge.apply(0.2); bridge.apply(0.9); finish({ top: 100, maximum: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(view.executeJavaScript).toHaveBeenCalledTimes(2);
    expect(view.executeJavaScript.mock.calls[1][0]).toContain("* 0.9"); expect(report).not.toHaveBeenCalled();
    bridge.close();
    let late!: (value: unknown) => void;
    const stopped = syncWebviewScroll({ executeJavaScript: () => new Promise(resolve => { late = resolve; }) }, report);
    stopped.close(); late({ top: 750, maximum: 1000 }); await vi.advanceTimersByTimeAsync(0);
    expect(report).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("retries writes after navigation errors without a busy loop", async () => {
    vi.useFakeTimers(); let ready = false;
    const view = { executeJavaScript: vi.fn(async (_code: string) => { if (!ready) throw Error("loading"); return { top: 500, maximum: 1000 }; }) };
    const report = vi.fn(), bridge = syncWebviewScroll(view, report);
    await vi.advanceTimersByTimeAsync(0); bridge.apply(0.5); await vi.advanceTimersByTimeAsync(0);
    expect(view.executeJavaScript).toHaveBeenCalledTimes(2);
    ready = true; await vi.advanceTimersByTimeAsync(150);
    expect(view.executeJavaScript.mock.calls.at(-1)![0]).toContain("* 0.5"); expect(report).not.toHaveBeenCalled(); bridge.close();
  });
});
