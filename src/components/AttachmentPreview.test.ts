import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AttachedFileChips,
  AttachedImageGallery,
  MarkdownImagePreview,
  canonicalDownloadFilename,
  contentDispositionFilename,
  imageGalleryLayout,
  isExternalImageSource,
  messageImagePreviewUrl,
  previewImage,
  previewKeyAction,
  safeDownloadFilename,
  wrappedImageIndex,
} from "./AttachmentPreview";

describe("attachment image navigation", () => {
  it("wraps previous and next navigation", () => {
    expect(wrappedImageIndex(0, -1, 3)).toBe(2);
    expect(wrappedImageIndex(2, 1, 3)).toBe(0);
    expect(wrappedImageIndex(0, 1, 0)).toBe(0);
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

  it("keeps remote Markdown images private until explicitly loaded", () => {
    const html = renderToStaticMarkup(createElement(MarkdownImagePreview, {
      src: "https://assets.example/preview.png?signature=abc",
      name: "Result image",
      openUrl: "https://assets.example/preview.png?signature=abc",
    }));

    expect(html).toContain("External image hidden for privacy");
    expect(html).toContain("Load image");
    expect(html).not.toContain("src=\"https://assets.example/preview.png?signature=abc\"");
    expect(html).toContain("https://assets.example/preview.png?signature=abc");
  });

  it("does not need an outer link to hide a remote Markdown image", () => {
    const html = renderToStaticMarkup(createElement(MarkdownImagePreview, {
      src: "//assets.example/preview.png",
      name: "Result image",
    }));

    expect(html).toContain("External image hidden for privacy");
    expect(html).not.toContain("src=\"//assets.example/preview.png\"");
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
