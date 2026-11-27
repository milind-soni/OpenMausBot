import { useCallback, useEffect, useRef, useState } from "react";
import { appPlan, type AppPlan, type ServerPlan, type ServerSkipWhy, type UpdateAllFailure, type UpdateAllRow, type UpdateAllSurvey, type UpdateAllView } from "../../electron/update-all-run.mjs";
import type { Device } from "./devices";
import { t } from "./i18n";
import { runNote, SERVER_UPDATE_DEADLINE_MS } from "./server-update";
import { updaterMessage, useUpdaterState } from "./updater";

export type { UpdateAllRow, UpdateAllView };

/** A machine in the confirm dialog: what updates on it, or why it is skipped (with the command to run there, if any). */
export interface UpdateAllLine {
  deviceId: string;
  name: string;
  text: string;
  command?: string;
}

export interface UpdateAllPlan {
  updating: UpdateAllLine[];
  skipped: UpdateAllLine[];
  /** The saved servers to update, by id; this app is last when `withApp`. */
  serverIds: string[];
  withApp: boolean;
  /** Chats answering on the servers to update, which their restart stops. */
  activeTurns: number;
}

type SkipWhy = ServerSkipWhy | "cloud" | "phone";

const WHY_TEXT: Record<SkipWhy, Parameters<typeof t>[0]> = {
  unreachable: "devicesPage.updateAll.why.unreachable",
  "signed-out": "devicesPage.updateAll.why.signedOut",
  "up-to-date": "devicesPage.updateAll.why.upToDate",
  "admin-only": "devicesPage.updateAll.why.adminOnly",
  "by-hand": "devicesPage.updateAll.why.byHand",
  held: "serverUpdate.reason.held",
  updating: "devicesPage.updateAll.why.updating",
  "too-soon": "serverUpdate.reason.tooSoon",
  cloud: "devicesPage.updateAll.why.cloud",
  phone: "devicesPage.updateAll.why.phone",
};

export const whyText = (why: SkipWhy): string => t(WHY_TEXT[why]);

const placeOf = (device: Device) => device.sources.find((source) => source.type === "place")?.id ?? null;

/**
 * Every machine Update all lists: saved servers by their own answers, this app last, a Cloud as updating by itself and a
 * phone only while it runs an older app. Lent computers, SSH servers and other signed-in computers are left out: no
 * version is known for them here.
 */
export function planUpdateAll({ devices, servers, app, olderPhones = [] }: {
  devices: readonly Device[];
  servers: UpdateAllSurvey["servers"] | null;
  app: AppPlan | null;
  olderPhones?: readonly string[];
}): UpdateAllPlan {
  const plans = new Map((servers ?? []).map((entry) => [entry.id, entry.plan] as const));
  const updating: UpdateAllLine[] = [];
  const skipped: UpdateAllLine[] = [];
  const serverIds: string[] = [];
  let activeTurns = 0;
  for (const device of devices) {
    if (device.here) continue;
    const place = placeOf(device);
    const plan: ServerPlan | undefined = place ? plans.get(place) : undefined;
    if (place && plan) {
      if (plan.updates) {
        updating.push({ deviceId: device.id, name: device.name, text: t("devicesPage.updateAll.to", { version: plan.latest }) });
        serverIds.push(place);
        activeTurns += plan.activeTurns;
      } else {
        skipped.push({ deviceId: device.id, name: device.name, text: whyText(plan.why), ...(plan.why === "by-hand" && plan.command ? { command: plan.command } : {}) });
      }
    } else if (place && device.kind === "cloud") {
      skipped.push({ deviceId: device.id, name: device.name, text: whyText("cloud") });
    } else if (device.kind === "phone" && device.sources.some((source) => source.type === "phone" && olderPhones.includes(source.id))) {
      skipped.push({ deviceId: device.id, name: device.name, text: whyText("phone") });
    }
  }
  const here = devices.find((device) => device.here);
  if (app && here) {
    const text = app.version ? t("devicesPage.updateAll.appTo", { version: app.version }) : t("devicesPage.updateAll.app");
    updating.push({ deviceId: here.id, name: here.name, text: `${text} · ${t(app.handoff ? "devicesPage.updateAll.appLastTerminal" : "devicesPage.updateAll.appLast")}` });
  }
  return { updating, skipped, serverIds, withApp: Boolean(app && here), activeTurns };
}

/** Why a row failed, in the words Settings → Updates already uses for the same outcome. `appMessage`: this app's
 * updater's own words for its last error. */
export function failureText(failure: UpdateAllFailure | undefined, latest?: string, appMessage?: string): string {
  if (!failure) return t("serverUpdate.failed");
  switch (failure.why) {
    case "run": return runNote(failure.status ?? null).note ?? t("serverUpdate.failed");
    case "mismatch": return t("devicesPage.updateAll.mismatch", { version: failure.version ?? "?", latest: latest ?? "?" });
    case "not-back": return `${t("serverUpdate.notBack")}.`;
    case "download": return appMessage ?? t("serverUpdate.appFailed");
    case "install": return appMessage ?? t("update.card.failed");
    case "failed": return t("serverUpdate.failed");
    default: return whyText(failure.why);
  }
}

/** A row's state on the Devices page while and after Update all runs. `tone` marks a failure. */
export function progressText(row: UpdateAllRow, now: number, appMessage?: string): { text: string; tone?: "danger"; busy: boolean } {
  switch (row.phase) {
    case "waiting": return { text: t("devicesPage.updateAll.state.waiting"), busy: true };
    case "updating": return { text: t("devicesPage.updateAll.state.updating"), busy: true };
    case "restarting":
      return { text: now - row.since >= SERVER_UPDATE_DEADLINE_MS ? t("serverUpdate.notBack") : t("devicesPage.updateAll.state.restarting"), busy: true };
    case "done": return { text: t("devicesPage.updateAll.state.done", { version: row.version ?? row.latest ?? "" }), busy: false };
    case "handed-off": return { text: t("update.banner.finishInTerminal"), busy: false };
    case "failed": return { text: t("devicesPage.updateAll.state.failed", { reason: failureText(row.failure, row.latest, appMessage) }), tone: "danger", busy: false };
  }
}

/** The run's row for a device: its saved server's, or this app's for this computer. */
export function rowFor(view: UpdateAllView | null, device: Device): { id: string; row: UpdateAllRow } | null {
  if (!view) return null;
  const id = device.here ? "app" : placeOf(device);
  const row = id ? view.rows[id] : undefined;
  return id && row ? { id, row } : null;
}

/**
 * Update all's bridge on This computer's page: each saved server's own answer, read once when the page opens (and
 * fresh, skipping the servers' hour-long cache, when the dialog opens), the run's rows as main reports them, and this
 * app's update as its updater reports it. `servers`: the saved servers' ids, so a new one is asked about too.
 */
export function useUpdateAll(enabled: boolean, servers: string) {
  const bridge = enabled ? window.ogb?.updateAll : undefined;
  const updater = useUpdaterState();
  const [survey, setSurvey] = useState<UpdateAllSurvey | null>(null);
  const [view, setView] = useState<UpdateAllView | null>(null);
  const [checking, setChecking] = useState(false);
  const look = useCallback(async (fresh = false) => {
    if (!bridge) return;
    if (fresh) setChecking(true);
    try {
      const next = await bridge.survey(fresh);
      setSurvey(next);
      setView(next.view);
    } catch {
      setSurvey(null);
    } finally {
      if (fresh) setChecking(false);
    }
  }, [bridge]);
  useEffect(() => { void look(); }, [look, servers]);
  useEffect(() => bridge?.onState(setView), [bridge]);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && view && !view.running) void look();
    wasRunning.current = Boolean(view?.running);
  }, [view, look]);
  const start = useCallback(async (ids: string[], withApp: boolean) => { if (bridge) setView(await bridge.start(ids, withApp)); }, [bridge]);
  const retry = useCallback(async (id: string) => { if (bridge) setView(await bridge.retry(id)); }, [bridge]);
  const app = updater ? appPlan(updater) : survey?.app ?? null;
  return { available: Boolean(bridge), survey, view, app, appMessage: updater?.status === "error" ? updaterMessage(updater, { restart: false }) : undefined, checking, look, start, retry };
}
