// The last English surfaces held their copy in three shapes worth guarding:
// module-scope status maps, an exported constant read by a warning dialog, and
// a sample sentence a voice reads aloud. All three are evaluated once unless
// they are keys or functions.
import { afterEach, describe, expect, it } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { en, locales } from "@/locales";
import { SKINS } from "@/lib/skins";
import { sidebarGoalRunPreview } from "@/lib/sidebar-layout";

afterEach(() => {
  setLocale("en");
});

describe("remaining surfaces", () => {
  it("resolves the sidebar goal preview at call time", () => {
    const run = { status: "needs-input", goal: "Ship the release", turnCount: 1, maxTurns: 8 } as never;

    expect(sidebarGoalRunPreview(run)).toContain(en["goal.needsInput"]);

    setLocale("pt-br");
    expect(sidebarGoalRunPreview(run)).toContain(locales["pt-br"]!["goal.needsInput"]);
    expect(sidebarGoalRunPreview(run)).not.toContain(en["goal.needsInput"]);
  });

  it("keeps every skin tagline as a catalog key", () => {
    for (const skin of SKINS) {
      expect(Object.hasOwn(en, skin.taglineKey), skin.taglineKey).toBe(true);
    }

    setLocale("ja");
    const midnight = SKINS.find((skin) => skin.id === "midnight");
    expect(t(midnight!.taglineKey)).toBe(locales.ja!["skins.midnight"]);
  });

  it("resolves messages that used to live in module constants", async () => {
    // Each of these was a `const MESSAGE = "…"` evaluated at import, so the
    // first language the module was loaded in was the only one it ever spoke.
    const { localComputerAutoWarning } = await import("@/components/LocalComputerAutoWarning");
    const { parseRoomTurnTimeoutMinutes } = await import("@/lib/room-turn-timeout");

    expect(localComputerAutoWarning()).toBe(en["localAuto.body"]);
    expect(parseRoomTurnTimeoutMinutes("nope")).toEqual({ ok: false, error: en["rooms.turnTimeoutError"] });

    setLocale("pt-br");
    expect(localComputerAutoWarning()).toBe(locales["pt-br"]!["localAuto.body"]);
    expect(parseRoomTurnTimeoutMinutes("nope")).toEqual({
      ok: false,
      error: locales["pt-br"]!["rooms.turnTimeoutError"],
    });
  });

  it("reads the full-access warning through a function, not a frozen constant", async () => {
    // A `const FULL_ACCESS_WARNING = "…"` would keep the language this module
    // was first imported in — and this is the text someone reads before
    // granting a bot unattended control.
    const { fullAccessWarning } = await import("@/components/FullAccessWarning");
    expect(fullAccessWarning()).toBe(en["fullAccess.body"]);

    setLocale("de");
    expect(fullAccessWarning()).toBe(locales.de!["fullAccess.body"]);
  });
});
