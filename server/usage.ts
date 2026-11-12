import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "./json-file.ts";
import { USAGE_STALE_MS, type EngineUsage, type UsagePatch, type UsageWindow } from "./usage-types.ts";
export type { EngineUsage, UsageWindow, UsagePatch, UsageLimitFailure } from "./usage-types.ts";

export function usageStatus(windows: UsageWindow[]): EngineUsage["status"] {
  const values = windows.flatMap(w => w.remainingPercent === null ? [] : [w.remainingPercent]);
  if (!values.length) return "unknown";
  const tightest = Math.min(...values);
  return tightest <= 0 ? "exhausted" : tightest <= 40 ? "low" : "ok";
}

/** Sparse null/missing values never erase a known window. Older updates are ignored. */
export class UsageStore {
  private records = new Map<string, EngineUsage>();
  private file: string;
  private now: () => number;
  constructor(directory: string, now: () => number = Date.now) {
    this.now = now;
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, "usage.json");
    const rows = readJsonFile<unknown>(this.file, []);
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row && typeof row.instanceId === "string" && Array.isArray(row.windows) && Number.isFinite(Date.parse(row.updatedAt)) &&
        ["ok", "low", "exhausted", "unknown"].includes(row.status) && ["reported", "inferred"].includes(row.source)) {
        this.records.set(row.instanceId, { ...row, windows: row.windows.filter((w: unknown) => {
          if (!w || typeof w !== "object") return false;
          const window = w as UsageWindow;
          return typeof window.id === "string" && typeof window.label === "string" &&
            (window.remainingPercent === null || typeof window.remainingPercent === "number" && Number.isFinite(window.remainingPercent)) &&
            (window.resetsAt === null || typeof window.resetsAt === "string" && Number.isFinite(Date.parse(window.resetsAt)));
        }) });
      }
    }
  }
  merge(instanceId: string, patch: UsagePatch): EngineUsage {
    const old = this.records.get(instanceId);
    const at = patch.updatedAt ?? new Date(this.now()).toISOString();
    if (!Number.isFinite(Date.parse(at)) || (old && Date.parse(at) < Date.parse(old.updatedAt))) return this.get(instanceId);
    const windows = new Map((old?.windows ?? []).map(w => [w.id, { ...w }]));
    for (const update of patch.windows ?? []) {
      const w = windows.get(update.id) ?? { id: update.id, label: "Current allowance", remainingPercent: null, resetsAt: null };
      if (typeof update.label === "string") w.label = update.label;
      if (typeof update.remainingPercent === "number" && Number.isFinite(update.remainingPercent)) {
        w.remainingPercent = Math.max(0, Math.min(100, update.remainingPercent));
        w.updatedAt = at;
      }
      if (typeof update.resetsAt === "string" && Number.isFinite(Date.parse(update.resetsAt))) w.resetsAt = update.resetsAt;
      windows.set(w.id, w);
    }
    const merged: EngineUsage = {
      instanceId, windows: [...windows.values()], source: patch.source, updatedAt: at,
      status: patch.status ?? (old?.status === "exhausted" ? "exhausted" : usageStatus([...windows.values()])),
    };
    this.records.set(instanceId, merged);
    writeJsonAtomic(this.file, [...this.records.values()]);
    return this.get(instanceId);
  }
  get(instanceId: string): EngineUsage {
    const row = this.records.get(instanceId);
    if (!row) return { instanceId, status: "unknown", windows: [], source: "reported", updatedAt: "" };
    const stale = this.now() - Date.parse(row.updatedAt) > USAGE_STALE_MS;
    const windows = row.windows.map(w => ({ ...w, remainingPercent:
      row.status === "unknown" || stale || this.now() - Date.parse(w.updatedAt ?? row.updatedAt) > USAGE_STALE_MS ||
      (w.resetsAt !== null && Date.parse(w.resetsAt) <= this.now()) ? null : w.remainingPercent,
    }));
    return { ...row, windows, status: stale ? "unknown" : row.status === "exhausted" || row.status === "unknown" ? row.status : usageStatus(windows) };
  }
  list(instanceIds: string[]): EngineUsage[] { return instanceIds.map(id => this.get(id)); }
}
