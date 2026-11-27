import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./cleanup.ts";

const deltaText = (frame: { type: unknown; event?: unknown }): string => {
  if (frame.type !== "stream_event" || typeof frame.event !== "object" || frame.event === null || !("delta" in frame.event)) return "";
  const delta = frame.event.delta;
  if (typeof delta !== "object" || delta === null || !("text" in delta)) return "";
  const text = delta.text;
  return typeof text === "string" ? text : "";
};

it("completes a cadence-replayed turn with a result frame and a clean exit", async () => {
  const home = mkdtempSync(join(tmpdir(), "omb-claude-cadence-"));
  const markers = join(home, "marker-replies.json");
  const reply = "one two three four five six seven eight";
  writeFileSync(markers, JSON.stringify({ "omb cadence probe": reply }));
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [
      fileURLToPath(new URL("fake-claude-cli.ts", import.meta.url)),
      "--output-format", "stream-json",
    ], {
      cwd: home,
      env: {
        ...process.env, HOME: home, USERPROFILE: home,
        FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_EXIT_AFTER_TURN: "1",
        FAKE_CLAUDE_STREAM_CADENCE: "8:1",
        FAKE_CLAUDE_MARKER_REPLIES: markers,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => { out += chunk; });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise<number | null>((resolve) => child!.once("close", (code) => resolve(code)));
    child.stdin!.end(JSON.stringify({ type: "user", message: { role: "user", content: "omb cadence probe" } }) + "\n");
    await expect.poll(() => child!.exitCode, { timeout: 10_000 }).not.toBeNull();
    await closed;
    expect(child.exitCode, stderr).toBe(0);
    expect(stderr).not.toContain("Error:");
    const frames: Array<{ type: unknown; event?: unknown }> = out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(frames.map(deltaText).join("")).toBe(reply);
    expect(frames.some((frame) => frame.type === "result")).toBe(true);
  } finally {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }
});
