import { describe, expect, it } from "vitest";
import { previewShareLink, sharesLinkOnly } from "./previewSharing";
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
