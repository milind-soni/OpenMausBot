import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts resolves DATA_DIR at import time, so point this suite at a
// scratch dir before any module under test loads.
process.env.OMB_DATA_DIR = mkdtempSync(join(tmpdir(), "omb-skill-shadow-"));

// Deterministically replay the window collectBotSkillDocuments guards: an
// enabled private skill whose read fails after the listing was computed.
const brokenRead = vi.hoisted(() => ({ botId: null as string | null, name: null as string | null }));
vi.mock("./skills.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skills.ts")>();
  return {
    ...actual,
    readSkillFile: (botId: string, name: string) =>
      brokenRead.botId === botId && brokenRead.name === name ? null : actual.readSkillFile(botId, name),
  };
});

const router = await import("./skill-router.ts");
const library = await import("./skill-library.ts");
const skills = await import("./skills.ts");

const SKILL = (name: string, description: string, body = "Do the thing.") =>
  "---\nname: " + name + "\ndescription: " + description + "\n---\n\n# " + name + "\n\n" + body + "\n";

describe("collectBotSkillDocuments private shadowing", () => {
  it("drops a broken private skill instead of indexing its unassigned library twin", () => {
    const bot = "shadow-bot";
    const priv = skills.installSkill(bot, "https://example.com/priv", [
      { path: "SKILL.md", content: SKILL("code-review", "Private review flavor") },
    ]);
    expect("error" in priv).toBe(false);
    expect("error" in skills.setSkillEnabled(bot, "code-review", true)).toBe(false);
    expect("error" in library.installLibrarySkill({
      name: "code-review",
      instructions: SKILL("code-review", "Library review flavor"),
      source: "library",
      reviewState: "approved",
    })).toBe(false);

    // Listed and enabled, but its bytes cannot be read: the private name
    // must shadow the library twin, so nothing is indexed for it.
    expect(skills.listSkills(bot).find((skill) => skill.name === "code-review")?.enabled).toBe(true);
    brokenRead.botId = bot;
    brokenRead.name = "code-review";
    try {
      expect(router.collectBotSkillDocuments(bot)).toEqual([]);
    } finally {
      brokenRead.botId = null;
      brokenRead.name = null;
    }

    // With the read healthy again the private skill indexes as itself.
    expect(router.collectBotSkillDocuments(bot).map((document) => [document.name, document.source]))
      .toEqual([["code-review", "private"]]);
  });
});
