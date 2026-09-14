import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_MAX_BYTES } from "@/lib/composer-attachments";
import { AttachmentGallery, collectMessageFiles, isVideoAttachment, loadMessageVideo } from "./AttachmentGallery";

const message = { threadId: "thread/one", messageId: "message two" };
const file = { path: "/workspace/demo.mp4", name: "demo.mp4", linked: true };
const image = { path: "/store/123e4567-e89b-42d3-a456-426614174000.png", name: "Overview.png", private: true };
afterEach(() => vi.unstubAllGlobals());

describe("message gallery", () => {
  it("collects only rendered local file links, including references, with generated files deduplicated", () => {
    const text = [
      "I wrote [report](./report.pdf) and [again](./report.pdf).",
      "[video][clip]",
      "",
      "[clip]: ./demo.mp4",
      "",
      "![image](./image.png)",
      "[![linked image](./image.png)](./full.png)",
      "[generated](file:///store/123e4567-e89b-42d3-a456-426614174000.png)",
      "[web](https://example.com/file.pdf) [network](//example.com/file.pdf) [anchor](#section)",
      "`[code](./secret.txt)`",
      "```md\n[example](./secret.txt)\n```",
      "Plain prose /workspace/private.txt",
    ].join("\n");
    expect(collectMessageFiles(text, [image.path])).toEqual([
      { path: "./report.pdf", name: "report.pdf", linked: true },
      { path: "./demo.mp4", name: "demo.mp4", linked: true },
    ]);
  });

  it("handles Windows and encoded paths while keeping a safe filename", () => {
    expect(collectMessageFiles("[release](file:///C:/work/release%20notes.pdf) [video](./demo.MP4#section)"))
      .toEqual([
        { path: "file:///C:/work/release%20notes.pdf", name: "release notes.pdf", linked: true },
        { path: "./demo.MP4#section", name: "demo.MP4", linked: true },
      ]);
    expect(isVideoAttachment("./demo.MP4#section")).toBe(true);
    expect(isVideoAttachment("./movie.mp4.html")).toBe(false);
  });

  it("does not decode file URLs twice or mistake filename characters for URL suffixes", () => {
    expect(collectMessageFiles("[video](file:///work/demo%23one.mp4) [percent](file:///work/r%2520.pdf) [space](file:///work/r%20.pdf)"))
      .toEqual([
        { path: "file:///work/demo%23one.mp4", name: "demo#one.mp4", linked: true },
        { path: "file:///work/r%2520.pdf", name: "r%20.pdf", linked: true },
        { path: "file:///work/r%20.pdf", name: "r .pdf", linked: true },
      ]);
    expect(isVideoAttachment("file:///work/demo%23one.mp4")).toBe(true);
  });

  it("shows one compact collection, keeps file actions explicit, and never eagerly loads videos", () => {
    const markup = renderToStaticMarkup(createElement(AttachmentGallery, {
      images: [image], files: [file, { path: "/workspace/report.pdf", name: "report.pdf", linked: true }], message,
    }));
    expect(markup).toContain("3 attachments");
    expect(markup).toContain("Overview.png");
    expect(markup).toContain("Load video");
    expect(markup).toContain("Save a copy of demo.mp4");
    expect(markup).toContain("Save a copy of report.pdf");
    expect(markup).toContain("loading=\"lazy\"");
    expect(markup).not.toContain("<video");
    expect(markup).not.toContain("src=\"/workspace/");
  });

  it("collapses large collections and deduplicates paths", () => {
    const markup = renderToStaticMarkup(createElement(AttachmentGallery, {
      images: [image, image],
      files: Array.from({ length: 5 }, (_, index) => ({ path: `./file${index}.pdf`, name: `file${index}.pdf`, linked: true })),
      message,
    }));
    expect(markup).toContain("6 attachments");
    expect(markup).toContain("Show 2 more");
    expect(markup).toContain("aria-expanded=\"false\"");
    expect(markup).not.toContain("file3.pdf");
    expect(markup).not.toContain("file4.pdf");
  });

  it("keeps legacy attachments visible but inert and does not expose a video preview without message context", () => {
    const markup = renderToStaticMarkup(createElement(AttachmentGallery, { images: [{ path: "/old/image.png", name: "Old.png" }], files: [file] }));
    expect(markup).toContain("Old.png");
    expect(markup).toContain("demo.mp4");
    expect(markup).toContain("Unavailable");
    expect(markup).not.toContain("Load video");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<img");
  });
});

describe("explicit local video preview", () => {
  it("posts to the same-origin message route and uses only the authorized response bytes", async () => {
    const fetcher = vi.fn(async () => new Response("video bytes", { headers: { "content-type": "video/mp4" } }));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    const blob = await loadMessageVideo(file, message, signal);
    expect(fetcher).toHaveBeenCalledWith("/api/threads/thread%2Fone/messages/message%20two/file", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: file.path }), signal,
    });
    expect(blob.type).toBe("video/mp4");
    expect(await blob.text()).toBe("video bytes");
  });

  it("preserves server authorization failures instead of falling back to arbitrary file URLs", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: "outside this conversation" }), { status: 403 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(loadMessageVideo(file, message, new AbortController().signal)).rejects.toThrow("outside this conversation");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses executable MIME types and old servers' unspecified bytes", async () => {
    for (const mime of ["text/html", "application/octet-stream", "image/svg+xml"]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("not video", { headers: { "content-type": mime } })));
      await expect(loadMessageVideo(file, message, new AbortController().signal)).rejects.toThrow("cannot be played");
    }
  });

  it("enforces the video size limit with and without Content-Length", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("video", {
      headers: { "content-type": "video/mp4", "content-length": String(FILE_MAX_BYTES + 1) },
    })));
    await expect(loadMessageVideo(file, message, new AbortController().signal)).rejects.toThrow("25 MB");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(FILE_MAX_BYTES + 1), { headers: { "content-type": "video/mp4" } })));
    await expect(loadMessageVideo(file, message, new AbortController().signal)).rejects.toThrow("25 MB");
  });

  it("cancels a partially read video when the preview is closed", async () => {
    const request = new AbortController();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        request.abort();
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { headers: { "content-type": "video/mp4" } })));
    await expect(loadMessageVideo(file, message, request.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
