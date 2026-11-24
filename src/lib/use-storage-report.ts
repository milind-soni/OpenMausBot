// One copy of the storage answer for the page, shared by Settings → Storage and the sidebar's line. Only an owner or admin
// asks (the route is admin scope: a team's member gets nothing and sends nothing). A page whose server has no report (a
// person's own computer, an older Cloud, a refusal) is "none" and shows no Storage at all.
import { useEffect, useState } from "react";

import { api } from "@/state/api";
import { readStorageSeen, writeStorageSeen, type StorageAnswer, type StorageBand } from "./storage-report";

/** The page this answer was read for: a page talks to one server, and an answer read for another origin is never shown. */
const pageOrigin = (): string => { try { return globalThis.location?.origin ?? ""; } catch { return ""; } };

export const STORAGE_PATH = "/api/diagnostics/storage";
export const STORAGE_MEASURE_PATH = "/api/diagnostics/storage/measure";

export type StorageState =
  | { status: "unknown" }
  | { status: "none" }
  | { status: "ready"; answer: StorageAnswer; fetchedAt: number };

let state: StorageState = { status: "unknown" };
/** The origin `state` was read on. */
let stateOrigin = pageOrigin();
let loading: Promise<void> | null = null;
/** Bumped by forgetStorageReport: an answer to a read from before it is dropped. */
let generation = 0;
const listeners = new Set<(next: StorageState) => void>();

function set(next: StorageState): void {
  state = next;
  for (const listener of listeners) listener(next);
}

function statusOf(error: unknown): number | null {
  return typeof error === "object" && error !== null && typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : null;
}

/** Reads the answer again. `background`: a poll nobody asked for, which never wakes a sleeping Cloud. */
export function loadStorage(background: boolean): Promise<void> {
  if (loading) return loading;
  const asked = generation, origin = pageOrigin();
  const current = () => asked === generation && origin === pageOrigin();
  const settle = (next: StorageState) => { if (!current()) return; stateOrigin = origin; set(next); };
  const read: Promise<void> = api<StorageAnswer>(STORAGE_PATH, { background })
    .then((answer) => settle(answer?.storage ? { status: "ready", answer, fetchedAt: Date.now() } : { status: "none" }))
    .catch((error: unknown) => {
      const status = statusOf(error);
      // Refused, or a server without the route: there is no report here. Anything else (asleep, offline) keeps what was known.
      if (status === 403 || status === 404 || status === 401) settle({ status: "none" });
    })
    .finally(() => { if (loading === read) loading = null; });
  loading = read;
  return read;
}

/** The shared answer, unless it was read for another page's server. */
const known = (): StorageState => (stateOrigin === pageOrigin() ? state : { status: "unknown" });

/** "Measure again": true when the server started a pass. */
export async function measureStorage(): Promise<boolean> {
  try {
    const answer = await api<{ started: boolean }>(STORAGE_MEASURE_PATH, { method: "POST" });
    await loadStorage(false);
    return answer.started === true;
  } catch {
    return false;
  }
}

export interface StorageReadOptions {
  /** Only an owner or admin, never a paired client: false sends nothing and reads "none". */
  enabled: boolean;
  /** Wait this long before the first read (the sidebar, so the launch isn't held up). */
  delayMs?: number;
  /** Read again this often while mounted; `whileRunning` only while a pass runs. */
  everyMs?: number;
  whileRunning?: boolean;
  background?: boolean;
}

export function useStorageReport(options: StorageReadOptions): StorageState {
  const { enabled, delayMs = 0, everyMs, whileRunning = false, background = false } = options;
  const [seen, setSeen] = useState<StorageState>(known);
  const running = seen.status === "ready" && seen.answer.storage?.running === true;
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setSeen);
    setSeen(known());
    const first = window.setTimeout(() => { if (delayMs === 0 || known().status === "unknown") void loadStorage(background); }, delayMs);
    return () => { listeners.delete(setSeen); window.clearTimeout(first); };
  }, [enabled, delayMs, background]);
  useEffect(() => {
    if (!enabled || !everyMs || (whileRunning && !running)) return;
    const timer = window.setInterval(() => { if (state.status !== "none") void loadStorage(background); }, everyMs);
    return () => window.clearInterval(timer);
  }, [enabled, everyMs, whileRunning, running, background]);
  return enabled ? seen : { status: "none" };
}

const seenListeners = new Set<(scope: string, seen: StorageBand | null) => void>();

/** The fullest band the person has seen Storage at on this Cloud (`scope`, storageScope; opening Settings → Storage while
 * there), kept on this device. Null scope (no answer yet): nothing seen. */
export function useStorageSeen(scope: string | null): StorageBand | null {
  const [seen, setSeen] = useState<{ scope: string | null; seen: StorageBand | null }>(() => ({ scope, seen: scope === null ? null : readStorageSeen(scope) }));
  useEffect(() => {
    setSeen({ scope, seen: scope === null ? null : readStorageSeen(scope) });
    if (scope === null) return;
    const listener = (changed: string, next: StorageBand | null) => { if (changed === scope) setSeen({ scope, seen: next }); };
    seenListeners.add(listener);
    return () => { seenListeners.delete(listener); };
  }, [scope]);
  return seen.scope === scope ? seen.seen : scope === null ? null : readStorageSeen(scope);
}

let shownThisLaunch: { scope: string; band: StorageBand } | null = null;

/** The sidebar showed its line for `band` on this Cloud: from the next launch on that counts as seen, and this launch
 * keeps showing it until Storage is opened. */
export function markStorageNoticeShown(scope: string, band: StorageBand): void {
  if (shownThisLaunch?.scope === scope && shownThisLaunch.band === band) return;
  shownThisLaunch = { scope, band };
  writeStorageSeen(scope, band);
}
export const storageNoticeShownThisLaunch = (scope: string): StorageBand | null => (shownThisLaunch?.scope === scope ? shownThisLaunch.band : null);

export function rememberStorageSeen(scope: string, seen: StorageBand | null): void {
  if (shownThisLaunch?.scope === scope) shownThisLaunch = null;
  writeStorageSeen(scope, seen);
  for (const listener of seenListeners) listener(scope, seen === "ok" ? null : seen);
}

/** Forget the shared answer and what this launch showed, as a new launch would. Tests use it; the app needs no call: a switch
 * to another Cloud loads a new page, and the seen mark is kept per server either way. */
export function forgetStorageReport(): void {
  stateOrigin = pageOrigin();
  loading = null;
  generation += 1;
  shownThisLaunch = null;
  set({ status: "unknown" });
}
