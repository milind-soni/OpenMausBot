// The bot folder contract: SOUL.md is a mirror of the record, written by
// the server, never read to build a prompt. A file that no longer matches
// the record's hash is reported as drift with its text; a missing file is
// simply re-created. The prompt block is empty for an empty soul.
// Test isolation is provided by server/testing/setup.ts's per-file throwaway HOME.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const {
  BOTS_DIR,
  botFolder,
  checkSoulDrift,
  readSoulDrift,
  removeBotFolder,
  soulFile,
  soulHash,
  soulSystemPrompt,
  writeSoulMirror,
} = await import("./bot-folder.ts");

describe("bot folder", () => {
  it("lives under DATA_DIR/bots/<id>", () => {
    // DATA_DIR is computed from homedir() during config.ts import
    const DATA_DIR = join(homedir(), ".openmausbot");
    expect(BOTS_DIR).toBe(join(DATA_DIR, "bots"));
    expect(botFolder("b1")).toBe(join(BOTS_DIR, "b1"));
    expect(soulFile("b1")).toBe(join(BOTS_DIR, "b1", "SOUL.md"));
  });

  it("writes the mirror with private modes, even when the soul is empty", () => {
    writeSoulMirror("b2", "");
    expect(readFileSync(soulFile("b2"), "utf8")).toBe("");
    if (process.platform !== "win32") {
      expect(statSync(botFolder("b2")).mode & 0o777).toBe(0o700);
      expect(statSync(soulFile("b2")).mode & 0o777).toBe(0o600);
    }
    writeSoulMirror("b2", "# Kiwi\nFile bugs, never noise.\n");
    expect(readFileSync(soulFile("b2"), "utf8")).toBe("# Kiwi\nFile bugs, never noise.\n");
  });

  it("hashes deterministically", () => {
    expect(soulHash("a")).toBe(soulHash("a"));
    expect(soulHash("a")).not.toBe(soulHash("b"));
    expect(soulHash("")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports no drift when the mirror matches, and re-creates a missing mirror", () => {
    const soul = "Be brief.";
    const hash = soulHash(soul);
    expect(existsSync(soulFile("b3"))).toBe(false);
    expect(checkSoulDrift("b3", soul, hash)).toEqual({ drift: false });
    expect(readFileSync(soulFile("b3"), "utf8")).toBe(soul);
    expect(checkSoulDrift("b3", soul, hash)).toEqual({ drift: false });
  });

  it("reports drift with the file text when the mirror was edited", () => {
    const soul = "Be brief.";
    writeSoulMirror("b4", soul);
    writeFileSync(soulFile("b4"), "Be verbose.");
    expect(checkSoulDrift("b4", soul, soulHash(soul))).toEqual({ drift: true, fileText: "Be verbose." });
  });

  it("surfaces unreadable mirrors to the editor without breaking turn dispatch", () => {
    mkdirSync(soulFile("broken"), { recursive: true });
    expect(() => readSoulDrift("broken", "canonical", soulHash("canonical"))).toThrow();
    expect(checkSoulDrift("broken", "canonical", soulHash("canonical"))).toEqual({ drift: false });
  });

  it("bounds external mirror reads to the standing-instructions budget", () => {
    writeSoulMirror("oversized", "🐭".repeat(6_000));
    expect(readSoulDrift("oversized", "", soulHash(""))).toMatchObject({ drift: true });
    writeFileSync(soulFile("oversized"), "🐭".repeat(6_001));
    expect(() => readSoulDrift("oversized", "", soulHash(""))).toThrow("shorten it in your editor");
    expect(checkSoulDrift("oversized", "", soulHash(""))).toEqual({ drift: false });
  });

  it("removes the folder, and tolerates a folder that is already gone", () => {
    writeSoulMirror("b5", "x");
    removeBotFolder("b5");
    expect(existsSync(botFolder("b5"))).toBe(false);
    expect(() => removeBotFolder("b5")).not.toThrow();
  });

  it("renders an empty block for an empty or whitespace soul, and a fenced block otherwise", () => {
    expect(soulSystemPrompt("")).toBe("");
    expect(soulSystemPrompt("  \n")).toBe("");
    const block = soulSystemPrompt("Be brief.\n");
    expect(block.startsWith("\n\n")).toBe(true);
    expect(block).toContain("--- BEGIN STANDING INSTRUCTIONS (SOUL.md, 9 bytes) ---\nBe brief.\n--- END STANDING INSTRUCTIONS ---");
    expect(block).toContain("proposed changes apply only after the user confirms");
    expect(block).not.toContain("propose_profile");
  });
});
