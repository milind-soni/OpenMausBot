import { describe, expect, it } from "vitest";
import { highlightCode, resolveLanguage } from "./highlighter";

describe("highlighter", () => {
  it("resolves common fence labels and rejects unsupported ones", () => {
    expect(resolveLanguage("ts")).toBe("typescript");
    expect(resolveLanguage("Bash")).toBe("shellscript");
    expect(resolveLanguage("yml")).toBe("yaml");
    expect(resolveLanguage("")).toBeNull();
    expect(resolveLanguage("cobol")).toBeNull();
  });

  it("highlights a supported language and escapes the source", async () => {
    const html = await highlightCode('const tag = "<script>";', "ts");
    expect(html).toContain("shiki");
    expect(html).toContain("&#x3C;script>");
    expect(html).not.toContain("<script>");
  });

  it("returns null for unsupported languages so the plain block stays", async () => {
    expect(await highlightCode("IDENTIFICATION DIVISION.", "cobol")).toBeNull();
  });
});
