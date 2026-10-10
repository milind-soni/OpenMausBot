import { useEffect, useRef, useState } from "react";
import type { CloudMoveBridge, CloudMoveOverview, CloudMoveState } from "../../electron/cloud-move.mjs";
import type { LocaleKey } from "@/locales";
import { activeLocale, t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

// Copy this computer here (electron/cloud-move.mjs, docs/copy-workspace.md):
// this computer's workspace to a server the person added, their Cloud
// included. It runs from Settings → Servers and Settings → OMB Cloud (this
// computer's own page names the server). A server's own page offers it (its
// card while empty, the Cloud's setup checklist, its Settings → Backups), and
// its Copy brings the person to that panel; only the verified Cloud's starts
// the copy itself. Every one reads main's snapshot through one mapping,
// moveView, and calls the bridge.

const RUNNING = new Set<CloudMoveState["phase"]>(["preparing", "growing", "exporting", "uploading", "checking", "replacing", "restarting"]);
// Until the destination starts replacing its workspace, a copy can still stop.
const CANCELLABLE = new Set<CloudMoveState["phase"]>(["preparing", "growing", "exporting", "uploading", "checking"]);
const PHASE: Record<string, LocaleKey> = {
  preparing: "cloudMove.phase.preparing", growing: "cloudMove.phase.growing", exporting: "cloudMove.phase.exporting", uploading: "cloudMove.phase.uploading",
  checking: "cloudMove.phase.checking", replacing: "cloudMove.phase.replacing", restarting: "cloudMove.phase.restarting",
};
// One vocabulary: a reason a copy cannot start (moveBlocked) and a failed
// copy's code share these, so each reads and acts the same wherever it shows.
const ERROR: Record<string, LocaleKey> = {
  busy: "cloudMove.error.busy", cloud_busy: "cloudMove.error.cloudBusy", too_large: "cloudMove.error.tooLarge",
  local_full: "cloudMove.error.localFull", upload_failed: "cloudMove.error.network", network: "cloudMove.error.network",
  access_changed: "cloudMove.error.accessChanged", cloud_unavailable: "cloudMove.error.cloudUnavailable",
  cancelled: "cloudMove.error.cancelled", no_previous: "cloudMove.error.noPrevious",
  owner_needed: "cloudMove.error.ownerNeeded", shared_workspace: "cloudMove.error.sharedWorkspace", same_computer: "cloudMove.error.sameComputer",
  not_empty: "cloudMove.error.notEmpty", unreachable: "cloudMove.error.unreachable", busy_elsewhere: "cloudMove.error.busyElsewhere",
};
// Nothing to try again here: the next step is somewhere else, or later.
const NO_RETRY = new Set(["shared_workspace", "same_computer", "not_empty", "cloud_grow_unsupported", "too_large", "busy_elsewhere"]);
// The next step is the server itself: open it in this window.
const OPEN = new Set(["restart_timeout", "owner_needed", "access_changed"]);
// The server has to change first (update, start): ask it again.
const CHECK = new Set(["outdated", "unreachable"]);

export const formatMoveBytes = (value: number) => {
  const power = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : 1;
  return `${new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: power === 3 ? 1 : 0 }).format(value / 1024 ** power)} ${["", "KB", "MB", "GB"][power]}`;
};

/** When the workspace Swap back puts back was saved. */
const savedAt = (iso: string) => new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

type Destination = NonNullable<CloudMoveState["destination"]>;
export type MoveActionKind = "start" | "cancel" | "open" | "check" | "dismiss";
/** One state of a copy, as every place shows it: one sentence, and one next step. */
export interface MoveView {
  /** What `{server}` reads as: the name in Settings → Servers ("My Cloud" for the Cloud). */
  server: string;
  running: boolean;
  message: { text: string; tone: "status" | "done" | "error" | "note" } | null;
  /** After a copy: what is not running there yet. */
  next: string[];
  action: { kind: MoveActionKind; label: string } | null;
  /** A stopped upload continues where it stopped. */
  resumable: boolean;
}

/** The person-facing sentence for a failed copy: what happened, and the next step. */
function errorText(error: NonNullable<CloudMoveState["error"]>, server: string, cloud: boolean): string {
  const needed = error.neededBytes;
  if (error.code === "cloud_full") {
    // More than the plan's whole disk: only a larger plan (or, on the largest, we) can take it.
    if (error.maxBytes !== undefined && needed !== undefined && needed > error.maxBytes) {
      return t(error.largest ? "cloudMove.error.planFullLargest" : "cloudMove.error.planFull", { needed: formatMoveBytes(needed), max: formatMoveBytes(error.maxBytes) });
    }
    // More than the Cloud's disk now, and the Admin does not say it can grow: removing files will not do it.
    if (cloud && error.maxBytes === undefined && error.volumeBytes !== undefined && needed !== undefined && needed > error.volumeBytes) {
      return t("cloudMove.error.growUnsupported", { needed: formatMoveBytes(needed) });
    }
    // The disk could hold it: what is already there is in the way.
    return error.freeBytes !== undefined && needed !== undefined
      ? t("cloudMove.error.cloudFull", { server, free: formatMoveBytes(error.freeBytes), needed: formatMoveBytes(needed) })
      : t("cloudMove.error.cloudFullPlain", { server });
  }
  // This Admin cannot grow the disk for a copy: no "try again".
  if (error.code === "cloud_grow_unsupported") {
    return needed !== undefined ? t("cloudMove.error.growUnsupported", { needed: formatMoveBytes(needed) }) : t("cloudMove.error.growUnsupportedPlain");
  }
  // It fits the plan's disk, which could not grow for it just now.
  if (error.code === "cloud_grow_unavailable") {
    return error.maxBytes !== undefined ? t("cloudMove.error.growUnavailable", { max: formatMoveBytes(error.maxBytes) }) : t("cloudMove.error.cloudFullPlain", { server });
  }
  if (error.code === "restore_failed") return t("cloudMove.error.notReplaced", { server, detail: error.message });
  if (error.code === "outdated") {
    if (cloud) return t("cloudMove.error.cloudOutdated");
    return error.destVersion && error.localVersion ? t("cloudMove.error.serverOutdated", { server, dest: error.destVersion, local: error.localVersion })
      : t("cloudMove.error.serverOutdatedPlain", { server });
  }
  if (error.code === "restart_timeout") return t(cloud ? "cloudMove.error.restartTimeout" : "cloudMove.error.restartTimeoutServer", { server });
  // A proxy in front of the server refused even the smallest part.
  if (error.code === "proxy_limit") return t("cloudMove.error.proxyLimit", { server, size: formatMoveBytes(error.partBytes ?? 512 * 1024) });
  const key = ERROR[error.code];
  return key ? t(key, { server, other: error.other || t("cloudMove.thisServer") }) : t("cloudMove.error.other", { detail: error.message });
}
/** A code's one next step: `failed`, after a copy that did not finish (it
 * can be tried again); otherwise a reason one cannot start yet. */
function actionFor(code: string, failed: boolean, server: string, resumable = false): MoveView["action"] {
  if (OPEN.has(code)) return { kind: "open", label: t("cloudMove.open", { server }) };
  if (NO_RETRY.has(code)) return null;
  if (CHECK.has(code)) return { kind: "check", label: t("cloudMove.check") };
  return failed ? { kind: "start", label: resumable ? t("cloudMove.resume") : t("cloudMove.retry") } : null;
}

/** Before a copy that cannot fit even at the plan's largest disk: say so now. */
function fitNote(overview: CloudMoveOverview | null, server: string, cloud: boolean): string | null {
  const fit = overview?.fit;
  if (fit?.fit !== "never") return null;
  return errorText({ code: "cloud_full", message: "", freeBytes: fit.freeBytes, neededBytes: fit.neededBytes,
    ...(fit.maxBytes ? { maxBytes: fit.maxBytes } : {}), ...(fit.largest ? { largest: true as const } : {}), ...(fit.volumeBytes ? { volumeBytes: fit.volumeBytes } : {}) }, server, cloud);
}

/** After a copy: what is not running yet there, and the phone. */
export function moveNextSteps(state: CloudMoveState): string[] {
  if (state.phase !== "done" || state.action === "restore") return [];
  const server = state.destination?.name || t("cloudMove.thisServer");
  return [...(state.routines ? [t("cloudMove.doneRoutines", { count: state.routines, server })] : []), t("cloudMove.donePhone", { server })];
}

/** The only state → view mapping. `overview` is main's snapshot about one
 * destination, `state` the copy's live state. `onServerPage`: shown on the
 * destination's own page, whose Copy opens this computer's Settings on it
 * (the verified Cloud's starts the copy, only while it is empty). */
export function moveView(overview: CloudMoveOverview | null, state: CloudMoveState, { onServerPage = false }: { onServerPage?: boolean } = {}): MoveView {
  const destination: Destination | null | undefined = overview?.destination ?? state.destination;
  const server = destination?.name || t("cloudMove.thisServer"), cloud = destination?.kind === "cloud";
  const view = (message: MoveView["message"], action: MoveView["action"], extra: Partial<MoveView> = {}): MoveView =>
    ({ server, running: false, message, next: [], action, resumable: false, ...extra });
  if (RUNNING.has(state.phase)) {
    const phase = state.action === "restore" && state.phase === "replacing" ? "cloudMove.phase.restoring" : PHASE[state.phase];
    return view(phase ? { text: t(phase, { server }), tone: "status" } : null,
      CANCELLABLE.has(state.phase) ? { kind: "cancel", label: t("cloudMove.cancel") } : null, { running: true });
  }
  if (state.phase === "done") {
    const text = state.action === "restore" ? t("cloudMove.restored", { server }) : t("cloudMove.done", { server, bots: state.moved?.bots ?? 0, chats: state.moved?.chats ?? 0 });
    return view({ text, tone: "done" }, { kind: "dismiss", label: t("cloudMove.ok") }, { next: moveNextSteps(state) });
  }
  if (state.phase === "failed" && state.error) {
    const resumable = state.resumable === true;
    return view({ text: errorText(state.error, server, cloud), tone: "error" }, actionFor(state.error.code, true, server, resumable), { resumable });
  }
  // Nothing under way: why it cannot start (the same words and step as a
  // copy that failed for that reason), or the one way it can.
  const blocked = overview?.blocked;
  if (blocked) {
    const reason = { code: blocked, message: "", destVersion: overview?.cloud?.appVersion ?? undefined, localVersion: overview?.local?.appVersion ?? undefined, other: overview?.busyWith };
    return view({ text: errorText(reason, server, cloud), tone: "note" }, actionFor(blocked, false, server));
  }
  const note = fitNote(overview, server, cloud);
  if (note) return view({ text: note, tone: "note" }, null);
  const has = overview?.cloud && !overview.cloud.empty, previous = overview?.cloud?.previous;
  // On a server's own page, Copy opens this computer's Settings on that server
  // (main), where Replace is; only the verified Cloud copies from its own
  // page, and only while it is empty.
  if (onServerPage && has && cloud) return view({ text: t("cloudMove.error.notEmpty", { server }), tone: "note" }, null);
  // Swap back keeps one workspace: copying again deletes the one it keeps now.
  const label = onServerPage ? t("cloudMove.suggest.move") : previous ? t("cloudMove.replaceAgain", { server, date: savedAt(previous.createdAt) })
    : has ? t("cloudMove.replace", { server }) : t("cloudMove.start", { server });
  return view(null, { kind: "start", label });
}

/** Main's snapshot about one destination (`destination`: a saved server's id,
 * or "cloud", from this computer's own page only), kept current by its state
 * events. With no bridge it asks nothing (a browser, or a view that does not
 * need it yet). A copy to another server is not this one's to show. */
export function useCloudMove(bridge: CloudMoveBridge | undefined, destination?: string) {
  const [overview, setOverview] = useState<CloudMoveOverview | null>(null);
  const [live, setLive] = useState<CloudMoveState | null>(null);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const known = useRef<string | null>(null);
  const load = () => {
    const current = generation.current;
    void bridge?.state(destination).then(next => {
      if (generation.current !== current) return;
      known.current = next.destination?.origin ?? null;
      setOverview(next);
    }).catch(() => {});
  };
  useEffect(() => {
    if (!bridge) return;
    const current = ++generation.current;
    const unsubscribe = bridge.onState(next => {
      if (generation.current !== current) return;
      const finished = next.phase === "done" || next.phase === "failed";
      if (next.destination && next.destination.origin !== known.current) {
        // Another server's copy ended: this one may start now.
        if (finished) load();
        return;
      }
      setLive(next);
      // A finished copy changes what the server holds: ask again.
      if (finished) load();
    });
    load();
    return () => { generation.current++; unsubscribe(); };
  }, [bridge, destination]);
  const act = (action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    void action().catch(() => load()).finally(() => setPending(false));
  };
  const state: CloudMoveState = live ?? overview ?? { phase: "idle" };
  /** Run the view's next step. */
  const run = (kind: MoveActionKind) => {
    if (!bridge) return;
    if (kind === "start") act(() => bridge.start(destination));
    else if (kind === "cancel") act(() => bridge.cancel());
    else if (kind === "dismiss") act(() => bridge.dismiss(destination).then(next => { setLive(null); setOverview(next); }));
    else if (kind === "check") load();
    else {
      // Open the server in this window: from this computer's Settings, switch
      // to it; on its own page, load it again.
      const id = overview?.destination?.id;
      if (destination && id) act(() => window.ogb?.environments?.switch(id) ?? Promise.resolve());
      else window.location.reload();
    }
  };
  return { overview, state, pending, act, load, run, destination };
}

export type CloudMoveHandle = ReturnType<typeof useCloudMove>;

function MoveProgress({ state }: { state: CloudMoveState }) {
  const progress = state.progress;
  if (!progress || progress.totalBytes <= 0 || (state.phase !== "uploading" && state.phase !== "exporting")) return null;
  return <>
    <progress className="w-full accent-accent" max={progress.totalBytes} value={Math.min(progress.bytesTransferred, progress.totalBytes)} aria-label={t("cloudMove.progress")} />
    <span className="text-[13px] text-ink-secondary">{t("cloudMove.transferred", { done: formatMoveBytes(progress.bytesTransferred), total: formatMoveBytes(progress.totalBytes) })}</span>
  </>;
}

/** The view's sentence, the copy's progress, and what comes next. */
function moveStatus(view: MoveView, state: CloudMoveState) {
  const message = view.message;
  return <>
    {message && <p role={message.tone === "error" ? "alert" : message.tone === "note" ? "note" : "status"}
      className={message.tone === "error" ? "text-[13px] text-danger" : message.tone === "status" ? "text-[13px] text-ink-secondary" : "text-[13px] text-ink"}>{message.text}</p>}
    {view.running && <MoveProgress state={state} />}
    {view.next.map(line => <p key={line} className="text-[12px] text-ink-secondary">{line}</p>)}
    {view.resumable && <p className="text-[12px] text-ink-secondary">{t("cloudMove.resumeNote", { server: view.server })}</p>}
  </>;
}

/** The view's one next step, as a button. */
function moveButton(view: MoveView, move: CloudMoveHandle, onStart?: () => void) {
  const action = view.action;
  if (!action) return null;
  return <button type="button" disabled={move.pending && action.kind !== "cancel"} className="ui-button"
    onClick={() => { if (action.kind === "start") onStart?.(); move.run(action.kind); }}>{action.label}</button>;
}

/** Settings → Servers (a saved server's id) and Settings → OMB Cloud ("cloud"). */
export function CloudMoveSettings({ destination, onClose }: { destination: string; onClose?: () => void }) {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudMove;
  const move = useCloudMove(bridge, destination);
  if (!bridge) return null;
  const { overview, state, pending } = move;
  const view = moveView(overview, state);
  const local = overview?.local, cloud = overview?.cloud, previous = cloud?.previous;
  const idle = !view.running && state.phase !== "done";
  const date = previous ? savedAt(previous.createdAt) : "";
  const ready = idle && !overview?.blocked;
  return <Card title={t("cloudMove.title")} subtitle={t("cloudMove.intro", { server: view.server })}>
    <div data-cloud-move={state.phase} className="flex flex-col items-start gap-3">
      <p className="text-[13px] text-ink">{local
        ? t("cloudMove.size", { size: formatMoveBytes(local.bytes), bots: local.bots, chats: local.chats, rooms: local.rooms })
        : t("cloudMove.measuring")}</p>
      <p className="text-[12px] text-ink-secondary">{t("cloudMove.signIn", { server: view.server })}</p>
      {ready && cloud && (previous || !cloud.empty) && <p role="note" className="text-[13px] text-ink">{previous
        // Swap back keeps one workspace: this copy's backup takes the place of the one it keeps now.
        ? t("cloudMove.replaceWarningPrevious", { server: view.server, bots: cloud.contents.bots, chats: cloud.contents.chats, date })
        : t("cloudMove.replaceWarning", { server: view.server, bots: cloud.contents.bots, chats: cloud.contents.chats })}</p>}
      {ready && !cloud && <p className="text-[12px] text-ink-secondary">{t("cloudMove.replaceMaybe", { server: view.server })}</p>}
      {moveStatus(view, state)}
      <div className="flex flex-wrap gap-2">
        {moveButton(view, move)}
        {ready && previous && <button type="button" disabled={pending} className="ui-button" onClick={() => move.act(() => bridge.restorePrevious(destination))}>{t("cloudMove.restorePrevious", { server: view.server })}</button>}
        {onClose && !view.running && <button type="button" className="ui-button" onClick={onClose}>{t("cloudMove.close")}</button>}
      </div>
      {ready && previous && <p className="text-[12px] text-ink-secondary">{t("cloudMove.previous", { server: view.server, date, bots: previous.bots, chats: previous.chats, size: formatMoveBytes(previous.bytes ?? 0) })}</p>}
    </div>
  </Card>;
}

/** The offer on a server's own page, shared by its card, the Cloud's setup
 * checklist and its Settings → Backups: what comes and its size, that
 * sign-ins stay here, the one next step (and Not now where it is an offer),
 * then the copy's progress or what happened. Its Copy opens this computer's
 * Settings on this server, where the person starts the copy (main; the
 * verified Cloud's starts it). Called as a function so each keeps one element tree. */
export function cloudMoveOffer(move: CloudMoveHandle, on: { start?: () => void; notNow?: () => void } = {}) {
  const { overview, state, pending } = move;
  const view = moveView(overview, state, { onServerPage: true });
  const local = overview?.local;
  const offering = !view.running && state.phase === "idle" && !view.message;
  return <div className="flex flex-col items-start gap-1.5">
    {offering && <p className="text-[13px] text-ink-secondary">{local && overview?.cloud?.empty
      ? t("cloudMove.suggest.body", { server: view.server, bots: local.bots, chats: local.chats, size: formatMoveBytes(local.bytes) })
      : t("cloudMove.intro", { server: view.server })}</p>}
    {offering && <p className="text-[12px] text-ink-secondary">{t("cloudMove.signIn", { server: view.server })}</p>}
    {moveStatus(view, state)}
    <div className="mt-1.5 flex flex-wrap gap-2">
      {moveButton(view, move, on.start)}
      {on.notNow && offering && <button type="button" disabled={pending} className="ui-button" onClick={() => { on.notNow!(); move.run("dismiss"); }}>{t("cloudMove.suggest.notNow")}</button>}
    </div>
  </div>;
}

/** On a server's own page, the first time it is empty: bring this
 * computer's bots and chats. Not blocking; Not now hides it for good. After
 * a copy it says what came and what is not running there yet, until Done.
 * While the Cloud's setup checklist is up, the offer is one of its steps instead. */
export function CloudMoveSuggestion() {
  const bridge = window.ogb?.cloudMove;
  const move = useCloudMove(bridge);
  const [started, setStarted] = useState(false), [hidden, setHidden] = useState(false);
  const finished = move.overview?.destination && move.state.phase === "done";
  if (!bridge || hidden || !(move.overview?.suggest || started || finished)) return null;
  const title = window.ogb?.platform === "darwin" ? t("cloudMove.suggest.titleMac") : t("cloudMove.suggest.title");
  return <aside aria-label={title} data-cloud-move-suggestion={move.state.phase} className="fixed bottom-4 right-4 z-40 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-hairline/40 bg-card p-4 shadow-lg">
    <p className="mb-1 text-[14px] font-medium text-ink">{title}</p>
    {cloudMoveOffer(move, { start: () => setStarted(true), notNow: () => setHidden(true) })}
  </aside>;
}

/** Settings → Backups on a server open in the desktop app: Import from this
 * computer, beside importing a file. The same copy as the offer; hidden where
 * it cannot happen (a browser, this computer's own server, a server shared
 * with other people). */
export function CloudMoveImport() {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudMove;
  const move = useCloudMove(bridge);
  const blocked = move.overview?.blocked;
  if (!bridge || !move.overview?.destination || blocked === "shared_workspace" || blocked === "same_computer") return null;
  return <Card title={t("backup.fromComputer")} subtitle={t("backup.fromComputerHint")}>
    <div data-cloud-move-import={move.state.phase}>{cloudMoveOffer(move)}</div>
  </Card>;
}
