// The 5-hour and weekly limits of the Google account an Antigravity instance is signed in to, for the plan-usage report.
//
// Adapted from pingdotgg/t3code@b732621b51, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified:
//   - apps/server/src/provider/antigravityUsageLimits.ts (the endpoints and
//     their order, the request's client line, the summary and per-model
//     quota readers, the untouched-bucket reset rule, and the access cache).
// Only the personal Google sign-in is read, the account fingerprint is left out, and every failure is no row at all.
//
// Security: the access token lives in this module's memory and in request headers only. It is never logged, written or
// put in a result, and only the instance's own stored sign-in is read.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import type { PlanExtra, PlanFetch, PlanModelUsage, PlanWindow, PlanWindows } from "../plan-usage.ts";
import { antigravityTokenPath } from "./antigravity-acp.ts";
import { refreshAntigravityAccess } from "./antigravity-account.ts";

/** Whether Antigravity accounts are asked for their limits at all. Off, they have no row in the usage report. */
export const ANTIGRAVITY_USAGE_LIMITS = true;

export function antigravityUserAgent(platform: NodeJS.Platform, architecture: string): string {
  return `antigravity/hub/2.24.0 (aidev_client; os_type=${platform}; arch=${architecture}; cl=963137146)`;
}

const DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com";
// The ACP runtime meters consumer tiers on the daily host and GCP-terms tiers on prod.
const PERSONAL_ENDPOINTS = [DAILY_ENDPOINT, PROD_ENDPOINT];
const SUMMARY_WINDOW_MINS = new Map([
  ["5h", 5 * 60],
  ["weekly", 7 * 24 * 60],
]);
// The whole read, as long as any other engine's usage may take.
const READ_DEADLINE_MS = 8_000;
const REFUSED_REFRESH_HOLD_MS = 15 * 60_000;
const FAILED_REFRESH_HOLD_MS = 60_000;
const TOKEN_FILE_MAX_BYTES = 1024 * 1024;

interface Quota {
  remainingFraction?: number;
  resetTime?: string;
}

interface Bucket extends Quota {
  bucketId: string;
  window?: string;
  displayName?: string;
  description?: string;
  disabled?: boolean;
}

export interface AntigravityUsageWindow {
  id: string;
  /** Whose allowance it is: "Gemini", "Claude & GPT (shared)", or the group's own name. */
  family: string;
  /** "5-hour", "Weekly", or what the account calls it. */
  name: string;
  kind: "session" | "weekly" | "other";
  usedPercent: number;
  resetsAt?: string;
  windowDurationMins?: number;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

function quota(value: unknown): Quota | null {
  const fields = record(value);
  if (!fields) return null;
  return {
    ...(typeof fields.remainingFraction === "number" ? { remainingFraction: fields.remainingFraction } : {}),
    ...(typeof fields.resetTime === "string" ? { resetTime: fields.resetTime } : {}),
  };
}

function bucket(value: unknown): Bucket | null {
  const fields = record(value);
  if (!fields || typeof fields.bucketId !== "string" || !fields.bucketId) return null;
  return {
    ...quota(fields),
    bucketId: fields.bucketId,
    window: text(fields.window),
    displayName: text(fields.displayName),
    description: text(fields.description),
    disabled: fields.disabled === true,
  };
}

function iso(value: string | undefined): string | undefined {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function quotaWindow(
  id: string,
  family: string,
  name: string,
  value: Quota,
  kind: AntigravityUsageWindow["kind"] = "other",
  windowDurationMins?: number,
): AntigravityUsageWindow | undefined {
  if (value.remainingFraction === undefined || !Number.isFinite(value.remainingFraction)) return undefined;
  const resetsAt = iso(value.resetTime);
  return {
    id,
    family,
    name,
    kind,
    usedPercent: (1 - Math.max(0, Math.min(1, value.remainingFraction))) * 100,
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  };
}

function summaryResetTime(entry: Bucket, windowDurationMins: number | undefined, requestedAt: number): string | undefined {
  // Untouched summary buckets report a rolling full-window reset.
  const untouched = entry.remainingFraction === 1
    && entry.description === undefined
    && windowDurationMins !== undefined
    && Math.abs(Date.parse(entry.resetTime ?? "") - requestedAt - windowDurationMins * 60_000) <= 60_000;
  return untouched ? undefined : entry.resetTime;
}

/** Windows from a `retrieveUserQuotaSummary` answer requested at `requestedAt`. */
export function antigravitySummaryWindows(response: unknown, requestedAt: number): AntigravityUsageWindow[] {
  const summary = record(response);
  if (!summary) return [];
  const buckets = (value: unknown) => (Array.isArray(value) ? value : []).map(bucket).filter((entry) => entry !== null);
  const listed = (Array.isArray(summary.groups) ? summary.groups : []).map(record).filter((group) => group !== null)
    .map((group) => ({ displayName: text(group.displayName), buckets: buckets(group.buckets) }));
  const groups = listed.some((group) => group.buckets.length) ? listed : [{ displayName: undefined, buckets: buckets(summary.buckets) }];
  const windows = new Map<string, AntigravityUsageWindow>();
  for (const group of groups) {
    for (const entry of group.buckets) {
      if (entry.disabled) continue;
      // Argon and Carbon are metered separately from the default Gemini buckets.
      const family = entry.bucketId.startsWith("gemini-argon-")
        ? group.displayName?.trim() || "Gemini Argon"
        : entry.bucketId.startsWith("gemini-carbon-")
          ? group.displayName?.trim() || "Gemini Carbon"
          : entry.bucketId.startsWith("gemini-")
            ? "Gemini"
            : entry.bucketId.startsWith("3p-")
              ? "Claude & GPT (shared)"
              : group.displayName?.trim() || entry.bucketId;
      const weekly = entry.window === "weekly";
      const session = entry.window === "5h";
      const windowDurationMins = SUMMARY_WINDOW_MINS.get(entry.window ?? "");
      const window = quotaWindow(
        entry.bucketId,
        family,
        weekly ? "Weekly" : session ? "5-hour" : entry.displayName?.trim() || "Quota",
        { ...entry, resetTime: summaryResetTime(entry, windowDurationMins, requestedAt) },
        weekly ? "weekly" : session ? "session" : "other",
        windowDurationMins,
      );
      if (window) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

/** Older accounts expose model quotas without a window length. Do not invent a reset cadence. */
export function antigravityModelWindows(response: unknown): AntigravityUsageWindow[] {
  const models = record(record(response)?.models);
  if (!models) return [];
  const windows = new Map<string, AntigravityUsageWindow>();
  for (const [modelId, value] of Object.entries(models)) {
    const model = record(value);
    if (!model) continue;
    const family = model.modelProvider === "MODEL_PROVIDER_GOOGLE" || modelId.startsWith("gemini-")
      ? "Gemini"
      : model.modelProvider === "MODEL_PROVIDER_ANTHROPIC" || modelId.startsWith("claude-")
        ? "Claude"
        : model.modelProvider === "MODEL_PROVIDER_OPENAI" || modelId.startsWith("gpt-")
          ? "GPT"
          : undefined;
    if (!family) continue;
    for (const [suffix, entry] of [["quota", quota(model.quotaInfo)], ["weekly", quota(model.weeklyQuotaInfo)]] as const) {
      if (!entry) continue;
      const window = quotaWindow(
        `${family.toLowerCase()}-${suffix}`,
        family,
        suffix === "weekly" ? "Weekly" : "Reported quota",
        entry,
        suffix === "weekly" ? "weekly" : "other",
        suffix === "weekly" ? 7 * 24 * 60 : undefined,
      );
      if (!window) continue;
      const previous = windows.get(window.id);
      if (!previous || window.usedPercent > previous.usedPercent) windows.set(window.id, window);
    }
  }
  return [...windows.values()];
}

const clamp = (value: number) => Math.min(100, Math.max(0, value));

/** The report's shape: Gemini's own 5-hour and weekly windows lead the row, every other allowance is listed by family. */
export function antigravityPlanWindows(windows: readonly AntigravityUsageWindow[]): PlanWindows {
  const closed = (): PlanWindow => ({ available: false, remainingPercent: null, usedPercent: null, resetsAt: null });
  const open = (window: AntigravityUsageWindow): PlanWindow =>
    ({ available: true, usedPercent: clamp(window.usedPercent), remainingPercent: clamp(100 - window.usedPercent), resetsAt: window.resetsAt ?? null });
  const lead = (kind: "session" | "weekly") => windows.find((window) => window.family === "Gemini" && window.kind === kind);
  const fiveHour = lead("session"), weekly = lead("weekly");
  const models: PlanModelUsage[] = [];
  for (const window of windows) {
    if (window === fiveHour || window === weekly) continue;
    const line: PlanExtra = { label: window.name, usedPercent: clamp(window.usedPercent), remainingPercent: clamp(100 - window.usedPercent), resetsAt: window.resetsAt ?? null };
    const family = models.find((model) => model.name === window.family);
    if (family) family.windows.push(line);
    else models.push({ name: window.family, windows: [line] });
  }
  return { plan: null, fiveHour: fiveHour ? open(fiveHour) : closed(), weekly: weekly ? open(weekly) : closed(), extra: [], models };
}

interface StoredSignIn {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  project_id?: string;
}

async function storedSignIn(tokenPath: string): Promise<{ signIn: StoredSignIn; fingerprint: string } | null> {
  const info = await stat(tokenPath);
  if (!info.isFile() || info.size > TOKEN_FILE_MAX_BYTES) return null;
  const fields = record(JSON.parse(await readFile(tokenPath, "utf8")));
  if (!fields || !["client_id", "client_secret", "refresh_token"].every((key) => typeof fields[key] === "string" && fields[key])) return null;
  const signIn: StoredSignIn = {
    client_id: fields.client_id as string, client_secret: fields.client_secret as string, refresh_token: fields.refresh_token as string,
    ...(typeof fields.project_id === "string" ? { project_id: fields.project_id } : {}),
  };
  const fingerprint = createHash("sha256").update(`${signIn.client_id}\0${signIn.refresh_token}\0${signIn.project_id ?? ""}`).digest("hex");
  return { signIn, fingerprint };
}

const cachedAccess = new Map<string, { fingerprint: string; accessToken: string; expiresAt: number }>();

export function clearAntigravityUsageAccess(): void {
  cachedAccess.clear();
  refreshHolds.clear();
}

export interface AntigravityUsageDeps {
  fetch: PlanFetch;
  now?: () => number;
  timeoutMs?: number;
}

/** `work`, or a rejection once `signal` aborts: a request that ignores its signal does not hold the others' answers. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("deadline"));
  return new Promise<T>((done, fail) => {
    const stop = () => fail(new Error("deadline"));
    signal.addEventListener("abort", stop, { once: true });
    work.then(done, fail).finally(() => signal.removeEventListener("abort", stop));
  });
}

async function postJson(deps: AntigravityUsageDeps, signal: AbortSignal, url: string, headers: Record<string, string>, body: string): Promise<unknown> {
  return untilAborted((async () => {
    const response = await deps.fetch(url, { method: "POST", headers, body, redirect: "manual", signal });
    if (!response.ok) throw new Error("refused");
    return JSON.parse(await response.text());
  })(), signal);
}

/** Sign-ins Google would not refresh, or that could not be refreshed, and when to ask again: a refused one is not
 * posted again with every report. A sign-in that changed is asked at once. */
const refreshHolds = new Map<string, { fingerprint: string; until: number }>();

/** The windows Google reports for the sign-in stored at `tokenPath`; empty when it reports none. Throws on any failure.
 * Every request shares `signal`, the one deadline of the whole read. */
export async function readAntigravityUsageWindows(tokenPath: string, deps: AntigravityUsageDeps, signal: AbortSignal = AbortSignal.timeout(deps.timeoutMs ?? READ_DEADLINE_MS)): Promise<AntigravityUsageWindow[]> {
  const stored = await storedSignIn(tokenPath).catch(() => null);
  if (!stored) {
    cachedAccess.delete(tokenPath);
    return [];
  }
  const now = deps.now ?? Date.now;
  const { signIn, fingerprint } = stored;
  let cached = cachedAccess.get(tokenPath);
  if (cached?.fingerprint !== fingerprint || cached.expiresAt <= now() + 60_000) {
    cachedAccess.delete(tokenPath);
    const held = refreshHolds.get(tokenPath);
    if (held?.fingerprint === fingerprint && now() < held.until) throw new Error("held");
    const started = now();
    let refused = false;
    const access = await untilAborted(refreshAntigravityAccess(signIn, signal, async (url, init) => {
      const response = await deps.fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: String(init.body), redirect: "manual", signal: init.signal });
      refused = !response.ok;
      return { ok: response.ok, json: async () => JSON.parse(await response.text()) };
    }, "manual"), signal).catch(() => undefined);
    if (!access || access.expiresInSeconds === null) {
      if (refreshHolds.size >= 128) refreshHolds.delete(refreshHolds.keys().next().value!);
      refreshHolds.set(tokenPath, { fingerprint, until: now() + (refused ? REFUSED_REFRESH_HOLD_MS : FAILED_REFRESH_HOLD_MS) });
      throw new Error("refused");
    }
    refreshHolds.delete(tokenPath);
    cached = { fingerprint, accessToken: access.accessToken, expiresAt: started + access.expiresInSeconds * 1000 };
    if (cachedAccess.size >= 128) cachedAccess.delete(cachedAccess.keys().next().value!);
    cachedAccess.set(tokenPath, cached);
  }
  const { accessToken } = cached;
  const headers = { Authorization: `Bearer ${accessToken}`, "User-Agent": antigravityUserAgent(process.platform, process.arch), "content-type": "application/json" };
  const body = JSON.stringify(signIn.project_id ? { project: signIn.project_id } : {});
  // Merge endpoints because quota groups differ; the metered host's reading of a bucket wins.
  const fetchWindows = async (operation: string, parse: (response: unknown, requestedAt: number) => AntigravityUsageWindow[]) => {
    const responses = await Promise.all(PERSONAL_ENDPOINTS.map(async (endpoint) => {
      // Capture each request after auth, so refresh latency does not widen the tolerance.
      const requestedAt = now();
      try {
        return parse(await postJson(deps, signal, `${endpoint}/v1internal:${operation}`, headers, body), requestedAt);
      } catch {
        return [];
      }
    }));
    const windows = new Map<string, AntigravityUsageWindow>();
    for (const window of responses.flat()) if (!windows.has(window.id)) windows.set(window.id, window);
    return [...windows.values()];
  };
  const summary = await fetchWindows("retrieveUserQuotaSummary", antigravitySummaryWindows);
  return summary.length ? summary : fetchWindows("fetchAvailableModels", (response) => antigravityModelWindows(response));
}

/** An Antigravity instance's limits for the usage report, or null for no row: the switch is off, nobody is signed in,
 * Google refused or could not be reached, or it reported nothing usable. It never throws and reports no error. */
export async function antigravityPlanUsage(
  instanceId: string,
  deps: AntigravityUsageDeps,
  tokenPath = antigravityTokenPath(instanceId),
  enabled = ANTIGRAVITY_USAGE_LIMITS,
): Promise<PlanWindows | null> {
  if (!enabled) return null;
  try {
    // One deadline for the refresh, the summary and the fallback together.
    const windows = await readAntigravityUsageWindows(tokenPath, deps, AbortSignal.timeout(deps.timeoutMs ?? READ_DEADLINE_MS));
    return windows.length ? antigravityPlanWindows(windows) : null;
  } catch {
    return null;
  }
}
