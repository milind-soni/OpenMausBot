// @vitest-environment happy-dom
import { isExternalImageSource } from "./CachedChatImage";
import { FilePreviewDialog } from "./FilePreviewDialog";
import { MENU_MOTION_MS } from "./MenuMotion";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import {
  AttachedFileChips,
  AttachedImageGallery,
  AttachmentPreviewDialog,
  AttachmentThumbnail,
  MarkdownImagePreview,
  OutsideWorkspaceFile,
  canonicalDownloadFilename,
  contentDispositionFilename,
  imageGalleryLayout,
  messageImagePreviewUrl,
  previewImage,
  previewKeyAction,
  requestMessageFile,
  safeDownloadFilename,
  saveFailureText,
  useLocalFileSave,
  nextImageIndex,
} from "./AttachmentPreview";

describe("attachment image navigation", () => {
  it("stops previous and next navigation at the ends", () => {
    expect(nextImageIndex(0, 1, 3)).toBe(1);
    expect(nextImageIndex(2, -1, 3)).toBe(1);
    expect(nextImageIndex(0, -1, 3)).toBe(0);
    expect(nextImageIndex(2, 1, 3)).toBe(2);
    expect(nextImageIndex(0, 1, 0)).toBe(0);
  });

  it("maps preview keys only when the action is available", () => {
    expect(previewKeyAction("Escape", 1)).toBe("close");
    expect(previewKeyAction("ArrowLeft", 3)).toBe("previous");
    expect(previewKeyAction("ArrowRight", 3)).toBe("next");
    expect(previewKeyAction("ArrowRight", 1)).toBeNull();
    expect(previewKeyAction("Enter", 3)).toBeNull();
  });

  it("uses compact responsive grids for one, two, and many images", () => {
    expect(imageGalleryLayout(1)).toContain("grid-cols-1");
    expect(imageGalleryLayout(2)).toContain("grid-cols-2");
    expect(imageGalleryLayout(3)).toContain("sm:grid-cols-3");
  });
});

describe("attachment download filenames", () => {
  it("prefers the UTF-8 server filename and makes it portable", () => {
    expect(contentDispositionFilename(
      `attachment; filename="fallback.md"; filename*=UTF-8''..%2Fnotes%2Fr%C3%A9sum%C3%A9%20%22final%22.md`,
    )).toBe("résumé _final_.md");
    expect(safeDownloadFilename("../../AUX.txt")).toBe("_AUX.txt");
    expect(safeDownloadFilename(`bad\u202ename\ud800.txt`)).toBe("badname.txt");
  });

  it("uses a safe fallback when the response has no filename", () => {
    expect(canonicalDownloadFilename({
      fallback: "../reports/quarterly?.pdf",
      source: "/private/attachment.pdf",
      mime: "application/pdf",
    })).toBe("quarterly_.pdf");
  });

  it("lets image bytes or their canonical source override a spoofed extension", () => {
    expect(canonicalDownloadFilename({
      contentDisposition: `attachment; filename="setup.exe"`,
      source: "/private/opaque",
      mime: "image/png",
    })).toBe("setup.png");
    expect(canonicalDownloadFilename({
      contentDisposition: `attachment; filename="holiday.pdf"`,
      source: "/api/attachments/123.jpeg?download=1",
    })).toBe("holiday.jpeg");
  });
});

describe("external image privacy", () => {
  it("classifies the image source independently from an outer link", () => {
    expect(isExternalImageSource("https://assets.example/image.png")).toBe(true);
    expect(isExternalImageSource("//assets.example/image.png")).toBe(true);
    expect(isExternalImageSource("https:assets.example/image.png")).toBe(true);
    expect(isExternalImageSource("https:/assets.example/image.png")).toBe(true);
    expect(isExternalImageSource("https:\\assets.example\\image.png")).toBe(true);
    expect(isExternalImageSource("HTTP:assets.example/pixel.gif")).toBe(true);
    expect(isExternalImageSource("/\t/assets.example/pixel.gif")).toBe(true);
    expect(isExternalImageSource("/\n/assets.example/pixel.gif")).toBe(true);
    expect(isExternalImageSource("/\r/assets.example/pixel.gif")).toBe(true);
    expect(isExternalImageSource("\\\\assets.example\\pixel.gif")).toBe(true);
    expect(isExternalImageSource("/api/attachments/image.png")).toBe(false);
  });
});

describe("attachment preview surfaces", () => {
  it("keeps a stable loading tile and the original image name", () => {
    const html = renderToStaticMarkup(createElement(AttachedImageGallery, {
      paths: [{
        path: "/store/123e4567-e89b-12d3-a456-426614174000.png",
        name: "Launch artwork.png",
        private: true,
      }],
    }));

    expect(html).toContain("aspect-[4/3]");
    expect(html).toContain("Loading Launch artwork.png");
    expect(html).toContain("Preview attached image Launch artwork.png");
    expect(html).toContain("/api/attachments/123e4567-e89b-12d3-a456-426614174000.png");
    expect(html).toContain("loading=\"lazy\"");
    expect(html).not.toContain("fetchPriority=\"high\"");
  });

  it("can prioritize a newly sent image without making old galleries eager", () => {
    const html = renderToStaticMarkup(createElement(AttachedImageGallery, {
      paths: ["/store/123e4567-e89b-12d3-a456-426614174000.png"],
      eager: true,
    }));

    expect(html).toContain("loading=\"eager\"");
    expect(html).toContain("fetchPriority=\"high\"");
  });

  it("automatically lazy loads standalone remote Markdown images", () => {
    const html = renderToStaticMarkup(createElement(MarkdownImagePreview, {
      src: "https://assets.example/preview.png?signature=abc",
      name: "Result image",
      openUrl: "https://assets.example/preview.png?signature=abc",
    }));

    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain("Load image");
    expect(html).toContain("src=\"https://assets.example/preview.png?signature=abc\"");
    expect(html).toContain("https://assets.example/preview.png?signature=abc");
  });

  it("automatically loads protocol-relative images without an outer link", () => {
    const html = renderToStaticMarkup(createElement(MarkdownImagePreview, {
      src: "//assets.example/preview.png",
      name: "Result image",
    }));

    expect(html).toContain('loading="lazy"');
    expect(html).toContain("src=\"//assets.example/preview.png\"");
  });

  it("uses the stored image extension for downloads, not the display label", () => {
    expect(previewImage(
      "/store/123e4567-e89b-12d3-a456-426614174000.png",
      "quarterly-report.pdf",
    )?.downloadName).toBe("quarterly-report.png");
  });

  it("keeps legacy transcript file chips visible but inert", () => {
    const html = renderToStaticMarkup(createElement(AttachedFileChips, {
      files: [{ path: "/store/123e4567-e89b-42d3-a456-426614174000.pdf", name: "Final report.pdf", private: true }],
    }));

    expect(html).toContain("Final report.pdf");
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("type=\"button\"");
  });

  it("makes message-authorized transcript files explicit save actions", () => {
    const html = renderToStaticMarkup(createElement(AttachedFileChips, {
      files: [{ path: "/store/123e4567-e89b-42d3-a456-426614174000.pdf", name: "Final report.pdf", private: true }],
      message: { threadId: "thread-1", messageId: "message-1" },
    }));
    expect(html).toContain("Save a copy of Final report.pdf");
    expect(html).toContain("type=\"button\"");
  });
});

describe("Show in folder for a file outside the workspace", () => {
  const render = (filePath: string) => renderToStaticMarkup(createElement(OutsideWorkspaceFile, { filePath }));

  it("offers the reveal only for an absolute local path, and only in the local desktop app", () => {
    vi.stubGlobal("window", { ogb: { revealInFolder: vi.fn(), remoteClient: { active: false } } });
    try {
      expect(render("/Users/maus/_draft/ollama-gen.js")).toContain("Show in folder");
      expect(render("C:\\Users\\Maus\\_draft\\ollama-gen.js")).toContain("Show in folder");
      for (const filePath of ["_draft/ollama-gen.js", "\\\\server\\share\\ollama-gen.js"]) {
        expect(render(filePath)).not.toContain("Show in folder");
        expect(render(filePath)).toContain(`>${filePath}</code>`);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gives a remote client the path, since the file is not on its computer", () => {
    vi.stubGlobal("window", { ogb: { revealInFolder: vi.fn(), remoteClient: { active: true } } });
    try {
      expect(render("/Users/maus/_draft/ollama-gen.js")).toContain(">/Users/maus/_draft/ollama-gen.js</code>");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a failed save", () => {
  it("explains a file outside the working folder instead of echoing the server", () => {
    const server = "the linked file is outside this conversation's workspace";
    expect(saveFailureText({ reason: server, outsideWorkspace: true }))
      .toBe("This file is outside this chat's working folder, so it can't be saved from here");
    expect(saveFailureText({ reason: "the linked file is unavailable", outsideWorkspace: false }))
      .toBe("the linked file is unavailable");
  });
});

describe("a file over the download limit", () => {
  it("shows the server's plain explanation and keeps its code, not the raw byte count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "file exceeds 524288000 bytes",
      code: "file_too_large",
      errorKey: "serverError.file.tooLarge",
      errorParams: { size: "612 MB", limit: "500 MB", name: "reel.mp4" },
    }), { status: 413, headers: { "content-type": "application/json" } })));
    try {
      await expect(requestMessageFile("reel.mp4", { threadId: "t", messageId: "m" }, new AbortController().signal))
        .rejects.toMatchObject({
          code: "file_too_large",
          message: "This file is 612 MB, over the 500 MB limit for opening files from chat. The file itself is still saved as reel.mp4.",
        });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a folder linked in a message", () => {
  const folderPath = "/work/Reports";
  const listing = { name: "Reports", entries: [{ name: "q3.pdf", bytes: 2048, mime: "application/pdf" }], truncated: false };
  const authorized = () => new Response(JSON.stringify(listing), { status: 200, headers: { "content-type": "application/json", "x-openmausbot-folder": "1" } });
  const refused = () => new Response(JSON.stringify({ error: "the linked file is outside this conversation's workspace", code: "outside_workspace" }), { status: 403, headers: { "content-type": "application/json" } });

  async function clickLink(answer: () => Response) {
    vi.stubGlobal("fetch", vi.fn(async () => answer()));
    const seen: { current: ReturnType<typeof useLocalFileSave> | null } = { current: null };
    const Probe = () => {
      seen.current = useLocalFileSave(folderPath, undefined, { threadId: "thread-1", messageId: "message-1" });
      return null;
    };
    const root = createRoot(document.createElement("div"));
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { await seen.current!.save(); });
    const result = { state: seen.current!.state, folder: seen.current!.folder };
    await act(async () => { root.unmount(); });
    return result;
  }

  it("opens in the file manager once the route authorized it, with no listing", async () => {
    const openFolder = vi.fn(async () => "opened");
    vi.stubGlobal("ogb", { openFolder, remoteClient: { active: false } });
    try {
      expect(await clickLink(authorized)).toEqual({ state: "idle", folder: null });
      expect(openFolder).toHaveBeenCalledWith(folderPath);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows the listing when the desktop would not open it", async () => {
    const openFolder = vi.fn(async () => "not-folder");
    vi.stubGlobal("ogb", { openFolder, remoteClient: { active: false } });
    try {
      expect(await clickLink(authorized)).toEqual({ state: "idle", folder: listing });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows the listing where there is no desktop bridge", async () => {
    vi.stubGlobal("ogb", undefined);
    try {
      expect(await clickLink(authorized)).toEqual({ state: "idle", folder: listing });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never reaches the desktop when the route refuses the link", async () => {
    const openFolder = vi.fn(async () => "opened");
    vi.stubGlobal("ogb", { openFolder, remoteClient: { active: false } });
    try {
      expect(await clickLink(refused)).toEqual({ state: "failed", folder: null });
      expect(openFolder).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("local Markdown image lifecycle", () => {
  it("builds a path-free, directly streamable message preview URL", () => {
    expect(messageImagePreviewUrl(
      { threadId: "thread-one", messageId: "message-two" },
      42,
    )).toBe(
      "/api/threads/thread-one/messages/message-two/file?preview=1&ref=42",
    );
  });
});

it("sizes AI thumbnails by their source orientation and crops uploaded photos to squares", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    for (const [width, height, layout, aspect, fit] of [
      [400, 800, "oriented", "aspect-[3/4]", "object-contain"],
      [800, 400, "oriented", "aspect-[4/3]", "object-contain"],
      [400, 800, "square", "aspect-square", "object-cover"],
    ] as const) {
      const image = { src: `/api/${width}-${layout}.png`, name: "photo.png" };
      await act(() => root.render(createElement(AttachmentThumbnail, { key: image.src, image, layout, onPreview: () => {} })));
      const img = container.querySelector("img")!;
      Object.defineProperties(img, { naturalWidth: { value: width }, naturalHeight: { value: height } });
      await act(() => img.dispatchEvent(new Event("load")));
      expect(container.firstElementChild?.classList.contains(aspect)).toBe(true);
      expect(img.classList.contains(fit)).toBe(true);
    }
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

describe("full-screen image actions", () => {
  const image = { src: "/api/files/shot.png", name: "shot.png", downloadUrl: "/api/files/shot.png" };

  async function openPreview(images = [image]) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onClose = vi.fn();
    await act(async () => { root.render(createElement(AttachmentPreviewDialog, { image, images, onClose })); });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.className).toContain("fixed inset-0");
    const button = () => document.querySelector<HTMLButtonElement>('button[title="Copy image"], button[title="Image copied"]');
    const openMenu = () => act(() => {
      dialog.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    return { button, dialog, onClose, openMenu, close: async () => { await act(() => root.unmount()); container.remove(); } };
  }

  it.each(["touch", "mouse"])("tracks a %s drag, rebounds on short drags and advances on longer ones", async pointerType => {
    const next = { ...image, src: "/next.png", name: "next.png" };
    const { dialog, onClose, close } = await openPreview([image, next]);
    const track = dialog.querySelector<HTMLElement>("[style*=translateX]")!;
    Object.assign(dialog, { setPointerCapture: vi.fn() });
    const pointer = (type: string, x: number) => act(() => {
      dialog.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId: 1, pointerType, isPrimary: true, clientX: x, clientY: 10,
      }));
    });
    try {
      await pointer("pointerdown", 120);
      await pointer("pointermove", 94);
      expect(track.style.transform).toContain("-26px");
      await pointer("pointerup", 94);
      expect(track.style.transform).toContain("0% + 0px");
      await act(() => dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
      expect(onClose).not.toHaveBeenCalled();
      await pointer("pointerdown", 120);
      await pointer("pointermove", 40);
      expect(track.style.transform).toContain("-80px");
      await pointer("pointercancel", 40);
      expect(track.style.transform).toContain("0% + 0px");
      await pointer("pointerdown", 120);
      await pointer("pointermove", 40);
      await pointer("pointerup", 40);
      expect(track.style.transform).toContain("-100% + 0px");
      await pointer("pointerdown", 40);
      await pointer("pointermove", 120);
      expect(track.style.transform).toContain("-100% + 80px");
      await pointer("pointerup", 120);
      expect(track.style.transform).toContain("0% + 0px");
    } finally {
      await close();
    }
  });

  it("has no navigation icons, toggles zoom on double click and dismisses on a single image click", async () => {
    vi.useFakeTimers();
    const { dialog, onClose, close } = await openPreview([image, { ...image, src: "/next.png" }]);
    const active = dialog.querySelector<HTMLImageElement>("[data-preview-active-image]")!;
    const click = () => act(() => active.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    try {
      expect(dialog.querySelector("button")).toBeNull();
      await click();
      await click();
      expect(active.style.transform).toContain("scale(2.5)");
      expect(active.classList.contains("preview-zoom-transition")).toBe(true);
      expect(dialog.getAttribute("data-overlay-fade")).toBe("in");
      await click();
      await click();
      expect(active.style.transform).toContain("scale(1)");
      await click();
      await act(() => { vi.advanceTimersByTime(300); });
      expect(dialog.getAttribute("data-overlay-fade")).toBe("out");
      await act(() => { vi.advanceTimersByTime(MENU_MOTION_MS); });
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await close();
      vi.useRealTimers();
    }
  });

  it("zooms in and out with two touches and follows a downward dismissal drag", async () => {
    vi.useFakeTimers();
    const { dialog, onClose, close } = await openPreview();
    const active = dialog.querySelector<HTMLImageElement>("[data-preview-active-image]")!;
    const track = dialog.querySelector<HTMLElement>("[style*=translateX]")!;
    Object.assign(dialog, { setPointerCapture: vi.fn() });
    const pointer = (type: string, id: number, x: number, y: number) => act(() => {
      dialog.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId: id, pointerType: "touch", isPrimary: id === 1, clientX: x, clientY: y,
      }));
    });
    try {
      await pointer("pointerdown", 1, 100, 100);
      await pointer("pointerdown", 2, 150, 100);
      await pointer("pointermove", 2, 200, 100);
      expect(active.style.transform).toContain("scale(2)");
      expect(active.classList.contains("preview-zoom-transition")).toBe(false);
      await pointer("pointermove", 2, 150, 100);
      expect(active.style.transform).toContain("scale(1)");
      await pointer("pointerup", 2, 150, 100);
      await pointer("pointerup", 1, 100, 100);
      await pointer("pointerdown", 1, 100, 100);
      await pointer("pointermove", 1, 100, 225);
      expect(track.style.transform).toContain("translateY(125px)");
      await pointer("pointerup", 1, 100, 225);
      expect(dialog.getAttribute("data-overlay-fade")).toBe("out");
      await act(() => { vi.runAllTimers(); });
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await close();
      vi.useRealTimers();
    }
  });

  it("copies the shown image as a PNG and says so", async () => {
    const write = vi.fn(async (items: { items: Record<string, Promise<Blob>> }[]) => {
      await items[0]!.items["image/png"];
    });
    vi.stubGlobal("ClipboardItem", class { constructor(readonly items: Record<string, Promise<Blob>>) {} });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["png"], { type: "image/png" }))));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    const preview = await openPreview();
    try {
      expect(preview.button()).toBeNull();
      await preview.openMenu();
      expect(preview.button()?.getAttribute("aria-label")).toBe("Copy shot.png as an image");
      await act(async () => { preview.button()!.click(); });
      expect(write).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith("/api/files/shot.png");
      expect(preview.button()?.title).toBe("Image copied");
    } finally {
      await preview.close();
      vi.unstubAllGlobals();
    }
  });

  it("fades the actions and preview independently before removing them", async () => {
    vi.useFakeTimers();
    const preview = await openPreview();
    try {
      expect(preview.dialog.getAttribute("data-overlay-fade")).toBe("in");
      await preview.openMenu();
      await act(() => preview.dialog.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
      await act(() => (preview.dialog as HTMLElement).click());
      expect(preview.button()?.closest("[data-overlay-fade]")?.getAttribute("data-overlay-fade")).toBe("out");
      expect(preview.button()?.closest("[inert]")).toBeTruthy();
      expect(preview.onClose).not.toHaveBeenCalled();
      await act(() => { vi.advanceTimersByTime(MENU_MOTION_MS); });
      expect(preview.button()).toBeNull();
      await act(() => (preview.dialog as HTMLElement).click());
      expect(preview.dialog.getAttribute("data-overlay-fade")).toBe("out");
      expect(preview.dialog.hasAttribute("inert")).toBe(true);
      expect(preview.onClose).not.toHaveBeenCalled();
      await act(() => { vi.advanceTimersByTime(MENU_MOTION_MS); });
      expect(preview.dialog.isConnected).toBe(false);
      expect(preview.onClose).toHaveBeenCalledOnce();
    } finally {
      await preview.close();
      vi.useRealTimers();
    }
  });

  it("can download when image copying is unavailable", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    const preview = await openPreview();
    try {
      await preview.openMenu();
      expect(preview.button()?.disabled).toBe(true);
      expect(document.querySelector('a[download="shot.png"]')?.getAttribute("href")).toBe(image.downloadUrl);
    } finally {
      await preview.close();
      vi.unstubAllGlobals();
    }
  });
});

it.each([false, true])("closes a native file preview and respects reduced motion (%s)", async (reducedMotion) => {
  vi.useFakeTimers();
  const host = document.body.appendChild(document.createElement("div"));
  const trigger = host.appendChild(document.createElement("button"));
  const root = createRoot(host.appendChild(document.createElement("div")));
  const onClose = vi.fn();
  const previous = document.documentElement.dataset.reducedMotion;
  document.documentElement.dataset.reducedMotion = String(reducedMotion);
  try {
    trigger.focus();
    await act(() => root.render(createElement(FilePreviewDialog, {
      title: "Report.html", onClose, returnFocus: trigger, children: "Report",
    })));
    const dialog = document.querySelector("dialog.fading-dialog")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    await act(() => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(dialog.isConnected).toBe(!reducedMotion);
    if (!reducedMotion) {
      expect(onClose).not.toHaveBeenCalled();
      await act(() => { vi.advanceTimersByTime(MENU_MOTION_MS); });
    }
    expect(dialog.isConnected).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
    host.remove();
    if (previous === undefined) delete document.documentElement.dataset.reducedMotion;
    else document.documentElement.dataset.reducedMotion = previous;
    vi.useRealTimers();
  }
});
