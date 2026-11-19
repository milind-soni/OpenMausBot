import { describe, expect, it } from "vitest";
import { documentImageSource, markdownUrlTransform } from "./markdownImages";

const location = { projectId: "test", filePath: "docs/guide/readme.md" };

describe("Markdown image URLs", () => {
  it("resolves the image against the document directory and preserves encoded names", () => {
    const url = documentImageSource("../screenshots/Test%20image.png", location)!;
    expect(url).toContain("test/docs/screenshots/Test%20image.png");
    expect(documentImageSource("/assets/logo.svg", location)).toContain("test/assets/logo.svg");
  });

  it("leaves remote URLs usable and rejects paths that escape the project", () => {
    expect(documentImageSource("https://example.test/logo.png", location)).toBe("https://example.test/logo.png");
    expect(documentImageSource("../../../outside.png", location)).toBeNull();
    expect(documentImageSource("%2Fprivate.png", location)).toBeNull();
    expect(documentImageSource("file:///tmp/test.png", location)).toBeNull();
    expect(markdownUrlTransform("javascript:alert(1)", "src")).toBe("");
  });
});
