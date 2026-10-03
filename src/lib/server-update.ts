import { t } from "./i18n";

/** GET /api/updates/check (server/update-check.ts). */
export interface ServerUpdateCheck {
  current: string;
  install: "desktop" | "managed" | "docker" | "npm" | "git" | "unknown";
  latest?: string;
  available: boolean;
  releaseUrl?: string;
  command?: string;
  restart?: boolean;
}

export type ServerUpdatePhase = "idle" | "checking" | "up-to-date" | "available" | "error";

/** What the profile menu's update row says for a server the desktop app
 * does not manage: it cannot update itself, so it says how (MOCA-276). */
export function serverUpdateRow(phase: ServerUpdatePhase, check: ServerUpdateCheck | null): { label: string; subtitle?: string } {
  if (phase === "checking") return { label: t("sidebar.update.checking") };
  if (phase === "error") return { label: t("sidebar.update.checkFailed") };
  if (check?.install === "desktop") return { label: t("sidebar.update.howDesktop") };
  if (check?.install === "managed") return { label: t("sidebar.update.managed") };
  if (phase === "available" && check?.latest) {
    const subtitle = check.command
      ? t(check.restart ? "sidebar.update.howRestart" : "sidebar.update.how", { command: check.command })
      : undefined;
    return { label: t("sidebar.update.availableServer", { version: check.latest }), subtitle };
  }
  if (phase === "up-to-date") return { label: t("sidebar.update.upToDate"), subtitle: check ? `v${check.current}` : undefined };
  return { label: t("sidebar.update.check") };
}
