import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import type { Attachment } from "@/state/store";
import { buildProjectFilePreviewUrl, type PreviewFileSource, type PreviewSource } from "./mobilePreviewUrl";

export const PAGE_SHARE_NOTICE = "Page screenshots work in the Gerer Build Studio desktop app. You can still share the preview link and your note to chat.";

export function sharesLinkOnly(source: PreviewSource | null, desktop: boolean): boolean {
  return !desktop && Boolean(source && (source.kind === "url" || source.fileType === "html" || source.fileType === "pdf"));
}

export function previewShareLink(source: PreviewSource, origin: string): string {
  return source.kind === "url" ? source.url : new URL(buildProjectFilePreviewUrl(source.projectId, source.filePath), origin).href;
}

/** Rasterize already rendered, sanitized Markdown rather than painting its source.
 * Bound output area and strip remote images so capture never taints the canvas.
 */
export async function captureMarkdown(container: HTMLElement, width: number, height: number, full: boolean): Promise<string> {
  const clone = container.cloneNode(true) as HTMLElement;
  // ChatMarkdown uses styled DIV headings. Copy typography/layout while the
  // nodes are still attached; class names alone cannot style a standalone SVG.
  const properties = ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "text-align", "text-decoration", "white-space", "display", "vertical-align", "border-collapse", "table-layout", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-top-style", "border-right-style", "border-bottom-style", "border-left-style"];
  const originals = [container, ...container.querySelectorAll<HTMLElement>("*")];
  const copies = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
  originals.forEach((node, index) => {
    const computed = getComputedStyle(node);
    properties.forEach(property => copies[index].style.setProperty(property, computed.getPropertyValue(property)));
  });
  clone.querySelectorAll("button").forEach((node) => node.remove());
  clone.querySelectorAll("img").forEach((node) => {
    const alt = document.createElement("span");
    alt.textContent = `[Image: ${node.alt || "image"}]`;
    node.replaceWith(alt);
  });
  clone.style.cssText = `box-sizing:border-box;width:${width}px;padding:24px;background:#fff;color:#202124;overflow:hidden;`;
  const rootTypography = getComputedStyle(container);
  for (const property of ["font-family", "font-size", "font-weight", "line-height"]) clone.style.setProperty(property, rootTypography.getPropertyValue(property));
  const style = document.createElement("style");
  style.textContent = "h1{font-size:2em}h2{font-size:1.5em}h3{font-size:1.2em}p,pre,table,blockquote,ul,ol{margin:12px 0}pre{white-space:pre-wrap;background:#f3f4f6;padding:12px}code{font-family:monospace}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px}a{color:#2563eb}blockquote{border-left:3px solid #aaa;padding-left:12px}li{margin:4px 0}";
  clone.prepend(style);
  const captureHeight = full ? Math.min(8000, Math.max(height, container.scrollHeight)) : height;
  const ratio = Math.min(1, 1600 / width, Math.sqrt(8_000_000 / (width * captureHeight)));
  const outW = Math.max(1, Math.round(width * ratio));
  const outH = Math.max(1, Math.round(captureHeight * ratio));
  const html = new XMLSerializer().serializeToString(clone);
  const scrollOffset = full ? 0 : container.scrollTop;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${width} ${captureHeight}"><foreignObject y="${-scrollOffset}" width="100%" height="${Math.max(captureHeight + scrollOffset, container.scrollHeight)}">${html}</foreignObject></svg>`;
  const image = new Image();
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Document capture took too long. Try sharing its project path instead.")), 10_000);
    function finish(error?: Error) {
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      if (error) reject(error);
      else resolve();
    }
    image.onload = () => finish();
    image.onerror = () => finish(new Error("Couldn't capture the formatted document. Try sharing its project path instead."));
    image.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Screenshot capture is unavailable in this browser.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, outW, outH);
  context.drawImage(image, 0, 0);
  return canvas.toDataURL("image/png");
}

export interface PreviewCaptureSize { title: string; width: number; height: number }

/** Collect first, send later: a failed size rejects the entire batch. */
export async function captureAllPreviewSizes<T>(sizes: PreviewCaptureSize[], capture: (size: PreviewCaptureSize) => Promise<T>): Promise<T[]> {
  if (!sizes.length) throw new Error("Choose at least one preview size to share.");
  const captures: T[] = [];
  for (const size of sizes) {
    try { captures.push(await capture(size)); }
    catch (error) { throw new Error(`Couldn't capture ${size.title} (${size.width} × ${size.height}). ${error instanceof Error ? error.message : "Reload the file and try again."}`); }
  }
  return captures;
}

function imageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => finish(new Error("The project image took too long to load. Reload it and try again.")), 10_000);
    function finish(error?: Error) {
      clearTimeout(timer); image.onload = null; image.onerror = null;
      if (error) reject(error); else resolve(image);
    }
    image.onload = () => finish();
    image.onerror = () => finish(new Error("Couldn't load the project image. Reload it and try again."));
    image.src = url;
  });
}

/** Source captures never mount iframe/webview elements or promote canvas cards.
 * Load once, render sequentially, and release each detached Markdown root.
 */
export async function captureProjectFileSizes(source: PreviewFileSource, sizes: PreviewCaptureSize[], full: boolean): Promise<Attachment[]> {
  if (source.fileType !== "markdown" && source.fileType !== "image") throw new Error("This file needs a live preview to capture it.");
  const url = buildProjectFilePreviewUrl(source.projectId, source.filePath, Date.now());
  let markdown = "";
  let image: HTMLImageElement | undefined;
  if (source.fileType === "markdown") {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Couldn't read the Markdown file (${response.status}). Reload it and try again.`);
    markdown = await response.text();
  } else image = await imageFromUrl(url);

  return captureAllPreviewSizes(sizes, async size => {
    let dataUrl: string;
    if (source.fileType === "markdown") {
      const stage = document.createElement("div");
      stage.dataset.previewCapture = "markdown";
      stage.setAttribute("aria-hidden", "true");
      stage.style.cssText = `position:fixed;left:-100000px;top:0;width:${size.width}px;height:${size.height}px;box-sizing:border-box;overflow:auto;padding:24px;font:16px/1.6 system-ui;pointer-events:none;`;
      document.body.append(stage);
      const root = createRoot(stage);
      try {
        flushSync(() => root.render(createElement(ChatMarkdown, { text: markdown, streaming: true })));
        dataUrl = await captureMarkdown(stage, size.width, size.height, full);
      } finally { root.unmount(); stage.remove(); }
    } else {
      const canvas = document.createElement("canvas");
      const ratio = Math.min(1, 1600 / size.width, 1200 / size.height);
      canvas.width = Math.max(1, Math.round(size.width * ratio));
      canvas.height = Math.max(1, Math.round(size.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image capture is unavailable in this browser.");
      context.scale(ratio, ratio);
      context.fillStyle = "#191919"; context.fillRect(0, 0, size.width, size.height);
      const fit = Math.min(1, Math.max(1, size.width - 32) / image!.naturalWidth, Math.max(1, size.height - 32) / image!.naturalHeight);
      const width = image!.naturalWidth * fit, height = image!.naturalHeight * fit;
      context.drawImage(image!, (size.width - width) / 2, (size.height - height) / 2, width, height);
      dataUrl = canvas.toDataURL("image/png");
    }
    const slug = size.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "preview";
    return { id: crypto.randomUUID(), name: `preview-${slug}-${size.width}x${size.height}-${Date.now()}.png`, mimeType: "image/png", size: Math.ceil((dataUrl.split(",")[1].length * 3) / 4), dataUrl };
  });
}
