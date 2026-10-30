import { appVersion } from "./app-links";
import { t } from "./i18n";

/** GET /api/updates/check (server/update-check.ts). */
export interface ServerUpdateCheck {
  current: string;
  install: "desktop" | "managed" | "docker" | "podman" | "npm" | "git" | "unknown";
  latest?: string;
  available: boolean;
  releaseUrl?: string;
  command?: string;
  restart?: boolean;
}

export type ServerUpdatePhase = "idle" | "checking" | "up-to-date" | "available" | "reload" | "error";

/**
 * What a finished check means for this page. A tab left open across a server update keeps running
 * the old bundle (the version About shows), so a current server alone doesn't make the page up to date.
 */
export function serverCheckPhase(check: ServerUpdateCheck, bundle = appVersion()): ServerUpdatePhase {
  if (check.available) return "available";
  if (check.install === "desktop" || check.install === "managed") return "up-to-date";
  return bundle !== "dev" && check.current !== bundle ? "reload" : "up-to-date";
}

/** `otherServer`: the name of the server the desktop app's window shows when it isn't this computer's own; its update is
 * for whoever runs it, never this app's. */
export function serverUpdateRow(
  phase: ServerUpdatePhase,
  check: ServerUpdateCheck | null,
  bundle = appVersion(),
  otherServer: string | null = null,
): { label: string; subtitle?: string } {
  if (phase === "checking") return { label: t("sidebar.update.checking") };
  if (phase === "error") return { label: t("sidebar.update.checkFailed") };
  if (check?.install === "desktop") return { label: t("sidebar.update.howDesktop") };
  if (check?.install === "managed") return { label: t("sidebar.update.managed") };
  if (phase === "available" && check?.latest) {
    const how = otherServer
      ? (check.restart ? "sidebar.update.howOtherRestart" : "sidebar.update.howOther")
      : (check.restart ? "sidebar.update.howRestart" : "sidebar.update.how");
    const subtitle = check.command ? t(how, { command: check.command }) : undefined;
    const label = otherServer
      ? t("sidebar.update.availableOther", { name: otherServer, version: check.latest })
      : t("sidebar.update.availableServer", { version: check.latest });
    return { label, subtitle };
  }
  if (phase === "reload" && check) {
    return { label: t("sidebar.update.reloadPage", { version: check.current }), subtitle: t("sidebar.update.pageVersion", { version: bundle }) };
  }
  if (phase === "up-to-date") {
    const label = otherServer ? t("sidebar.update.upToDateOther", { name: otherServer }) : t("sidebar.update.upToDate");
    return { label, subtitle: check ? `v${check.current}` : undefined };
  }
  return { label: t("sidebar.update.check") };
}
