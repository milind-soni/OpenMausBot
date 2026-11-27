import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { passageMatcher } from "./memory-entries.ts";
import { botMemoryUpdate } from "./memory-forget.ts";
import { isForgotten, planLearned, rememberForgotten } from "./profile-learned.ts";
import { MEMORY_ENTRY_MAX_CHARS, MEMORY_ENTRY_MAX_LINES, readMemoryFile, workspaceDir, writeMemoryFile } from "./workspace.ts";

const bot = `append-forgotten-${process.pid}`;
const fact = "The person prefers long replies";
const profile = join(DATA_DIR, "profile-learned.json");
const options = { source: "chat", aboutMe: null };

beforeEach(() => {
  rmSync(profile, { force: true });
  writeMemoryFile(bot, "- Existing note.\n");
  rememberForgotten("long replies", passageMatcher("long replies")!);
  rememberForgotten("cello", passageMatcher("cello")!);
});

afterEach(() => {
  rmSync(profile, { force: true });
  rmSync(workspaceDir(bot), { recursive: true, force: true });
});

describe("a rejected append preserves the person's forget request", () => {
  it.each([
    { reason: "an incompatible oldText", input: { text: fact, oldText: "Existing note." } },
    { reason: "an invalid expiry", input: { text: fact, until: "not-a-date" } },
    { reason: "too many characters", input: { text: fact + " " + "x".repeat(MEMORY_ENTRY_MAX_CHARS) } },
    { reason: "too many lines", input: { text: fact + "\nline".repeat(MEMORY_ENTRY_MAX_LINES) } },
  ])("keeps the profile unchanged after $reason", ({ input }) => {
    const before = readFileSync(profile, "utf8");
    expect(botMemoryUpdate(bot, { action: "append", ...input }, options)).toMatchObject({ ok: false, code: "invalid" });
    expect(readMemoryFile(bot).text).toBe("- Existing note.\n");
    expect(readFileSync(profile, "utf8")).toBe(before);
    expect(isForgotten(fact)).toBe(true);
    expect(planLearned({ botId: bot, botName: "Scout" }, [fact], "", "2026-11-17")).toEqual([]);
  });

  it("keeps the marker when the memory file cannot be read", () => {
    const before = readFileSync(profile, "utf8");
    const memory = join(workspaceDir(bot), "MEMORY.md");
    rmSync(memory);
    mkdirSync(memory);
    expect(() => botMemoryUpdate(bot, { action: "append", text: fact }, options)).toThrow();
    expect(readFileSync(profile, "utf8")).toBe(before);
    expect(isForgotten(fact)).toBe(true);
  });

  it("unblocks only the restored fact after the append succeeds", () => {
    expect(botMemoryUpdate(bot, { action: "append", text: fact }, options)).toMatchObject({ ok: true });
    expect(readMemoryFile(bot).text).toContain(fact);
    expect(isForgotten(fact)).toBe(false);
    expect(isForgotten("The person plays the cello")).toBe(true);
    expect(planLearned({ botId: bot, botName: "Scout" }, [fact], "", "2026-11-17").map((entry) => entry.text)).toEqual([fact]);
  });
});
