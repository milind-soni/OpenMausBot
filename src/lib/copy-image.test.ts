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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Stands in for the browser's image decoder and canvas, which the test runner does not have. */
function stubCanvas({ png = blob("image/png") as Blob | null, decodes = true } = {}) {
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage })),
    toBlob: vi.fn((done: (b: Blob | null) => void, type: string) => done(type === "image/png" ? png : null)),
  };
  class FakeImage {
    src = "";
    naturalWidth = 640;
    naturalHeight = 480;
    decode = async () => {
      if (!decodes) throw new Error("bad image");
    };
  }
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
  const created = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image");
  const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return { canvas, drawImage, created, revoked };
}

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

  it("redraws other image types on a canvas by default", async () => {
    const write = stubClipboard();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(blob("image/webp"))));
    const png = blob("image/png");
    const { canvas, drawImage, created, revoked } = stubCanvas({ png });
    expect(await copyImage("/api/files/a.webp")).toBe("copied");
    expect(await write.mock.calls[0]![0][0]!.items["image/png"]).toBe(png);
    expect([canvas.width, canvas.height]).toEqual([640, 480]);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(canvas.toBlob.mock.calls[0]![1]).toBe("image/png");
    expect(revoked).toHaveBeenCalledWith(created.mock.results[0]!.value);
  });

  it("reports a failure and frees the image when the default redraw fails", async () => {
    stubClipboard();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(blob("image/webp"))));
    const { revoked } = stubCanvas({ decodes: false });
    expect(await copyImage("/api/files/a.webp")).toBe("failed");
    expect(revoked).toHaveBeenCalledWith("blob:image");

    stubCanvas({ png: null });
    expect(await copyImage("/api/files/a.webp")).toBe("failed");
  });
});
