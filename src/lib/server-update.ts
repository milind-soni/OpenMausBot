import type { ServerUpdateReason, ServerUpdateStatus } from "../../shared/server-update";
import type { AppUpdateAnswer } from "@/types/ogb";
import type { LocaleKey } from "@/locales";
import { appVersion } from "./app-links";
import { t } from "./i18n";

export type { ServerUpdateStatus };

/** GET /api/updates/check (server/update-check.ts). */
export interface ServerUpdateCheck {
  current: string;
  install: "desktop" | "managed" | "docker" | "podman" | "npm" | "git" | "unknown";
  channel?: "stable" | "newest";
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

/** X.Y.Z only; anything else is never newer. */
export function newerVersion(a: string, b: string): boolean {
  const parse = (value: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())?.slice(1).map(Number);
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/** An update that has not come back after this long is said to be stuck, with what to run on the server. */
export const SERVER_UPDATE_DEADLINE_MS = 15 * 60_000;

export type ServerUpdateAction = "check" | "update-server" | "update-app" | "reload" | null;

/** The one row Settings → Updates shows for a self-hosted server: what is behind (the server, this app, or both) and the
 * one action that fixes it, with the last update's outcome as `note`. */
export interface ServerUpdateView {
  label: string;
  subtitle?: string;
  note?: string;
  noteTone?: "danger";
  action: ServerUpdateAction;
  busy: boolean;
}

const REASON_TEXT: Record<ServerUpdateReason, LocaleKey> = {
  busy: "serverUpdate.reason.busy",
  refused: "serverUpdate.reason.refused",
  older: "serverUpdate.reason.older",
  held: "serverUpdate.reason.held",
  "too-soon": "serverUpdate.reason.tooSoon",
  "no-updater": "serverUpdate.reason.noUpdater",
  failed: "serverUpdate.reason.failed",
  "not-retried": "serverUpdate.reason.notRetried",
  stale: "serverUpdate.reason.stale",
  unreleased: "serverUpdate.reason.unreleased",
  unsafe: "serverUpdate.reason.unsafe",
};

/** The command each reason names, from what the server said. */
function reasonText(reason: ServerUpdateReason, status: ServerUpdateStatus, target?: string): string {
  const command = reason === "stale" || reason === "unsafe" ? status.setup : status.command;
  return t(REASON_TEXT[reason], { version: target ?? status.latest ?? "", command: command ?? "" });
}

const APP_ANSWER_TEXT: Partial<Record<AppUpdateAnswer, LocaleKey>> = {
  downloading: "serverUpdate.appDownloading",
  current: "serverUpdate.appCurrent",
  failed: "serverUpdate.appFailed",
  unavailable: "serverUpdate.appUnavailable",
};

function runNote(status: ServerUpdateStatus | null): Pick<ServerUpdateView, "note" | "noteTone"> {
  const run = status?.run;
  switch (run?.outcome) {
    case "updated": return { note: t("serverUpdate.updated", { version: run.to ?? status!.current }) };
    case "unchanged": return { note: t("serverUpdate.unchanged") };
    case "rolled-back": return { note: `${t("serverUpdate.rolledBack", { version: run.from })} ${t("serverUpdate.rolledBackDetail")}`, noteTone: "danger" };
    case "rollback-failed": {
      const detail = status!.rollback ? ` ${t("serverUpdate.runOnServer", { command: status!.rollback })}` : "";
      return { note: `${t("serverUpdate.rollbackFailed")}${detail}`, noteTone: "danger" };
    }
    case "not-changed": return { note: `${t("serverUpdate.notChanged")} ${reasonText(run.reason ?? "failed", status!, run.target)}`, noteTone: "danger" };
    case "not-started": return { note: `${t("serverUpdate.notStarted")} ${t("serverUpdate.runOnServer", { command: "systemctl status openmausbot-update.path" })}`, noteTone: "danger" };
    default: return {};
  }
}

export function serverUpdateView(input: {
  check: ServerUpdateCheck | null;
  /** The admin's view of the button; null for a member, or before it loads. */
  status: ServerUpdateStatus | null;
  /** The version of the page's own code. */
  bundle?: string;
  /** This desktop app's own version, when the page is another server's and the app can be asked for its update; null in
   * a browser and on this computer. */
  app?: string | null;
  checking?: boolean;
  failed?: boolean;
  pressed?: boolean;
  appAnswer?: AppUpdateAnswer | null;
  /** How long this page has been waiting for the server to come back from an update. */
  waitedMs?: number;
}): ServerUpdateView {
  const { check, status } = input;
  const bundle = input.bundle ?? appVersion();
  const outcome = status?.run?.outcome;
  if (input.pressed || outcome === "requested" || outcome === "running") {
    if ((input.waitedMs ?? 0) >= SERVER_UPDATE_DEADLINE_MS) {
      const how = [
        status?.logs ? t("serverUpdate.runOnServer", { command: status.logs }) : "",
        status?.rollback ? t("serverUpdate.goBack", { command: status.rollback }) : "",
      ].filter(Boolean).join(" ");
      return { label: t("serverUpdate.notBack"), subtitle: t("serverUpdate.notBackDetail"), ...(how ? { note: how, noteTone: "danger" as const } : {}), action: null, busy: true };
    }
    return { label: t("serverUpdate.updating"), subtitle: t("serverUpdate.updatingDetail"), action: null, busy: true };
  }
  const note = runNote(status);
  const appNote = input.appAnswer && APP_ANSWER_TEXT[input.appAnswer] ? { note: t(APP_ANSWER_TEXT[input.appAnswer]!) } : {};
  const extra = { ...note, ...appNote };
  if (input.checking) return { label: t("sidebar.update.checking"), action: null, busy: true, ...extra };
  if (input.failed) return { label: t("sidebar.update.checkFailed"), action: "check", busy: false, ...extra };
  if (!check) return { label: t("sidebar.update.check"), action: "check", busy: false, ...extra };
  if (check.install === "desktop" || check.install === "managed") {
    return { label: t(check.install === "desktop" ? "sidebar.update.howDesktop" : "sidebar.update.managed"), action: null, busy: false };
  }
  if (bundle !== "dev" && check.current !== bundle && !check.available) {
    return { label: t("sidebar.update.reloadPage", { version: check.current }), subtitle: t("sidebar.update.pageVersion", { version: bundle }), action: "reload", busy: false, ...extra };
  }
  const appBehind = Boolean(input.app && newerVersion(check.current, input.app));
  if (status?.why === "unreleased") {
    const label = check.available && check.latest ? t("serverUpdate.available", { version: check.latest }) : `v${check.current}`;
    return { label, subtitle: reasonText("unreleased", status), action: null, busy: false, ...extra };
  }
  if (check.available && check.latest) {
    const label = t(appBehind ? "serverUpdate.availableBoth" : "serverUpdate.available", { version: check.latest });
    if (status?.mode === "button") return { label, action: "update-server", busy: false, ...extra };
    if (status?.mode === "held") return { label, subtitle: t("serverUpdate.reason.held"), action: null, busy: false, ...extra };
    const how = check.restart ? "sidebar.update.howRestart" : "sidebar.update.how";
    const command = status?.command ?? check.command;
    return { label, ...(command ? { subtitle: t(how, { command }) } : {}), action: null, busy: false, ...extra };
  }
  if (appBehind && input.app) {
    return { label: t("serverUpdate.appBehind", { appVersion: input.app, serverVersion: check.current }), action: "update-app", busy: false, ...extra };
  }
  return { label: t("sidebar.update.upToDate"), subtitle: `v${check.current}`, action: "check", busy: false, ...extra };
}

/** The confirm before Update server: the server restarts and running work stops, with how much is running now. */
export function serverUpdateConfirmBody(activeTurns: number): string {
  const busy = activeTurns > 0 ? t(activeTurns === 1 ? "serverUpdate.confirmBusy.one" : "serverUpdate.confirmBusy.other", { count: activeTurns }) : "";
  return [t("serverUpdate.confirmBody"), busy].filter(Boolean).join(" ");
}
