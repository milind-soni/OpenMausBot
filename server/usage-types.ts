/** Shared wire contract; this module has no Node dependencies. */
export type UsageStatus = "ok" | "low" | "exhausted" | "unknown";
export interface UsageWindow {
  id: string;
  label: string;
  remainingPercent: number | null;
  resetsAt: string | null;
  updatedAt?: string;
}
export interface EngineUsage {
  instanceId: string;
  status: UsageStatus;
  windows: UsageWindow[];
  source: "reported" | "inferred";
  updatedAt: string;
}
/** Consumed by scheduling/backup work. Never implies automatic retry is safe. */
export interface UsageLimitFailure {
  kind: "usage_limit";
  resetsAt?: string;
}
export interface UsagePatch {
  windows?: Array<Pick<UsageWindow, "id"> & Partial<Omit<UsageWindow, "id">>>;
  status?: UsageStatus;
  source: "reported" | "inferred";
  updatedAt?: string;
}
export interface UsageClassification {
  usage?: UsagePatch;
  failure?: UsageLimitFailure;
}
export interface UsagePreferences { show: boolean; hiddenInstances: string[] }
export const USAGE_STALE_MS = 15 * 60_000;
export const USAGE_REFRESH_MS = 5 * 60_000;
