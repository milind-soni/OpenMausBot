// The native tee goes into bug reports, so this checks that the writer actually redacts.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { EventBus } from "../harness/bus.ts";
import { appendNative, discardNativeLog, flushNativeLog, flushNativeLogs, streamedFragment } from "./native.ts";

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
    flushNativeLog("t-inline");
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
    flushNativeLog("t-long");
    const log = readFileSync(join(NATIVE_DIR, "t-long.ndjson"), "utf8");
    expect(log).not.toContain(key);
    expect(log).toContain("«redacted");
    expect(log).toContain("log line log line");
  });

  it("writes the log private to the user", () => {
    appendNative("t-mode", { dir: "in", source: "acp", msg: { hello: "world" } });
    flushNativeLog("t-mode");
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

const file = (threadId: string) => join(NATIVE_DIR, `${threadId}.ndjson`);
const rows = (threadId: string) => existsSync(file(threadId))
  ? readFileSync(file(threadId), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { dir: string; msg: Record<string, unknown> })
  : [];

describe("the native tee", () => {
  beforeEach(() => {
    flushNativeLogs();
    rmSync(NATIVE_DIR, { recursive: true, force: true });
    ensureDirs();
  });

  it("keeps whole messages and drops the fragments a later record carries whole", () => {
    expect(streamedFragment("claude.sdk.message", { type: "stream_event", event: { type: "content_block_delta", delta: { text: "Hi" } } })).toBe(true);
    expect(streamedFragment("claude.sdk.message", { type: "stream_event", event: { type: "content_block_start" } })).toBe(false);
    expect(streamedFragment("claude.sdk.message", { type: "assistant", message: { content: [] } })).toBe(false);
    expect(streamedFragment("codex.app-server", { method: "item/agentMessage/delta", params: {} })).toBe(true);
    expect(streamedFragment("codex.app-server", { method: "item/commandExecution/outputDelta", params: {} })).toBe(true);
    expect(streamedFragment("codex.app-server", { method: "item/completed", params: {} })).toBe(false);
    expect(streamedFragment("pi.rpc", { type: "message_update" })).toBe(true);
    expect(streamedFragment("pi.rpc", { type: "message_end" })).toBe(false);
    expect(streamedFragment("acp", { method: "session/update" })).toBe(false);
  });

  it("holds incoming lines, in order, until a flush or the timer, and writes what it sent at once", () => {
    vi.useFakeTimers();
    try {
      appendNative("t-held", { dir: "in", source: "claude.sdk.message", msg: { type: "system", n: 1 } });
      appendNative("t-held", { dir: "in", source: "claude.sdk.message", msg: { type: "stream_event", event: { type: "content_block_delta" } } });
      appendNative("t-held", { dir: "in", source: "claude.sdk.message", msg: { type: "assistant", n: 2 } });
      expect(rows("t-held")).toEqual([]);
      appendNative("t-held", { dir: "out", source: "claude.sdk.message", msg: { type: "user", n: 3 } });
      expect(rows("t-held").map((row) => row.msg.n)).toEqual([1, 2, 3]);
      appendNative("t-held", { dir: "in", source: "claude.sdk.message", msg: { type: "result", n: 4 } });
      vi.advanceTimersByTime(300);
      expect(rows("t-held").map((row) => row.msg.n)).toEqual([1, 2, 3, 4]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes a thread's held lines when its turn ends on the bus", () => {
    const bus = new EventBus(() => {});
    appendNative("t-turn-end", { dir: "in", source: "claude.sdk.message", msg: { type: "assistant", n: 1 } });
    bus.publish({ eventId: "e1", provider: "claudeAgent", threadId: "t-turn-end", createdAt: new Date().toISOString(), type: "turn.completed", ok: true } as unknown as RuntimeEvent);
    expect(rows("t-turn-end").map((row) => row.msg.n)).toEqual([1]);
  });

  it("drops a deleted thread's held lines, so no flush recreates its log", () => {
    appendNative("t-deleted", { dir: "in", source: "claude.sdk.message", msg: { type: "assistant" } });
    discardNativeLog("t-deleted");
    flushNativeLog("t-deleted");
    flushNativeLogs();
    expect(existsSync(file("t-deleted"))).toBe(false);
  });

  it("writes every held line when the process exits", () => {
    const script = `const { appendNative } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "native.ts")).href)});
      for (let n = 0; n < 5; n++) appendNative("t-exit", { dir: "in", source: "claude.sdk.message", msg: { type: "assistant", n } });
      process.exit(0);`;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: { ...process.env, OMB_DATA_DIR: dirname(NATIVE_DIR) }, encoding: "utf8",
    });
    expect(child.status, child.stderr).toBe(0);
    expect(rows("t-exit").map((row) => row.msg.n)).toEqual([0, 1, 2, 3, 4]);
  });
});
