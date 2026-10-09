import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FAILED_TURN_MAX_CHARS, failedTurnCause, failedTurnTool } from "./failed-turn";

describe("a failed turn's row", () => {
  it("reads back exactly what was written", () => {
    const limit = "Your Pro plan includes 2 cloud computers at once. Delete one to start another.";
    expect(failedTurnTool(limit)).toEqual({ name: `error: ${limit}`, ok: false });
    expect(failedTurnCause(failedTurnTool(limit).name)).toBe(limit);
    expect(failedTurnCause("Bash")).toBeNull();
    expect(failedTurnCause("notice: retrying")).toBeNull();
  });

  it("keeps a long cause's next action, whichever path wrote it", () => {
    // the direct path's automatic-recovery wording used to lose the
    // original error's last sentence at 160 characters, a room's at 140
    const cause = `Automatic recovery unavailable: ${"the backup engine cannot run this thread here. ".repeat(5)}Original error: Your Pro plan includes 2 cloud computers at once. Delete one to start another.`;
    expect(cause.length).toBeGreaterThan(320);
    expect(failedTurnCause(failedTurnTool(cause).name)).toBe(cause);
  });

  it("bounds only a pathological message, and says it was cut", () => {
    const words = failedTurnCause(failedTurnTool("x".repeat(30_000)).name)!;
    expect(words).toHaveLength(FAILED_TURN_MAX_CHARS);
    expect(words.endsWith("…")).toBe(true);
  });

  it("carries the flags a client acts on, and only when set", () => {
    expect(failedTurnTool("Not logged in", { setup: true, terminal: true, claudeUpdate: true }))
      .toEqual({ name: "error: Not logged in", ok: false, setup: true, terminal: true, claudeUpdate: true });
    expect(Object.keys(failedTurnTool("rate limited", { setup: false }))).toEqual(["name", "ok"]);
  });

  it("is the only way the server writes one", () => {
    // a hand-written row is how one path ended up with its own cut
    const dir = new URL("../server/", import.meta.url);
    const handWritten = readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.includes("testing"))
      .flatMap((file) => readFileSync(new URL(file, dir), "utf8").split("\n")
        .filter((line) => /["'`]error: /.test(line))
        .map((line) => `${file}: ${line.trim()}`));
    expect(handWritten).toEqual([]);
  });
});
