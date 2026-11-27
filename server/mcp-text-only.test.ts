import { describe, expect, it } from "vitest";

import { forgetTextOnlyTools, learnTextOnlyTools, learnedTextOnlyTools, textOnlyToolsFromEnv, withoutResultImages } from "./mcp-text-only.ts";

describe("withoutResultImages", () => {
  it("replaces every image content part with a text note, keeping the rest as it was", () => {
    const result = { content: [{ type: "text", text: "here:" }, { type: "image", data: "QUJD", mimeType: "image/png" }, { type: "image", data: "REVG", mimeType: "image/jpeg" }] };
    expect(withoutResultImages(result)).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "here:" });
    expect(result.content[1]).toEqual({ type: "text", text: expect.stringContaining("[Image from this tool's result not shown: this model reads text only (image/png, ~1 kB).]") });
    expect(result.content[2]).toEqual({ type: "text", text: expect.stringContaining("(image/jpeg") });
  });

  it("leaves results without image parts, and unreadable ones, exactly as they came", () => {
    const text = { content: [{ type: "text", text: "done" }] };
    expect(withoutResultImages(text)).toBe(false);
    expect(text).toEqual({ content: [{ type: "text", text: "done" }] });
    const bare = { content: "done" };
    expect(withoutResultImages(bare)).toBe(false);
    expect(withoutResultImages({})).toBe(false);
    expect(withoutResultImages(null)).toBe(false);
    expect(withoutResultImages(undefined)).toBe(false);
  });
});

describe("the learned text-only models", () => {
  it("remembers a key until forgotten", () => {
    expect(learnedTextOnlyTools('["i","m"]')).toBe(false);
    learnTextOnlyTools('["i","m"]');
    expect(learnedTextOnlyTools('["i","m"]')).toBe(true);
    expect(learnedTextOnlyTools('["i","other"]')).toBe(false);
    forgetTextOnlyTools();
    expect(learnedTextOnlyTools('["i","m"]')).toBe(false);
  });
});

describe("textOnlyToolsFromEnv", () => {
  it("reads only the exact flag the turn set", () => {
    expect(textOnlyToolsFromEnv({})).toBe(false);
    expect(textOnlyToolsFromEnv({ OMB_MCP_TEXT_ONLY: "0" })).toBe(false);
    expect(textOnlyToolsFromEnv({ OMB_MCP_TEXT_ONLY: "1" })).toBe(true);
  });
});
