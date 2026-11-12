import { afterEach, describe, expect, it, vi } from "vitest";

import { canCopyImage, copyImage } from "./copy-image";

class FakeClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

type Write = (items: FakeClipboardItem[]) => Promise<void>;

function stubClipboard(write: Write = async (items) => void (await items[0]!.items["image/png"])) {
  const spy = vi.fn(write);
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  vi.stubGlobal("navigator", { clipboard: { write: spy } });
  return spy;
}

const blob = (type: string) => new Blob(["x"], { type });

afterEach(() => vi.unstubAllGlobals());

describe("copyImage", () => {
  it("is offered only where the clipboard takes images", () => {
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
    expect(canCopyImage()).toBe(false);
    stubClipboard();
    expect(canCopyImage()).toBe(true);
  });

  it("puts a PNG on the clipboard as it is", async () => {
    const write = stubClipboard();
    const png = blob("image/png");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(png)));
    const toPng = vi.fn(async (b: Blob) => b);
    expect(await copyImage("/api/files/a.png", toPng)).toBe("copied");
    const item = write.mock.calls[0]![0][0]!;
    expect(Object.keys(item.items)).toEqual(["image/png"]);
    expect((await item.items["image/png"]).type).toBe("image/png");
    expect(toPng).not.toHaveBeenCalled();
  });

  it("redraws other image types as PNG", async () => {
    const write = stubClipboard();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(blob("image/jpeg"))));
    const png = blob("image/png");
    const toPng = vi.fn(async () => png);
    expect(await copyImage("/api/files/a.jpg", toPng)).toBe("copied");
    expect(await write.mock.calls[0]![0][0]!.items["image/png"]).toBe(png);
    expect(toPng).toHaveBeenCalledOnce();
  });

  it("reports a failure when the image is missing", async () => {
    stubClipboard();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    expect(await copyImage("/api/files/missing.png")).toBe("failed");
  });

  it("reports a failure when the clipboard refuses", async () => {
    stubClipboard(async () => {
      throw new Error("denied");
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(blob("image/png"))));
    expect(await copyImage("/api/files/a.png")).toBe("failed");
  });

  it("does nothing where the clipboard cannot take images", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await copyImage("/api/files/a.png")).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
