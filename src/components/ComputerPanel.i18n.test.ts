// The Computer panel keeps no screen image, so its copy has to describe what is
// actually on screen: a beam that marks the screen while the agent drives, and
// a live desktop that opens in its own window. Two things went wrong in the
// panel before — translated strings frozen at import in a module-scope table,
// and copy that outlived the surface it described. This file guards both.
import { afterEach, describe, expect, it } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { en, locales } from "@/locales";

afterEach(() => {
  setLocale("en");
});

describe("computer panel copy", () => {
  it("translates the driving status in every pack that carries it", () => {
    for (const [code, pack] of Object.entries(locales)) {
      setLocale(code);
      const copy = t("computer.astraDriving", { name: "Astra" });
      // A pack without the key falls back to English, never to the raw key.
      expect(copy, code).toContain("Astra");
      expect(copy, code).not.toBe("computer.astraDriving");
      if (code !== "en" && pack["computer.astraDriving"]) {
        expect(pack["computer.astraDriving"], code).not.toBe(en["computer.astraDriving"]);
      }
    }
  });

  it("sends the reader to the live desktop for every ready state", () => {
    // These keys used to describe a preview inside the panel. Each one is
    // reachable again the moment a ready phase renders, so a stale sentence
    // here is a sentence a user reads.
    for (const key of ["computer.waitingFrame", "computer.capturingVm", "computer.capturingLocal", "computer.linuxReady"] as const) {
      expect(en[key].toLowerCase(), key).toContain("live desktop");
    }
  });

  it("no longer promises an in-panel preview", () => {
    for (const key of ["computer.useOpenDesktopVm", "computer.linux.waylandAfter"] as const) {
      expect(en[key].toLowerCase(), key).not.toContain("preview");
    }
  });

  it("asks for the screen permission without blaming a preview", () => {
    expect(en["computer.needsScreenPerm"].toLowerCase()).toContain("screen recording");
    expect(en["computer.needsScreenPerm"].toLowerCase()).not.toContain("preview");
  });
});
