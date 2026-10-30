// The native tee goes into bug reports, so this checks that the writer actually redacts.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
import { appendNative } from "./native.ts";

beforeAll(() => ensureDirs());

describe("appendNative", () => {
  it("masks the tokens an ACP session/new hands the agent", () => {
    appendNative("t-native", {
      dir: "out",
      source: "acp",
      msg: {
        method: "session/new",
        params: {
          mcpServers: [
            {
              name: "computer",
              env: [
                { name: "OGB_BOX_ID", value: "boat-7" },
                { name: "OGB_BOX_TOKEN", value: "box_live_dontlogme" },
              ],
            },
          ],
        },
      },
    });

    const log = readFileSync(join(NATIVE_DIR, "t-native.ndjson"), "utf8");
    expect(log).not.toContain("box_live_dontlogme");
    expect(log).toContain("session/new");
    expect(log).toContain("OGB_BOX_TOKEN");
    expect(log).toContain("boat-7");
  });

  it("keeps the length of inline screenshots and files, never their bytes", () => {
    const png = "iVBORw0KGgo".padEnd(150_000, "A");
    const pdf = "JVBERi0xLjQ".padEnd(5_000, "B");
    const acp = "R0lGODlh".padEnd(3_000, "C");
    const url = `data:image/jpeg;base64,${"/9j/4AAQ".padEnd(4_000, "D")}`;
    appendNative("t-inline", {
      dir: "in",
      source: "claude.sdk.message",
      msg: {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "shot-1", content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } },
        ] }] },
        update: { content: { type: "image", mimeType: "image/gif", data: acp } },
        image_url: { url },
        small: { type: "image", source: { type: "base64", media_type: "image/png", data: "[image data: 12 base64 chars]" } },
      },
    });
    const line = JSON.parse(readFileSync(join(NATIVE_DIR, "t-inline.ndjson"), "utf8").trim());
    const blocks = line.msg.message.content[0].content;
    expect(blocks[0].source).toEqual({ type: "base64", media_type: "image/png", data: "[image data: 150000 base64 chars]" });
    expect(blocks[1].source.data).toBe("[base64 data: 5000 base64 chars]");
    expect(line.msg.update.content).toEqual({ type: "image", mimeType: "image/gif", data: "[image data: 3000 base64 chars]" });
    expect(line.msg.image_url.url).toBe(`[data URL: ${url.length} chars]`);
    expect(line.msg.small.source.data).toBe("[image data: 12 base64 chars]");
    expect(line.msg.message.content[0].tool_use_id).toBe("shot-1");
  });

  it("still masks secrets in long text that is not an inline payload", () => {
    const key = `sk-ant-${"k".repeat(40)}`;
    appendNative("t-long", {
      dir: "in",
      source: "acp",
      msg: { data: `${"log line ".repeat(500)}ANTHROPIC_API_KEY=${key}`, result: { type: "text", data: `${"x".repeat(2_000)} ${key}` } },
    });
    const log = readFileSync(join(NATIVE_DIR, "t-long.ndjson"), "utf8");
    expect(log).not.toContain(key);
    expect(log).toContain("«redacted");
    expect(log).toContain("log line log line");
  });

  it("writes the log private to the user", () => {
    appendNative("t-mode", { dir: "in", source: "acp", msg: { hello: "world" } });
    const mode = statSync(join(NATIVE_DIR, "t-mode.ndjson")).mode & 0o777;
    // Windows does not implement POSIX modes; everywhere else, owner-only
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("never throws, whatever it is handed", () => {
    expect(() => appendNative("t-bad", { dir: "in", source: "acp", msg: undefined })).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => appendNative("t-cyclic", { dir: "in", source: "acp", msg: cyclic })).not.toThrow();
  });
});
