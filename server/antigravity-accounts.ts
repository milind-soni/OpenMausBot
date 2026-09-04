import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execCliTree } from "./procs.ts";

export type AntigravityProfile = "a" | "b";

export interface QuotaWindow {
  remaining: number;
  resetsAt: string | null;
}

export interface AntigravityQuota {
  gemini: {
    weekly: QuotaWindow | null;
    fiveHour: QuotaWindow | null;
  };
  other: {
    weekly: QuotaWindow | null;
    fiveHour: QuotaWindow | null;
  };
}

export interface AntigravityAccountStatus {
  profile: AntigravityProfile;
  instanceId: string;
  label: string;
  email: string;
  active: boolean;
  available: boolean;
  quota: AntigravityQuota;
  quotaStale?: boolean;
  error?: string;
}

export const ANTIGRAVITY_WORKER_A_INSTANCE_ID = "antigravity_worker_a";
export const ANTIGRAVITY_WORKER_B_INSTANCE_ID = "antigravity_worker_b";

export const PROFILES = {
  a: {
    instanceId: ANTIGRAVITY_WORKER_A_INSTANCE_ID,
    label: "Antigravity Worker A",
  },
  b: {
    instanceId: ANTIGRAVITY_WORKER_B_INSTANCE_ID,
    label: "Antigravity Worker B",
  },
} as const;

export const QUOTA_PROBE_ARGS = ["--print", "/usage", "--output-format", "json"] as const;

export function profileForInstance(instanceId: string): AntigravityProfile | null {
  if (instanceId === PROFILES.a.instanceId || instanceId === "antigravity-worker-a") return "a";
  if (instanceId === PROFILES.b.instanceId || instanceId === "antigravity-worker-b") return "b";
  return null;
}

export function instanceForProfile(profile: AntigravityProfile): string {
  return PROFILES[profile].instanceId;
}

export function getOpenMausDir(): string {
  const base = process.env.USERPROFILE || process.env.HOME || tmpdir();
  return join(base, ".openmausbot");
}

export function getAntigravityProfileDir(profile: AntigravityProfile): string {
  return join(getOpenMausDir(), "antigravity-profiles", "worker-" + profile);
}

export function ensureAntigravityProfileDir(profile: AntigravityProfile): string {
  const dir = getAntigravityProfileDir(profile);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getAntigravityProfileEnv(
  profile: AntigravityProfile,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const profileDir = getAntigravityProfileDir(profile);
  return {
    ...baseEnv,
    USERPROFILE: profileDir,
    HOME: profileDir,
  };
}

export function getAntigravityAccountLabelsPath(): string {
  return join(getOpenMausDir(), "antigravity-account-labels.json");
}

export function readAntigravityAccountLabels(): Record<string, string> {
  try {
    const filePath = getAntigravityAccountLabelsPath();
    if (!existsSync(filePath)) return {};
    const content = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          result[key] = value;
        }
      }
      return result;
    }
  } catch {
    // Missing or invalid JSON
  }
  return {};
}

export function writeAntigravityAccountLabels(labels: Record<string, string>): void {
  const filePath = getAntigravityAccountLabelsPath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(labels, null, 2), "utf8");
}

export function getAntigravityAccountEmail(profile: AntigravityProfile): string {
  const labels = readAntigravityAccountLabels();
  return labels[profile] ?? "";
}

export function getAntigravityQuotaCachePath(): string {
  return join(getOpenMausDir(), "antigravity-quota-cache.json");
}

export function emptyQuota(): AntigravityQuota {
  return {
    gemini: { weekly: null, fiveHour: null },
    other: { weekly: null, fiveHour: null },
  };
}

const quotaCache = new Map<AntigravityProfile, AntigravityQuota>();
const quotaRefreshFailures = new Set<AntigravityProfile>();
let credentialQueue: Promise<void> = Promise.resolve();
let managedQuotaRefreshes = 0;
let accountRefreshInFlight: Promise<AntigravityAccountStatus[]> | null = null;
const managedWorkerProcesses = new Set<number>();
let activeProfileState: AntigravityProfile | null = "a";

export function clearAntigravityQuotaCache(): void {
  quotaCache.clear();
  quotaRefreshFailures.clear();
}

export function loadQuotaCache(): void {
  try {
    const cacheFile = getAntigravityQuotaCachePath();
    if (!existsSync(cacheFile)) return;
    const saved = JSON.parse(readFileSync(cacheFile, "utf8")) as Partial<
      Record<AntigravityProfile, AntigravityQuota>
    >;
    for (const profile of ["a", "b"] as const) {
      if (saved[profile]) quotaCache.set(profile, saved[profile]!);
    }
  } catch {
    // First run or an invalid old cache: report unknown quotas without mutation.
  }
}

export function saveQuotaCache(): void {
  const cacheFile = getAntigravityQuotaCachePath();
  mkdirSync(dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(quotaCache), null, 2), "utf8");
}

loadQuotaCache();

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function readFiniteFraction(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value >= 0 && value <= 1) return value;
      if (value > 1 && value <= 100) return value / 100;
    }
  }
  return null;
}

function readUsageGroups(payload: unknown): unknown[] {
  const root = asRecord(payload);
  if (!root) throw new Error("Antigravity usage response is not an object");

  const command = asRecord(root.command);
  if (command && command.name !== "usage") {
    throw new Error("Antigravity usage response is not the usage command");
  }

  const candidates = [command?.data, root.data, root.response, root];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (Array.isArray(record?.groups)) return record.groups;
  }
  throw new Error("Antigravity usage response is incomplete");
}

function readUsageFraction(bucket: JsonRecord): number | null {
  const remaining = asRecord(bucket.remaining);
  return readFiniteFraction(
    bucket.remaining_fraction,
    bucket.remainingFraction,
    bucket.remaining_percentage,
    bucket.remainingPercentage,
    bucket.remaining,
    remaining?.remaining_fraction,
    remaining?.remainingFraction,
    remaining?.remaining_percentage,
    remaining?.remainingPercentage,
    remaining?.remaining,
  );
}

function readResetAt(bucket: JsonRecord): string | null {
  const value = bucket.reset_time ?? bucket.resetTime ?? bucket.resets_at ?? bucket.resetsAt;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readQuotaWindow(bucket: unknown): "weekly" | "fiveHour" | null {
  const record = asRecord(bucket);
  if (!record) return null;
  const hint = [record.window, record.id, record.bucketId, record.displayName]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (hint.includes("weekly") || hint.includes("week")) return "weekly";
  if (hint.includes("5h") || hint.includes("five hour") || hint.includes("five-hour"))
    return "fiveHour";
  return null;
}

/** Parse the documented structured, read-only Antigravity usage response. */
export function parseAntigravityUsage(output: string): AntigravityQuota {
  let payload: unknown;
  try {
    payload = JSON.parse(output.trim());
  } catch {
    throw new Error("Antigravity usage response is not valid JSON");
  }

  const root = asRecord(payload);
  const usage = asRecord(root?.usage);
  if (usage) {
    const tokenCounts = [
      "input_tokens",
      "output_tokens",
      "thinking_tokens",
      "cache_read_tokens",
      "total_tokens",
    ].map((key) => usage[key]);
    if (tokenCounts.some((value) => typeof value === "number" && value !== 0)) {
      throw new Error("Antigravity usage response describes an agent turn");
    }
  }

  const result = emptyQuota();
  const seen = new Set<string>();
  for (const group of readUsageGroups(payload)) {
    const groupRecord = asRecord(group);
    const family = groupRecord?.name ?? groupRecord?.displayName;
    const target =
      family === "Gemini Models"
        ? result.gemini
        : family === "Claude and GPT models"
          ? result.other
          : null;
    if (!target) continue;
    const buckets = groupRecord?.buckets;
    if (!Array.isArray(buckets)) continue;
    for (const bucket of buckets) {
      const window = readQuotaWindow(bucket);
      const record = asRecord(bucket);
      const fraction = record ? readUsageFraction(record) : null;
      if (!window || !record || fraction === null) continue;
      if (seen.has(`${family}:${window}`)) {
        throw new Error("Antigravity usage response has duplicate quota windows");
      }
      seen.add(`${family}:${window}`);
      target[window] = { remaining: Math.round(fraction * 100), resetsAt: readResetAt(record) };
    }
  }

  if (seen.size !== 4) throw new Error("Antigravity usage response is incomplete");
  return result;
}

export function hasCompleteAntigravityUsage(stdout: string): boolean {
  try {
    parseAntigravityUsage(stdout);
    return true;
  } catch {
    return false;
  }
}

export function registerManagedAntigravityWorker(pid: number | undefined): void {
  if (pid && Number.isInteger(pid) && pid > 0) managedWorkerProcesses.add(pid);
}

export function unregisterManagedAntigravityWorker(pid: number | undefined): void {
  if (pid) managedWorkerProcesses.delete(pid);
}

export function antigravityManagedWorkerRunning(): boolean {
  return managedWorkerProcesses.size > 0;
}

export function withAntigravityCredentialLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = credentialQueue.then(operation, operation);
  credentialQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function antigravityManagedQuotaRefreshRunning(): boolean {
  return managedQuotaRefreshes > 0 || accountRefreshInFlight !== null;
}

export async function withManagedAntigravityQuotaRefresh<T>(
  operation: () => Promise<T>,
): Promise<T> {
  managedQuotaRefreshes += 1;
  try {
    return await operation();
  } finally {
    managedQuotaRefreshes -= 1;
  }
}

export function withAntigravityAccountRefreshSingleFlight(
  operation: () => Promise<AntigravityAccountStatus[]>,
): Promise<AntigravityAccountStatus[]> {
  if (accountRefreshInFlight) return accountRefreshInFlight;
  const request = operation();
  const tracked = request.finally(() => {
    if (accountRefreshInFlight === tracked) accountRefreshInFlight = null;
  });
  accountRefreshInFlight = tracked;
  return tracked;
}

export function nextAntigravityQuotaStaleState(
  current: boolean,
  outcome: "unchanged" | "success" | "failure",
): boolean {
  if (outcome === "failure") return true;
  if (outcome === "success") return false;
  return current;
}

export function recordAntigravityQuotaRefresh(
  profile: AntigravityProfile,
  outcome: "success" | "failure",
): void {
  const stale = nextAntigravityQuotaStaleState(quotaRefreshFailures.has(profile), outcome);
  if (stale) quotaRefreshFailures.add(profile);
  else quotaRefreshFailures.delete(profile);
}

export async function activeAntigravityProfile(): Promise<AntigravityProfile | null> {
  return activeProfileState;
}

export async function activateAntigravityProfile(profile: AntigravityProfile): Promise<void> {
  activeProfileState = profile;
}

export async function antigravityProcessRunning(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
        execFile(
          "tasklist.exe",
          ["/FI", "IMAGENAME eq agy.exe", "/NH"],
          { windowsHide: true, timeout: 5_000, encoding: "utf8" },
          (err, stdout) => (err ? reject(err) : resolve({ stdout })),
        );
      });
      return /\bagy\.exe\b/i.test(stdout);
    }
    return false;
  } catch {
    return false;
  }
}

export function getAgyCommand(): string {
  return process.env.OMB_AGY_BIN || process.env.AGY_BIN || "agy";
}

export async function refreshAntigravityProfileQuota(profile: AntigravityProfile): Promise<void> {
  return withAntigravityCredentialLock(() =>
    withManagedAntigravityQuotaRefresh(async () => {
      ensureAntigravityProfileDir(profile);
      try {
        const { stdout } = await execCliTree(getAgyCommand(), [...QUOTA_PROBE_ARGS], {
          env: getAntigravityProfileEnv(profile),
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          completionPredicate: (output) => hasCompleteAntigravityUsage(output),
        });
        quotaCache.set(profile, parseAntigravityUsage(stdout));
        recordAntigravityQuotaRefresh(profile, "success");
        saveQuotaCache();
      } catch (error) {
        recordAntigravityQuotaRefresh(profile, "failure");
        throw error;
      }
    }),
  );
}

async function accountStatusesUnlocked(refresh: boolean): Promise<AntigravityAccountStatus[]> {
  loadQuotaCache();
  const originallyActive = await activeAntigravityProfile();
  const statuses: AntigravityAccountStatus[] = [];

  for (const profile of ["a", "b"] as const) {
    const meta = PROFILES[profile];
    const email = getAntigravityAccountEmail(profile);
    const cached = quotaCache.get(profile) ?? emptyQuota();

    let quota = cached;
    let refreshError: string | undefined;

    if (refresh) {
      try {
        ensureAntigravityProfileDir(profile);
        const { stdout } = await execCliTree(getAgyCommand(), [...QUOTA_PROBE_ARGS], {
          env: getAntigravityProfileEnv(profile),
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          completionPredicate: (output) => hasCompleteAntigravityUsage(output),
        });
        quota = parseAntigravityUsage(stdout);
        quotaCache.set(profile, quota);
        recordAntigravityQuotaRefresh(profile, "success");
        saveQuotaCache();
      } catch (error) {
        recordAntigravityQuotaRefresh(profile, "failure");
        refreshError = error instanceof Error ? error.message : "Quota refresh failed.";
      }
    }

    const status: AntigravityAccountStatus = {
      profile,
      instanceId: meta.instanceId,
      label: meta.label,
      email,
      active: originallyActive === profile,
      available: true,
      quota,
      quotaStale: quotaRefreshFailures.has(profile),
    };
    if (refreshError) status.error = refreshError;
    statuses.push(status);
  }

  if (refresh && originallyActive) {
    try {
      await activateAntigravityProfile(originallyActive);
    } catch {
      // ignore
    }
  }

  return statuses;
}

export async function antigravityAccountStatuses(
  refresh = false,
): Promise<AntigravityAccountStatus[]> {
  if (!refresh) return accountStatusesUnlocked(false);
  return withAntigravityAccountRefreshSingleFlight(() =>
    withAntigravityCredentialLock(() =>
      withManagedAntigravityQuotaRefresh(() => accountStatusesUnlocked(true)),
    ),
  );
}
