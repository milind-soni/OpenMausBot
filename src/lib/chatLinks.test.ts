import { describe, expect, it } from "vitest";
import { classifyChatHref, looksLikeFilePath } from "./chatLinks";

describe("chat links", () => {
  it("classifies web pages, local files and other links", () => {
    expect(classifyChatHref("https://example.com/a")).toEqual({ kind: "web", url: "https://example.com/a" });
    expect(classifyChatHref("/Users/me/p/docs/plan.md")).toEqual({ kind: "file", path: "/Users/me/p/docs/plan.md" });
    expect(classifyChatHref("~/p/a.png")?.kind).toBe("file");
    expect(classifyChatHref("file:///Users/me/p/a.pdf")?.kind).toBe("file");
    expect(classifyChatHref("docs/plan.md")?.kind).toBe("file");
    expect(classifyChatHref("docs/plan")?.kind).toBe("other");
    expect(classifyChatHref("mailto:a@b.c")?.kind).toBe("other");
    expect(classifyChatHref("javascript:alert(1)")?.kind).toBe("other");
    expect(classifyChatHref("#section")).toBeNull();
  });
  it("only treats single absolute paths to previewable files as file paths", () => {
    expect(looksLikeFilePath("/Users/me/p/docs/plan.md")).toBe(true);
    expect(looksLikeFilePath("~/p/shot.png")).toBe(true);
    expect(looksLikeFilePath("src/index.ts")).toBe(false);
    expect(looksLikeFilePath("/usr/bin/node")).toBe(false);
    expect(looksLikeFilePath("/a b.md")).toBe(false);
  });
});
