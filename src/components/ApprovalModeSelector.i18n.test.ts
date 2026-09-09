// A held note explains why a bot stopped by naming the button that would
// have let it continue: "… so Approve for me stopped to ask." If the note and
// the selector ever disagree, the note points at a control the reader cannot
// find — which is the one thing this copy must never do.
import { describe, expect, it, afterEach } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { locales } from "@/locales";
import { approvalModeOptions } from "./ApprovalModeSelector";

const PACKS = Object.keys(locales).filter((code) => code !== "pt");

afterEach(() => {
  setLocale("en");
});

describe("held notes name the buttons the selector shows", () => {
  it("quotes the same mode names in every pack", () => {
    for (const code of PACKS) {
      setLocale(code);
      const label = (mode: string) =>
        approvalModeOptions().find((option) => option.mode === mode)!.label;

      expect(t("approval.held.destructive"), code).toContain(label("auto"));
      expect(t("approval.held.sensitive"), code).toContain(label("auto"));
      expect(t("approval.held.needsYou"), code).toContain(label("auto"));
      expect(t("approval.held.undelivered"), code).toContain(label("auto"));
      expect(t("approval.held.unattended"), code).toContain(label("auto"));
      expect(t("approval.held.unattendedFullAccess"), code).toContain(label("auto"));
      expect(t("approval.held.unattendedFullAccess"), code).toContain(label("full"));
      expect(t("approval.held.sandbox"), code).toContain(label("full"));
      expect(t("approval.held.undeliveredFull"), code).toContain(label("full"));
      // the same rule for the action button a held note can name
      expect(t("approval.held.localComputer"), code).toContain(t("approval.action.alwaysAllow"));
    }
  });

  it("resolves the labels when they are read, not when the module loads", () => {
    setLocale("pt-br");
    expect(approvalModeOptions().map((option) => option.label)).toEqual([
      "Pedir aprovação",
      "Aprovar por mim",
      "Acesso total",
      "Personalizado (config.toml)",
    ]);

    setLocale("ja");
    expect(approvalModeOptions()[1].label).toBe("自動で承認");
  });
});
