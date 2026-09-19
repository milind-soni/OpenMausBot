import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { ComputerPanelPhase, PhaseError } from "@/lib/computer-panel-phase";

/** Keep local failure copy translatable while it remains in panel state. */
export class LocalizedPanelError extends Error {
  constructor(
    readonly key: LocaleKey,
    readonly problem?: string | null,
    readonly fallbackKey?: LocaleKey,
  ) {
    super(key);
  }
}

export function panelErrorText(error: Error | string | null): string | null {
  if (error instanceof LocalizedPanelError) {
    return t(error.key, error.fallbackKey ? { problem: error.problem ?? t(error.fallbackKey) } : undefined);
  }
  return error instanceof Error ? error.message : error;
}

/** The panel's phase set, decided by the pure deciders in
 * `@/lib/computer-panel-phase` where a status snapshot settles it. */
export type Phase = ComputerPanelPhase;

/** Map a decider's error payload onto the panel's error state. */
export function phaseErrorToPanelError(error: PhaseError | null): Error | string | null {
  if (!error) return null;
  if (error.kind === "localized") {
    return new LocalizedPanelError(error.key, error.problem, error.fallbackKey);
  }
  return error.text;
}
