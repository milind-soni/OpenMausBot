import { describe, expect, it } from "vitest";

import { clipFromTail, estimateTokens, modelFacingTurns, shouldCompact, usersAfterCompaction, vectorBudget, type FacingTurn } from "./context-rebuild.ts";
import type { Message } from "./store.ts";

const msg = (partial: Partial<Message> & Pick<Message, "id" | "kind" | "role">): Message => ({
  at: 1,
  ...partial,
});

describe("modelFacingTurns", () => {
  it("replays text and compact tool chips, skipping cards", () => {
    const path = [
      msg({ id: "g", role: "bot", kind: "text", text: "hello" }),
      msg({ id: "u1", role: "user", kind: "text", text: "ship it", parentId: "g" }),
      msg({ id: "t1", role: "bot", kind: "activity", tool: { name: "Bash", ok: true }, parentId: "u1" }),
      msg({ id: "a1", role: "bot", kind: "text", text: "done", parentId: "t1" }),
    ];
    const byId = new Map(path.map((m) => [m.id, m]));
    const facing = modelFacingTurns(path, new Set(), byId, "Max");
    expect(facing.lastCompaction).toBeNull();
    expect(facing.transcript.map((t) => t.text)).toEqual(["hello", "ship it", "[tool Bash → ok]", "done"]);
  });

  it("starts the tail at firstKeptId after a compaction record", () => {
    const path = [
      msg({ id: "g", role: "bot", kind: "text", text: "hello" }),
      msg({ id: "old", role: "user", kind: "text", text: "ancient history", parentId: "g" }),
      msg({
        id: "c1",
        role: "bot",
        kind: "compaction",
        text: "Goal\nship the feature",
        compaction: { summary: "Goal\nship the feature", firstKeptId: "u2", tokensBefore: 12_000 },
        parentId: "old",
      }),
      msg({ id: "u2", role: "user", kind: "text", text: "what is next?", parentId: "c1" }),
    ];
    const byId = new Map(path.map((m) => [m.id, m]));
    const facing = modelFacingTurns(path, new Set(["u2"]), byId, "Max");
    expect(facing.lastCompaction).toEqual({
      summary: "Goal\nship the feature",
      firstKeptId: "u2",
      tokensBefore: 12_000,
    });
    expect(facing.transcript).toEqual([]);
  });
});

describe("clipFromTail", () => {
  it("keeps the newest turns that fit the budget", () => {
    const turns: FacingTurn[] = [
      { role: "user", text: "aaaa".repeat(50) },
      { role: "assistant", text: "bbbb".repeat(50) },
      { role: "user", text: "cccc".repeat(10) },
    ];
    const clipped = clipFromTail(turns, estimateTokens(turns[2]!.text) + 1);
    expect(clipped).toEqual([turns[2]]);
  });

  it("does not let a giant middle paste block an older short canary turn", () => {
    const canary: FacingTurn = {
      role: "assistant",
      text: "Ack. CANARY_AUTO_102K_A7F1 vault=/tmp/omb-vault-auto-102k",
    };
    const giant: FacingTurn = { role: "user", text: "x".repeat(20_000) };
    const newest: FacingTurn = { role: "assistant", text: "UNIQUE-G received." };
    const budget =
      estimateTokens(newest.text) + estimateTokens(canary.text) + estimateTokens("x".repeat(1200)) + 50;
    const clipped = clipFromTail([canary, giant, newest], budget);
    expect(clipped.some((t) => t.text.includes("CANARY_AUTO_102K_A7F1"))).toBe(true);
    expect(clipped.some((t) => t.text.includes("/tmp/omb-vault-auto-102k"))).toBe(true);
    expect(clipped.some((t) => t.text.includes("UNIQUE-G received."))).toBe(true);
    expect(clipped.some((t) => t.text.length === 20_000)).toBe(false);
  });
});

describe("shouldCompact", () => {
  it("fires at 80% of the ceiling", () => {
    expect(shouldCompact({ fillTokens: 7_999, ceilingTokens: 10_000, turnCount: 6 })).toBe(false);
    expect(shouldCompact({ fillTokens: 8_000, ceilingTokens: 10_000, turnCount: 6 })).toBe(true);
  });

  it("does not fire on a one-turn thread", () => {
    expect(shouldCompact({ fillTokens: 9_000, ceilingTokens: 10_000, turnCount: 1 })).toBe(false);
  });

  it("does not soft-fire until there is a user turn after the recycle", () => {
    // turnsSinceCompact counts users *after* firstKeptId (0 = just recycled).
    expect(shouldCompact({ fillTokens: 14_000, ceilingTokens: 32_000, turnCount: 6, turnsSinceCompact: 0 })).toBe(
      false,
    );
    expect(shouldCompact({ fillTokens: 26_000, ceilingTokens: 32_000, turnCount: 6, turnsSinceCompact: 1 })).toBe(
      true,
    );
  });

  it("hard-fires at the Compact around ceiling even right after a recycle", () => {
    expect(shouldCompact({ fillTokens: 32_000, ceilingTokens: 32_000, turnCount: 6, turnsSinceCompact: 0 })).toBe(
      true,
    );
    expect(shouldCompact({ fillTokens: 40_000, ceilingTokens: 32_000, turnCount: 1 })).toBe(true);
  });

  it("fires on RAM pressure only once the session is already half full", () => {
    const tight = { totalBytes: 36 * 1024 ** 3, freeBytes: 200 * 1024 ** 2 };
    expect(shouldCompact({ fillTokens: 1_000, ceilingTokens: 10_000, turnCount: 6, memory: tight })).toBe(false);
    expect(shouldCompact({ fillTokens: 5_000, ceilingTokens: 10_000, turnCount: 6, memory: tight })).toBe(true);
  });
});

describe("usersAfterCompaction", () => {
  it("excludes the compacting firstKeptId user turn", () => {
    const transcript = [
      { role: "user", id: "u-compact" },
      { role: "assistant", id: "a1" },
      { role: "user", id: "u2" },
    ];
    expect(usersAfterCompaction(transcript, { firstKeptId: "u-compact" })).toBe(1);
    expect(usersAfterCompaction(transcript, null)).toBeUndefined();
  });
});

describe("vectorBudget", () => {
  it("scales with the ceiling and Auto-caps at 6000 so a one-pager can keep Next", () => {
    expect(vectorBudget(8_192)).toBe(Math.floor(8_192 * 0.15));
    expect(vectorBudget(200_000)).toBe(6_000);
    expect(vectorBudget(1_000)).toBe(512);
  });

  it("honors a vector-size preset but never exceeds the recycle ceiling", () => {
    expect(vectorBudget(160_000, 16_000)).toBe(16_000);
    expect(vectorBudget(32_000, 160_000)).toBe(32_000);
    expect(vectorBudget(128_000, 128_000)).toBe(128_000);
  });
});
