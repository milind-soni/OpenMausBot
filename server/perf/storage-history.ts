// Each completed storage pass's bytes per category (disk-usage.ts), kept so the diagnose read (server/cloud-diagnose.ts) can
// say what grew in the last day and week. A pass ends about every 6 hours, so HISTORY_CAP passes span about two weeks. Saved
// to <data>/cache/storage-history.json (rebuildable: losing it only means "unknown" for a while). Category names and numbers only.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { STORAGE_CATEGORIES, type StorageCategory } from "./disk-categories.ts";
import type { StorageReport } from "./disk-usage.ts";

export const STORAGE_HISTORY_FILE = join("cache", "storage-history.json");
export const HISTORY_CAP = 60;
const DAY_MS = 86_400_000;

export interface HistoryPoint { at: number; bytes: Partial<Record<StorageCategory, number>> }
export interface Growth { since: number; rows: Array<{ name: StorageCategory; bytes: number }> }

const known = (name: string): name is StorageCategory => Object.hasOwn(STORAGE_CATEGORIES, name);
const pointsFrom = (value: unknown): HistoryPoint[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const at = (row as { at?: unknown })?.at, bytes = (row as { bytes?: unknown })?.bytes;
    if (typeof at !== "number" || !Number.isFinite(at) || !bytes || typeof bytes !== "object") return [];
    const kept: HistoryPoint["bytes"] = {};
    for (const [name, value] of Object.entries(bytes)) if (known(name) && typeof value === "number" && Number.isFinite(value) && value >= 0) kept[name] = value;
    return [{ at, bytes: kept }];
  }).sort((a, b) => a.at - b.at).slice(-HISTORY_CAP);
};

export function createStorageHistory(options: { dataDir: string } | { file: null }) {
  const file = "dataDir" in options ? join(options.dataDir, STORAGE_HISTORY_FILE) : null;
  let points: HistoryPoint[] | null = null;
  const load = (): HistoryPoint[] => {
    if (points) return points;
    try { points = file ? pointsFrom(JSON.parse(readFileSync(file, "utf8"))) : []; } catch { points = []; }
    return points;
  };
  return {
    /** Records a pass not seen yet (by its end time). A failed pass's figures are the one before's: not recorded again. */
    note(report: StorageReport | null | undefined) {
      if (!report || report.at === null || report.failed) return;
      const list = load();
      if (list.some((point) => point.at === report.at)) return;
      const bytes: HistoryPoint["bytes"] = {};
      for (const row of report.categories) bytes[row.name] = row.bytes;
      list.push({ at: report.at, bytes });
      list.sort((a, b) => a.at - b.at);
      while (list.length > HISTORY_CAP) list.shift();
      if (!file) return;
      try { mkdirSync(dirname(file), { recursive: true }); writeFileAtomic(file, JSON.stringify(list)); } catch { /* the next pass tries again */ }
    },
    points: (): readonly HistoryPoint[] => load(),
    /** Growth over the last `windowMs` (24 h, 7 days) from the newest pass back to the newest one at least that old; null until
     * the history reaches that far. Largest growth first; only categories that grew. */
    growth(windowMs: number): Growth | null {
      const list = load(), last = list.at(-1);
      if (!last) return null;
      const base = [...list].reverse().find((point) => point.at <= last.at - windowMs);
      if (!base) return null;
      const names = new Set([...Object.keys(last.bytes), ...Object.keys(base.bytes)].filter(known));
      const rows = [...names].map((name) => ({ name, bytes: (last.bytes[name] ?? 0) - (base.bytes[name] ?? 0) })).filter((row) => row.bytes > 0).sort((a, b) => b.bytes - a.bytes);
      return { since: base.at, rows };
    },
  };
}
export type StorageHistory = ReturnType<typeof createStorageHistory>;
export const DIAGNOSE_GROWTH_WINDOWS = { h24: DAY_MS, d7: 7 * DAY_MS } as const;
