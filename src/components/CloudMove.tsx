import { useEffect, useRef, useState } from "react";
import type { CloudMoveBridge, CloudMoveOverview, CloudMoveState } from "../../electron/cloud-move.mjs";
import type { LocaleKey } from "@/locales";
import { activeLocale, t } from "@/lib/i18n";
import { Card } from "./SettingsPrimitives";

// Move to Cloud (electron/cloud-move.mjs, docs/cloud-pro.md): the action in
// Settings → OMB Cloud, and the one-time card on an empty Cloud's own page.
// Both only read main's snapshot and call its argument-free bridge.

const RUNNING = new Set<CloudMoveState["phase"]>(["preparing", "exporting", "uploading", "checking", "replacing", "restarting"]);
// Until the Cloud starts replacing its workspace, a move can still stop.
const CANCELLABLE = new Set<CloudMoveState["phase"]>(["preparing", "exporting", "uploading", "checking"]);
const PHASE: Record<string, LocaleKey> = {
  preparing: "cloudMove.phase.preparing", exporting: "cloudMove.phase.exporting", uploading: "cloudMove.phase.uploading",
  checking: "cloudMove.phase.checking", replacing: "cloudMove.phase.replacing", restarting: "cloudMove.phase.restarting",
};
const ERROR: Record<string, LocaleKey> = {
  busy: "cloudMove.error.busy", cloud_busy: "cloudMove.error.cloudBusy", too_large: "cloudMove.error.tooLarge",
  local_full: "cloudMove.error.localFull", upload_failed: "cloudMove.error.network", network: "cloudMove.error.network",
  access_changed: "cloudMove.error.accessChanged", cloud_unavailable: "cloudMove.error.cloudUnavailable",
  cancelled: "cloudMove.error.cancelled", restart_timeout: "cloudMove.error.restartTimeout", no_previous: "cloudMove.error.noPrevious",
  cloud_outdated: "cloudMove.error.cloudOutdated",
};

export const formatMoveBytes = (value: number) => {
  const power = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : 1;
  return `${new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: power === 3 ? 1 : 0 }).format(value / 1024 ** power)} ${["", "KB", "MB", "GB"][power]}`;
};

/** The person-facing sentence for a failed move. */
export function cloudMoveErrorText(error: CloudMoveState["error"]): string {
  if (!error) return "";
  if (error.code === "cloud_full") {
    return error.freeBytes !== undefined && error.neededBytes !== undefined
      ? t("cloudMove.error.cloudFull", { free: formatMoveBytes(error.freeBytes), needed: formatMoveBytes(error.neededBytes) })
      : t("cloudMove.error.cloudFullPlain");
  }
  if (error.code === "restore_failed") return t("cloudMove.error.notReplaced", { detail: error.message });
  const key = ERROR[error.code];
  return key ? t(key) : t("cloudMove.error.other", { detail: error.message });
}

/** Main's snapshot, kept current by its state events. With no bridge it
 * asks nothing (a browser, or a view that does not need it yet). */
export function useCloudMove(bridge: CloudMoveBridge | undefined) {
  const [overview, setOverview] = useState<CloudMoveOverview | null>(null);
  const [live, setLive] = useState<CloudMoveState | null>(null);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const load = () => {
    const current = generation.current;
    void bridge?.state().then(next => { if (generation.current === current) setOverview(next); }).catch(() => {});
  };
  useEffect(() => {
    if (!bridge) return;
    const current = ++generation.current;
    const unsubscribe = bridge.onState(next => {
      if (generation.current !== current) return;
      setLive(next);
      // A finished move changes what the Cloud holds: ask again.
      if (next.phase === "done" || next.phase === "failed") load();
    });
    load();
    return () => { generation.current++; unsubscribe(); };
  }, [bridge]);
  const act = (action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    void action().catch(() => load()).finally(() => setPending(false));
  };
  const state: CloudMoveState = live ?? overview ?? { phase: "idle" };
  return { overview, state, pending, act, load };
}

function MoveProgress({ state }: { state: CloudMoveState }) {
  const progress = state.progress;
  const phase = state.action === "restore" && state.phase === "replacing" ? "cloudMove.phase.restoring" : PHASE[state.phase];
  return <div role="status" className="flex w-full flex-col gap-1 text-[13px] text-ink-secondary">
    <span>{phase ? t(phase) : null}</span>
    {progress && progress.totalBytes > 0 && (state.phase === "uploading" || state.phase === "exporting") && <>
      <progress className="w-full accent-accent" max={progress.totalBytes} value={Math.min(progress.bytesTransferred, progress.totalBytes)} aria-label={t("cloudMove.progress")} />
      <span>{t("cloudMove.transferred", { done: formatMoveBytes(progress.bytesTransferred), total: formatMoveBytes(progress.totalBytes) })}</span>
    </>}
  </div>;
}

function outcome(state: CloudMoveState): string | null {
  if (state.phase === "done") {
    return state.action === "restore" ? t("cloudMove.restored")
      : t("cloudMove.done", { bots: state.moved?.bots ?? 0, chats: state.moved?.chats ?? 0 });
  }
  return null;
}

/** Settings → OMB Cloud, below "Your Cloud" once it is Ready. */
export function CloudMoveSettings() {
  const bridge = window.ogb?.remoteClient?.active ? undefined : window.ogb?.cloudMove;
  const { overview, state, pending, act } = useCloudMove(bridge);
  if (!bridge) return null;
  const running = RUNNING.has(state.phase);
  const local = overview?.local, cloud = overview?.cloud;
  const previous = cloud?.previous;
  const done = outcome(state);
  const date = previous ? new Intl.DateTimeFormat(activeLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(previous.createdAt)) : "";
  return <Card title={t("cloudMove.title")} subtitle={t("cloudMove.intro")}>
    <div data-cloud-move={state.phase} className="flex flex-col items-start gap-3">
      <p className="text-[13px] text-ink">{local
        ? t("cloudMove.size", { size: formatMoveBytes(local.bytes), bots: local.bots, chats: local.chats, rooms: local.rooms })
        : t("cloudMove.measuring")}</p>
      <p className="text-[12px] text-ink-secondary">{t("cloudMove.signIn")}</p>
      {!running && cloud && !cloud.empty && <p role="note" className="text-[13px] text-ink">{t("cloudMove.replaceWarning", { bots: cloud.contents.bots, chats: cloud.contents.chats })}</p>}
      {!running && !cloud && <p className="text-[12px] text-ink-secondary">{t("cloudMove.replaceMaybe")}</p>}
      {running && <MoveProgress state={state} />}
      {done && <p role="status" className="text-[13px] text-ink">{done}</p>}
      {state.phase === "failed" && <p role="alert" className="text-[13px] text-danger">{cloudMoveErrorText(state.error)}</p>}
      {state.phase === "failed" && state.resumable && <p className="text-[12px] text-ink-secondary">{t("cloudMove.resumeNote")}</p>}
      <div className="flex flex-wrap gap-2">
        {!running && <button type="button" disabled={pending} className="ui-button" onClick={() => act(() => bridge.start())}>
          {state.phase === "failed" && state.resumable ? t("cloudMove.resume") : cloud && !cloud.empty ? t("cloudMove.replace") : t("cloudMove.start")}
        </button>}
        {CANCELLABLE.has(state.phase) && <button type="button" className="ui-button" onClick={() => act(() => bridge.cancel())}>{t("cloudMove.cancel")}</button>}
        {!running && previous && <button type="button" disabled={pending} className="ui-button" onClick={() => act(() => bridge.restorePrevious())}>{t("cloudMove.restorePrevious")}</button>}
      </div>
      {!running && previous && <p className="text-[12px] text-ink-secondary">{t("cloudMove.previous", { date, bots: previous.bots, chats: previous.chats, size: formatMoveBytes(previous.bytes ?? 0) })}</p>}
    </div>
  </Card>;
}

export type CloudMoveHandle = ReturnType<typeof useCloudMove>;

/** The offer itself, shared by the card below and the Cloud's setup
 * checklist: what moves and its size, that sign-ins stay here, Move and
 * Not now, then the move's progress or error. Called as a function so both
 * keep one element tree. */
export function cloudMoveOffer(bridge: CloudMoveBridge, move: CloudMoveHandle, on: { start: () => void; notNow: () => void }) {
  const { overview, state, pending, act, load } = move;
  const running = RUNNING.has(state.phase);
  const local = overview?.local;
  return <>
    {!running && state.phase !== "failed" && <p className="mt-1 text-[13px] text-ink-secondary">{local
      ? t("cloudMove.suggest.body", { bots: local.bots, chats: local.chats, size: formatMoveBytes(local.bytes) })
      : t("cloudMove.intro")}</p>}
    {!running && <p className="mt-1 text-[12px] text-ink-secondary">{t("cloudMove.signIn")}</p>}
    {running && <div className="mt-2"><MoveProgress state={state} /></div>}
    {state.phase === "failed" && <p role="alert" className="mt-2 text-[13px] text-danger">{cloudMoveErrorText(state.error)}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {!running && <button type="button" disabled={pending} className="ui-button" onClick={() => { on.start(); act(() => bridge.start()); }}>
        {state.phase === "failed" && state.resumable ? t("cloudMove.resume") : t("cloudMove.suggest.move")}
      </button>}
      {!running && <button type="button" disabled={pending} className="ui-button" onClick={() => { on.notNow(); act(() => bridge.dismiss().then(load)); }}>{t("cloudMove.suggest.notNow")}</button>}
      {CANCELLABLE.has(state.phase) && <button type="button" className="ui-button" onClick={() => act(() => bridge.cancel())}>{t("cloudMove.cancel")}</button>}
    </div>
  </>;
}

/** On the person's own Cloud, the first time it is empty: bring this
 * computer's bots and chats. Not blocking; Not now hides it for good. While
 * the Cloud's setup checklist is up, the offer is one of its steps instead. */
export function CloudMoveSuggestion() {
  const bridge = window.ogb?.cloudMove;
  const move = useCloudMove(bridge);
  const [started, setStarted] = useState(false), [hidden, setHidden] = useState(false);
  if (!bridge || hidden || !(move.overview?.suggest || started)) return null;
  const title = window.ogb?.platform === "darwin" ? t("cloudMove.suggest.titleMac") : t("cloudMove.suggest.title");
  return <aside aria-label={title} data-cloud-move-suggestion={move.state.phase} className="fixed bottom-4 right-4 z-40 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-hairline/40 bg-card p-4 shadow-lg">
    <p className="text-[14px] font-medium text-ink">{title}</p>
    {cloudMoveOffer(bridge, move, { start: () => setStarted(true), notNow: () => setHidden(true) })}
  </aside>;
}
