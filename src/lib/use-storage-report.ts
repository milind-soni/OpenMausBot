// One copy of the storage answer for the page, shared by Settings → Storage and the sidebar's line. Only an owner or admin
// asks (the route is admin scope: a team's member gets nothing and sends nothing). A page whose server has no report (a
// person's own computer, an older Cloud, a refusal) is "none" and shows no Storage at all.
import { useEffect, useState } from "react";

import { api } from "@/state/api";
import { readStorageSeen, writeStorageSeen, type StorageAnswer, type StorageBand } from "./storage-report";

export const STORAGE_PATH = "/api/diagnostics/storage";
export const STORAGE_MEASURE_PATH = "/api/diagnostics/storage/measure";

export type StorageState =
  | { status: "unknown" }
  | { status: "none" }
  | { status: "ready"; answer: StorageAnswer; fetchedAt: number };

let state: StorageState = { status: "unknown" };
let loading: Promise<void> | null = null;
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
  loading ??= api<StorageAnswer>(STORAGE_PATH, { background })
    .then((answer) => set(answer?.storage ? { status: "ready", answer, fetchedAt: Date.now() } : { status: "none" }))
    .catch((error: unknown) => {
      const status = statusOf(error);
      // Refused, or a server without the route: there is no report here. Anything else (asleep, offline) keeps what was known.
      if (status === 403 || status === 404 || status === 401) set({ status: "none" });
    })
    .finally(() => { loading = null; });
  return loading;
}

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
  const [seen, setSeen] = useState<StorageState>(state);
  const running = seen.status === "ready" && seen.answer.storage?.running === true;
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setSeen);
    setSeen(state);
    const first = window.setTimeout(() => { if (delayMs === 0 || state.status === "unknown") void loadStorage(background); }, delayMs);
    return () => { listeners.delete(setSeen); window.clearTimeout(first); };
  }, [enabled, delayMs, background]);
  useEffect(() => {
    if (!enabled || !everyMs || (whileRunning && !running)) return;
    const timer = window.setInterval(() => { if (state.status !== "none") void loadStorage(background); }, everyMs);
    return () => window.clearInterval(timer);
  }, [enabled, everyMs, whileRunning, running, background]);
  return enabled ? seen : { status: "none" };
}

const seenListeners = new Set<(seen: StorageBand | null) => void>();

/** The fullest band the person has seen Storage at (opening Settings → Storage while there), kept on this device. */
export function useStorageSeen(): [StorageBand | null, (seen: StorageBand | null) => void] {
  const [seen, setSeen] = useState<StorageBand | null>(readStorageSeen);
  useEffect(() => {
    seenListeners.add(setSeen);
    return () => { seenListeners.delete(setSeen); };
  }, []);
  return [seen, rememberStorageSeen];
}

let shownThisLaunch: StorageBand | null = null;

/** The sidebar showed its line for `band`: from the next launch on that counts as seen, and this launch keeps showing it
 * until Storage is opened. */
export function markStorageNoticeShown(band: StorageBand): void {
  if (shownThisLaunch === band) return;
  shownThisLaunch = band;
  writeStorageSeen(band);
}
export const storageNoticeShownThisLaunch = (): StorageBand | null => shownThisLaunch;

export function rememberStorageSeen(seen: StorageBand | null): void {
  shownThisLaunch = null;
  writeStorageSeen(seen);
  for (const listener of seenListeners) listener(seen === "ok" ? null : seen);
}

/** Tests: forget the shared answer and what this launch showed, as a new launch would. */
export function forgetStorageReport(): void {
  state = { status: "unknown" };
  loading = null;
  shownThisLaunch = null;
}
