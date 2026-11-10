import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { codexDisabledNativeSkillArgs, codexTurnConfigArgs, GUEST_CONFINED_CODEX_ARGS } from "./drivers/codex-guest.ts";
import { disabledNativeSkillNames, isNativeSkillEnabled, setNativeSkillEnabled } from "./native-skill-choices.ts";
import { nativeSkillListing } from "./native-skills.ts";

afterEach(() => {
  if (!DATA_DIR.startsWith(join(tmpdir(), "omb-test-home-"))) throw new Error(`refusing to clean ${DATA_DIR}: not this test's home`);
  rmSync(join(DATA_DIR, "skill-state"), { recursive: true, force: true });
});

describe("per-bot native skill switches", () => {
  it("defaults every native skill to on", () => {
    expect(isNativeSkillEnabled("bot-a", "pdf")).toBe(true);
    expect(disabledNativeSkillNames("bot-a")).toEqual([]);
  });

  it("persists off across reads and leaves other bots alone", () => {
    expect(setNativeSkillEnabled("bot-a", "pdf", false)).toEqual({ off: ["pdf"] });
    expect(setNativeSkillEnabled("bot-a", "hatch-pet", false)).toEqual({ off: ["hatch-pet", "pdf"] });
    expect(isNativeSkillEnabled("bot-a", "pdf")).toBe(false);
    expect(isNativeSkillEnabled("bot-b", "pdf")).toBe(true);
    expect(setNativeSkillEnabled("bot-a", "pdf", true)).toEqual({ off: ["hatch-pet"] });
    expect(isNativeSkillEnabled("bot-a", "pdf")).toBe(true);
  });

  it("lists a native skill as disabled when this bot switched it off", () => {
    setNativeSkillEnabled("bot-a", "pdf", false);
    const listing = nativeSkillListing({
      name: "pdf",
      description: "Works with PDFs.",
      folder: "/tmp/pdf",
      file: "/tmp/pdf/SKILL.md",
      source: "/tmp",
      sha256: "a".repeat(64),
    }, isNativeSkillEnabled("bot-a", "pdf"));
    expect(listing).toMatchObject({ origin: "native", enabled: false, editable: false });
  });

  it("builds Codex skills.config overrides for disabled names only", () => {
    setNativeSkillEnabled("bot-a", "pdf", false);
    setNativeSkillEnabled("bot-a", "rex", false);
    expect(codexDisabledNativeSkillArgs("bot-a")).toEqual([
      "-c",
      'skills.config=[{name="pdf",enabled=false},{name="rex",enabled=false}]',
    ]);
    expect(codexDisabledNativeSkillArgs("bot-b")).toEqual([]);
    expect(codexTurnConfigArgs({ botId: "bot-a", guestConfined: true })).toEqual([
      ...GUEST_CONFINED_CODEX_ARGS,
      ...codexDisabledNativeSkillArgs("bot-a"),
    ]);
    expect(codexTurnConfigArgs({ botId: "bot-a" })).toEqual(codexDisabledNativeSkillArgs("bot-a"));
  });
});
