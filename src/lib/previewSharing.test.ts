import { describe, expect, it } from "vitest";
import { captureAllPreviewSizes, previewShareLink, sharesLinkOnly } from "./previewSharing";
import type { PreviewSource } from "./mobilePreviewUrl";

describe("honest preview sharing", () => {
  const file = (fileType: "html" | "pdf" | "markdown" | "image"): PreviewSource => ({ kind: "file", projectId: "project", filePath: `folder/file.${fileType}`, fileType });
  it("shares browser pages and PDFs as links; images and formatted Markdown can be captured", () => {
    const url: PreviewSource = { kind: "url", url: "https://example.com", raw: "example.com", isLocalOrPrivate: false };
    expect(sharesLinkOnly(url, false)).toBe(true);
    for (const type of ["html", "pdf"] as const) expect(sharesLinkOnly(file(type), false)).toBe(true);
    for (const type of ["image", "markdown"] as const) expect(sharesLinkOnly(file(type), false)).toBe(false);
    expect(sharesLinkOnly(url, true)).toBe(false);
    expect(sharesLinkOnly(null, false)).toBe(false);
    expect(previewShareLink(url, "http://localhost:5000")).toBe(url.url);
    expect(previewShareLink(file("html"), "http://localhost:5000")).toBe("http://localhost:5000/api/preview/file/project/folder/file.html");
  });
});

describe("complete preview capture batches", () => {
  const sizes = Array.from({ length: 8 }, (_, i) => ({ title: `Size ${i + 1}`, width: 300 + i * 100, height: 600 }));
  it("collects all eight in order with only one active source capture", async () => {
    let active = 0, maximum = 0;
    const result = await captureAllPreviewSizes(sizes, async size => {
      active++; maximum = Math.max(maximum, active);
      await Promise.resolve(); active--; return `${size.title}-${size.width}`;
    });
    expect(result).toEqual(sizes.map(size => `${size.title}-${size.width}`));
    expect(maximum).toBe(1);
  });
  it("rejects the entire batch and names the failed size instead of returning partial captures", async () => {
    const attempted: string[] = [];
    await expect(captureAllPreviewSizes(sizes, async size => {
      attempted.push(size.title);
      if (size.title === "Size 7") throw new Error("Image decode failed.");
      return size.title;
    })).rejects.toThrow("Couldn't capture Size 7 (900 × 600). Image decode failed.");
    expect(attempted).toHaveLength(7);
  });
  it("refuses an empty selection", async () => {
    await expect(captureAllPreviewSizes([], async () => "unused")).rejects.toThrow("Choose at least one preview size");
  });
});
