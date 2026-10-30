import { FilePen, Hand, Settings, ShieldAlert, ShieldCheck } from "lucide-react";

import { hasNativeAutoReview, supportsApprovalMode, type ApprovalMode } from "../../shared/approval-mode";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

// Lives outside ApprovalModeSelector so the Simple composer's + menu offers the same choices without the selector.

/** Keys, not labels: a label resolved in this module-scope array would freeze the language the app booted in. */
const APPROVAL_MODE_KEYS: ReadonlyArray<{
  mode: ApprovalMode;
  labelKey: LocaleKey;
  chipKey: LocaleKey;
  descriptionKey: LocaleKey;
  Icon: typeof Hand;
}> = [
  { mode: "ask", labelKey: "approvalMode.ask.label", chipKey: "approvalMode.ask.chip", descriptionKey: "approvalMode.ask.desc", Icon: Hand },
  { mode: "edits", labelKey: "approvalMode.edits.label", chipKey: "approvalMode.edits.chip", descriptionKey: "approvalMode.edits.desc", Icon: FilePen },
  { mode: "auto", labelKey: "approvalMode.auto.label", chipKey: "approvalMode.auto.chip", descriptionKey: "approvalMode.auto.desc", Icon: ShieldCheck },
  { mode: "full", labelKey: "approvalMode.full.label", chipKey: "approvalMode.full.chip", descriptionKey: "approvalMode.full.desc", Icon: ShieldAlert },
  { mode: "custom", labelKey: "approvalMode.custom.label", chipKey: "approvalMode.custom.chip", descriptionKey: "approvalMode.custom.desc", Icon: Settings },
];

const SIMPLE_NAME_KEYS: Record<ApprovalMode, LocaleKey> = {
  ask: "botSettings.simple.ask",
  edits: "approvalMode.edits.label",
  auto: "botSettings.simple.decide",
  full: "botSettings.simple.justDoIt",
  custom: "botSettings.simple.custom",
};

/** Simple mode's name for a level, the one the bot panel uses. Antigravity's full-access grant shows as Auto, as it
 * does in Advanced. */
export function simpleApprovalName(mode: ApprovalMode, driverKind?: string): string {
  return t(SIMPLE_NAME_KEYS[driverKind === "antigravityAgent" && mode === "full" ? "auto" : mode]);
}

export interface ApprovalModeOption {
  mode: ApprovalMode;
  label: string;
  chip: string;
  description: string;
  Icon: typeof Hand;
}

export function approvalModeOptions(): ApprovalModeOption[] {
  return APPROVAL_MODE_KEYS.map(({ mode, labelKey, chipKey, descriptionKey, Icon }) => ({
    mode,
    label: t(labelKey),
    chip: t(chipKey),
    description: t(descriptionKey),
    Icon,
  }));
}

export function approvalModeOptionsFor(driverKind: string, trustedModesAvailable = true) {
  return approvalModeOptions()
    .filter((option) => supportsApprovalMode(driverKind, option.mode)
      // Antigravity has no native reviewer: its full-access grant is shown as Auto below, and the real Auto, which
      // behaves as Ask, is not offered.
      && (driverKind !== "antigravityAgent" || option.mode !== "auto")
      && (trustedModesAvailable || option.mode !== "custom"))
    .map((option) => {
      if (driverKind === "antigravityAgent" && option.mode === "full") {
        return {
          ...option,
          label: t("approvalMode.antigravity.label"),
          chip: t("approvalMode.auto.chip"),
          description: t("approvalMode.antigravity.desc"),
        };
      }
      return option.mode === "auto" && !hasNativeAutoReview(driverKind)
        ? { ...option, description: t("approvalMode.noNativeReview") }
        : option;
    });
}

export function approvalModeSelectionRequiresLocalDesktop(
  currentMode: ApprovalMode,
  trustedModesAvailable: boolean,
) {
  // Custom cannot leave through HTTP even while the provider instance is missing, so the lock follows the durable mode.
  return currentMode === "custom" && !trustedModesAvailable;
}

/** The mode to show as chosen. Security: old Antigravity Auto settings still ask; never display or silently grant the new Auto until it is chosen. */
export function shownApprovalMode(driverKind: string, savedMode: ApprovalMode): ApprovalMode {
  return driverKind === "antigravityAgent" && savedMode === "auto" ? "ask" : savedMode;
}
