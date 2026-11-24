import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, WEB_WRITE_TIMEOUT_MS } from "./copy-text";

class DeferredClipboardItem {
  constructor(readonly data: Record<string, Promise<Blob>>) {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("copying a conversation whose earlier messages are still loading", () => {
  it("starts the clipboard write during the click and supplies the full text when it is ready", async () => {
    const content = Promise.withResolvers<string>();
    const written: string[] = [];
    const write = vi.fn(async ([item]: DeferredClipboardItem[]) => {
      written.push(await (await item!.data["text/plain"]).text());
    });
    const writeText = vi.fn();
    vi.stubGlobal("ClipboardItem", DeferredClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    const result = copyText(content.promise);
    expect(write).toHaveBeenCalledOnce();
    expect(written).toEqual([]);
    content.resolve("First page\nLast page");
    expect(await result).toBe("copied");
    expect(written).toEqual(["First page\nLast page"]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("keeps the existing web path when deferred clipboard items are unavailable", async () => {
    const content = Promise.withResolvers<string>();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("ClipboardItem", undefined);
    const result = copyText(content.promise);
    expect(writeText).not.toHaveBeenCalled();
    content.resolve("Full conversation");
    expect(await result).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("Full conversation");
  });

  it("uses the existing desktop fallback after the history has loaded", async () => {
    const bridge = vi.fn(async () => true);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { ogb: { copyText: bridge } });
    expect(await copyText(Promise.resolve("Full conversation"))).toBe("copied");
    expect(bridge).toHaveBeenCalledWith("Full conversation");
  });

  it("does not replace the clipboard with a partial transcript when loading fails", async () => {
    const content = Promise.withResolvers<string>();
    const write = vi.fn(async ([item]: DeferredClipboardItem[]) => { await item!.data["text/plain"]; });
    const writeText = vi.fn();
    const bridge = vi.fn();
    vi.stubGlobal("ClipboardItem", DeferredClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    vi.stubGlobal("window", { ogb: { copyText: bridge } });
    const result = copyText(content.promise);
    content.reject(new Error("History could not load"));
    expect(await result).toBe("failed");
    expect(writeText).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });

  it("does not write an empty result", async () => {
    const write = vi.fn(async ([item]: DeferredClipboardItem[]) => { await item!.data["text/plain"]; });
    const writeText = vi.fn();
    vi.stubGlobal("ClipboardItem", DeferredClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    expect(await copyText(Promise.resolve(" \n "))).toBe("empty");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("bounds an unsettled clipboard write after the requested history becomes available", async () => {
    vi.useFakeTimers();
    const content = Promise.withResolvers<string>();
    const bridge = vi.fn(async () => true);
    const write = vi.fn(() => new Promise(() => {}));
    const writeText = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("ClipboardItem", DeferredClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    vi.stubGlobal("window", { ogb: { copyText: bridge } });
    const result = copyText(content.promise);
    await vi.advanceTimersByTimeAsync(WEB_WRITE_TIMEOUT_MS * 2);
    expect(bridge).not.toHaveBeenCalled();
    content.resolve("Full conversation");
    await vi.advanceTimersByTimeAsync(WEB_WRITE_TIMEOUT_MS - 1);
    expect(bridge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe("copied");
    expect(bridge).toHaveBeenCalledWith("Full conversation");
    expect(write).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start a second native write after a deferred clipboard write rejects", async () => {
    const bridge = vi.fn(async () => true);
    const write = vi.fn(async () => { throw new Error("Write denied"); });
    const writeText = vi.fn();
    vi.stubGlobal("ClipboardItem", DeferredClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write, writeText } });
    vi.stubGlobal("window", { ogb: { copyText: bridge } });
    expect(await copyText(Promise.resolve("Full conversation"))).toBe("copied");
    expect(write).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith("Full conversation");
  });
});
