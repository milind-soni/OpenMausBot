import { describe, expect, it } from "vitest";
import { extractMcpImages } from "./mcp-tool-images.ts";

describe("extractMcpImages", () => {
  it("pulls image blocks out of a raw content array, ignoring text", () => {
    const content = [
      { type: "text", text: "ok" },
      { type: "image", data: "abc123", mimeType: "image/png" },
    ];
    expect(extractMcpImages(content)).toEqual([{ type: "image", data: "abc123", mimeType: "image/png" }]);
  });

  it("pulls image blocks out of a { content: [...] } wrapper", () => {
    const result = { content: [{ type: "image", data: "xyz", mimeType: "image/jpeg" }], isError: false };
    expect(extractMcpImages(result)).toEqual([{ type: "image", data: "xyz", mimeType: "image/jpeg" }]);
  });

  it("returns [] for text-only, missing, or malformed input", () => {
    expect(extractMcpImages([{ type: "text", text: "ok" }])).toEqual([]);
    expect(extractMcpImages(undefined)).toEqual([]);
    expect(extractMcpImages({ content: [{ type: "image", data: 5, mimeType: "image/png" }] })).toEqual([]);
  });

  it("normalizes Anthropic API image blocks (Claude CLI's tool_result shape)", () => {
    const content = [
      { type: "text", text: "ok" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "def456" } },
    ];
    expect(extractMcpImages(content)).toEqual([{ data: "def456", mimeType: "image/jpeg" }]);
  });
});
