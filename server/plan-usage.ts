// Subscription allowance for the engines OpenMausBot already signs in
// (Claude, Codex, Grok). Parsers are pure. The fetcher takes fetch and a
// credential reader so tests never touch the network or a real login file.
// Access tokens stay in the request header only — never in the JSON result.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InstanceConfigMap } from "./contracts.ts";
import { resolveClaudeConfigDir } from "./drivers/claude.ts";
import { codexHome } from "./drivers/codex-identity.ts";
import { harnessHome } from "./env-path.ts";

export type PlanDriver = "claude" | "codex" | "grok";

export interface PlanWindow {
  available: boolean;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface PlanExtra {
  label: string;
  remainingPercent: number;
  usedPercent: number;
  resetsAt: string | null;
}

/** A model- or product-scoped slice of the plan. `windows` are that slice's
 * own 5-hour, weekly, or other allowance — not a share of the account total. */
export interface PlanModelUsage {
  name: string;
  windows: PlanExtra[];
}

export interface PlanWindows {
  plan: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models: PlanModelUsage[];
}

export interface PlanProviderRow {
  id: string;
  name: string;
  driver: string;
  plan: string | null;
  ok: boolean;
  error: string | null;
  fiveHour: PlanWindow;
  weekly: PlanWindow;
  extra: PlanExtra[];
  models: PlanModelUsage[];
}

export interface PlanUsageReport {
  fetchedAt: string;
  providers: PlanProviderRow[];
}

export interface PlanAccount {
  id: string;
  name: string;
  driver: PlanDriver;
  environment: Record<string, string | undefined>;
  configDir?: string;
}

export interface PlanCredential {
  token: string | null;
  accountId: string | null;
  expired: boolean;
}

export interface CredentialReader {
  read(account: PlanAccount): PlanCredential | Promise<PlanCredential>;
}

export interface PlanResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type PlanFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<PlanResponse>;

export interface PlanUsageDeps {
  fetch: PlanFetch;
  credentials: CredentialReader;
  now?: () => number;
  timeoutMs?: number;
}

export interface CredentialSource {
  readText: (path: string) => string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** macOS login keychain, read-only. Tests inject this so `security` is never spawned. */
  readClaudeKeychain?: (service: string) => string | null | Promise<string | null>;
}

const PROVIDER_TIMEOUT_MS = 8_000;
const PLAN_USAGE_CACHE_MS = 45_000;
const CREDENTIAL_READ_MAX_BYTES = 1_000_000;
const KEYCHAIN_TIMEOUT_MS = 5_000;
const KEYCHAIN_MAX_BUFFER = 1_000_000;
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_MODEL_FAMILIES = ["opus", "sonnet", "haiku"];

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GROK_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const GROK_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";

const FIVE_HOUR_MIN_SECONDS = 3 * 3600;
const FIVE_HOUR_MAX_SECONDS = 8 * 3600;
const WEEK_MIN_SECONDS = 5 * 86400;
const WEEK_MAX_SECONDS = 9 * 86400;
const MONTH_MIN_SECONDS = 27 * 86400;
const MONTH_MAX_SECONDS = 32 * 86400;

const DRIVER_OF: Record<string, PlanDriver> = {
  claudeAgent: "claude",
  codex: "codex",
  grokAgent: "grok",
};

const PRODUCT_NAME: Record<PlanDriver, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
};

export function planAccountsFromInstances(instances: InstanceConfigMap): PlanAccount[] {
  const accounts: PlanAccount[] = [];
  for (const [id, entry] of Object.entries(instances)) {
    const driver = DRIVER_OF[entry.driver];
    if (!driver) continue;
    const config = asRecord(entry.config);
    const configDir = typeof config?.configDir === "string" ? config.configDir : undefined;
    accounts.push({
      id,
      name: entry.displayName?.trim() || PRODUCT_NAME[driver],
      driver,
      environment: { ...entry.environment },
      ...(configDir ? { configDir } : {}),
    });
  }
  return accounts;
}

export function parseClaudeUsage(body: unknown): PlanWindows {
  const root = claudeRoot(body);
  const extra: PlanExtra[] = [];
  const models: PlanModelUsage[] = [];
  if (root) {
    for (const [key, value] of Object.entries(root)) {
      if (key === "five_hour" || key === "seven_day") continue;
      if (!/^[a-z][a-z0-9_]{0,40}$/i.test(key)) continue;
      const window = readClaudeWindow(value);
      if (!window) continue;
      const model = claudeModelWindow(key);
      if (model) addModelWindow(models, model.name, extraLine(model.window, window));
      else extra.push(extraLine(claudeExtraLabel(key), window));
    }
  }
  sortModelWindows(models);
  return {
    plan: planLabel(root?.subscription_type ?? root?.plan ?? root?.plan_type),
    fiveHour: (root && readClaudeWindow(root.five_hour)) ?? closedWindow(),
    weekly: (root && readClaudeWindow(root.seven_day)) ?? closedWindow(),
    extra,
    models,
  };
}

export function parseCodexUsage(body: unknown): PlanWindows {
  const root = asRecord(body);
  const assigned = assignDurationWindows(durationWindows(root?.rate_limit));
  const models: PlanModelUsage[] = [];
  const extra = [...assigned.extra];
  if (root) collectCodexNamedLimits(root, models, extra);
  sortModelWindows(models);
  return { ...assigned, extra, models, plan: planLabel(root?.plan_type ?? root?.plan) };
}

export function parseGrokUsage(credits: unknown, billing?: unknown, settings?: unknown): PlanWindows {
  let fiveHour = closedWindow();
  let weekly = closedWindow();
  const extra: PlanExtra[] = [];
  const models: PlanModelUsage[] = [];
  let sawMonthly = false;
  const place = (sample: GrokSample | null) => {
    if (!sample) return;
    const window = openWindow(sample.used, sample.resetsAt);
    if (sample.slot === "fiveHour") {
      if (!fiveHour.available) fiveHour = window;
    } else if (sample.slot === "weekly") {
      if (!weekly.available) weekly = window;
    } else if (sample.slot === "monthly") {
      if (!sawMonthly) {
        sawMonthly = true;
        extra.push(extraLine("Monthly", window));
      }
    } else {
      extra.push(extraLine(sample.seconds == null ? "Credits" : durationLabel(sample.seconds), window));
    }
  };
  const creditSample = readGrokSample(credits);
  place(creditSample);
  const productSample = creditSample ?? { used: 0, slot: "other" as const, resetsAt: null, seconds: null };
  for (const model of readGrokProducts(credits, productSample)) addModelWindow(models, model.name, model.window);
  if (billing !== undefined) place(readGrokSample(billing));
  sortModelWindows(models);
  return { plan: grokPlan(settings), fiveHour, weekly, extra, models };
}

export function fileCredentialReader(source: CredentialSource): CredentialReader {
  const env = source.env ?? process.env;
  const now = source.now ?? Date.now;
  return {
    async read(account) {
      const merged: NodeJS.ProcessEnv = { ...env, ...account.environment };
      const at = now();
      if (account.driver === "claude") return readClaudeCredential(account, merged, source, at);
      if (account.driver === "codex") return readCodexCredential(merged, source.readText, at);
      return readGrokCredential(merged, source.readText, at);
    },
  };
}

export function defaultCredentialReader(env: NodeJS.ProcessEnv = process.env): CredentialReader {
  return fileCredentialReader({
    env,
    readText(path) {
      try {
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > CREDENTIAL_READ_MAX_BYTES) return null;
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    ...(process.platform === "darwin" ? { readClaudeKeychain: readDarwinClaudeKeychain } : {}),
  });
}

export async function fetchPlanUsage(accounts: PlanAccount[], deps: PlanUsageDeps): Promise<PlanUsageReport> {
  const now = deps.now?.() ?? Date.now();
  const providers = await Promise.all(accounts.map((account) => fetchProvider(account, deps)));
  return { fetchedAt: new Date(now).toISOString(), providers };
}

let cachedReport: { at: number; key: string; report: PlanUsageReport } | null = null;

export function clearPlanUsageCache(): void {
  cachedReport = null;
}

export async function loadPlanUsage(input: {
  accounts: PlanAccount[];
  refresh?: boolean;
  now?: number;
  fetch?: PlanFetch;
  credentials?: CredentialReader;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<PlanUsageReport> {
  const now = input.now ?? Date.now();
  const key = planUsageCacheKey(input.accounts);
  if (!input.refresh && cachedReport && cachedReport.key === key && now - cachedReport.at < PLAN_USAGE_CACHE_MS) {
    return cachedReport.report;
  }
  const report = await fetchPlanUsage(input.accounts, {
    fetch: input.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    credentials: input.credentials ?? defaultCredentialReader(input.env),
    now: () => now,
    timeoutMs: input.timeoutMs,
  });
  cachedReport = { at: now, key, report };
  return report;
}

function closedWindow(): PlanWindow {
  return { available: false, remainingPercent: null, usedPercent: null, resetsAt: null };
}

function openWindow(usedPercent: number, resetsAt: string | null): PlanWindow {
  const used = clampPercent(usedPercent);
  return {
    available: true,
    usedPercent: used,
    remainingPercent: clampPercent(100 - used),
    resetsAt,
  };
}

function extraLine(label: string, window: PlanWindow): PlanExtra {
  return {
    label,
    remainingPercent: window.remainingPercent ?? 0,
    usedPercent: window.usedPercent ?? 0,
    resetsAt: window.resetsAt,
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function timeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.abs(value) >= 1e12 ? value : value * 1000;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return timeMs(Number(trimmed));
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOrNull(value: unknown): string | null {
  const ms = timeMs(value);
  if (ms == null) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function planLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || /[\r\n]/.test(trimmed)) return null;
  if (/bearer\s|access_token|refresh_token|sk-ant-|eyJ[a-zA-Z0-9_-]{8,}/i.test(trimmed)) return null;
  return trimmed;
}

function secretString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 16_000 || /[\r\n]/.test(trimmed)) return null;
  return trimmed;
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function missingCredential(): PlanCredential {
  return { token: null, accountId: null, expired: false };
}

function expiredCredential(): PlanCredential {
  return { token: null, accountId: null, expired: true };
}

function signInAgain(driver: PlanDriver): string {
  return `Sign in again in ${PRODUCT_NAME[driver]}`;
}

function couldNotReach(driver: PlanDriver): string {
  return `Could not reach ${PRODUCT_NAME[driver]}`;
}

function unexpectedUsage(driver: PlanDriver): string {
  return `${PRODUCT_NAME[driver]} returned an unexpected usage response`;
}

function claudeRoot(body: unknown): Record<string, unknown> | null {
  const root = asRecord(body);
  if (!root) return null;
  if ("five_hour" in root || "seven_day" in root) return root;
  const nested = asRecord(root.usage) ?? asRecord(root.windows);
  if (nested && ("five_hour" in nested || "seven_day" in nested)) return nested;
  return root;
}

function readClaudeWindow(value: unknown): PlanWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const utilization = finiteNumber(record.utilization);
  if (utilization == null) return null;
  return openWindow(utilization, isoOrNull(record.resets_at ?? record.resetsAt));
}

function claudeExtraLabel(key: string): string {
  const suffix = key.startsWith("seven_day_")
    ? key.slice("seven_day_".length)
    : key.replace(/^five_hour_/, "");
  return titleWords(suffix);
}

function titleWords(suffix: string): string {
  const words = suffix.split("_").filter((part) => part.length > 0);
  if (words.length === 0) return "Window";
  return words.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}

/** Opus, Sonnet, and Haiku only. `seven_day_oauth_apps` and other windows stay extra lines. */
function claudeModelWindow(key: string): { name: string; window: string } | null {
  const weekly = key.startsWith("seven_day_");
  const fiveHour = key.startsWith("five_hour_");
  if (!weekly && !fiveHour) return null;
  const suffix = key.slice(weekly ? "seven_day_".length : "five_hour_".length);
  const lower = suffix.toLowerCase();
  const family = CLAUDE_MODEL_FAMILIES.find((name) => lower === name || lower.startsWith(`${name}_`));
  if (!family) return null;
  return { name: titleWords(suffix), window: weekly ? "Weekly" : "5-hour" };
}

function addModelWindow(models: PlanModelUsage[], name: string, line: PlanExtra): void {
  const found = models.find((model) => model.name.toLowerCase() === name.toLowerCase());
  if (found) found.windows.push(line);
  else models.push({ name, windows: [line] });
}

function sortModelWindows(models: PlanModelUsage[]): void {
  const rank = (label: string) => (label === "5-hour" ? 0 : label === "Weekly" ? 1 : 2);
  for (const model of models) model.windows.sort((a, b) => rank(a.label) - rank(b.label));
}

interface DurationWindow {
  used: number;
  seconds: number;
  resetsAt: string | null;
}

function readDurationWindow(value: unknown): DurationWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  const used = finiteNumber(record.used_percent);
  let seconds = finiteNumber(record.limit_window_seconds);
  if (seconds == null) {
    const minutes = finiteNumber(record.window_minutes);
    if (minutes != null) seconds = minutes * 60;
  }
  if (used == null || seconds == null || seconds <= 0) return null;
  return { used, seconds, resetsAt: isoOrNull(record.reset_at ?? record.resetAt) };
}

/** Primary and secondary windows, or one flat window when those keys are absent. */
function durationWindows(node: unknown): DurationWindow[] {
  const record = asRecord(node);
  if (!record) return [];
  const source = asRecord(record.rate_limit) ?? record;
  const windows: DurationWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const window = readDurationWindow(source[key]);
    if (window) windows.push(window);
  }
  if (windows.length === 0) {
    const self = readDurationWindow(source);
    if (self) windows.push(self);
  }
  return windows;
}

function codexLimitName(record: Record<string, unknown>): string | null {
  return planLabel(record.limit_name) ?? planLabel(record.metered_feature) ?? planLabel(record.name);
}

function pushAssignedLines(assigned: PlanWindows, into: PlanExtra[]): void {
  if (assigned.fiveHour.available) into.push(extraLine("5-hour", assigned.fiveHour));
  if (assigned.weekly.available) into.push(extraLine("Weekly", assigned.weekly));
  into.push(...assigned.extra);
}

function collectCodexNamedLimits(root: Record<string, unknown>, models: PlanModelUsage[], extra: PlanExtra[]): void {
  const buckets: Array<{ name: string | null; node: unknown }> = [];
  if (root.code_review_rate_limit) buckets.push({ name: "Code review", node: root.code_review_rate_limit });
  const additional = root.additional_rate_limits;
  if (Array.isArray(additional)) {
    for (const item of additional) {
      const record = asRecord(item);
      buckets.push({ name: record ? codexLimitName(record) : null, node: item });
    }
  } else {
    const named = asRecord(additional);
    if (named) {
      for (const [key, value] of Object.entries(named)) buckets.push({ name: planLabel(key), node: value });
    }
  }
  for (const bucket of buckets) {
    const assigned = assignDurationWindows(durationWindows(bucket.node));
    if (!bucket.name) {
      pushAssignedLines(assigned, extra);
      continue;
    }
    const lines: PlanExtra[] = [];
    pushAssignedLines(assigned, lines);
    for (const line of lines) addModelWindow(models, bucket.name, line);
  }
}

function readGrokProducts(body: unknown, sample: GrokSample): Array<{ name: string; window: PlanExtra }> {
  const root = asRecord(body);
  if (!root) return [];
  const config = asRecord(root.config) ?? root;
  if (!Array.isArray(config.productUsage)) return [];
  const label = sample.slot === "fiveHour" ? "5-hour" : sample.slot === "weekly" ? "Weekly" : sample.slot === "monthly" ? "Monthly" : "Used";
  const rows: Array<{ name: string; window: PlanExtra }> = [];
  for (const item of config.productUsage) {
    const record = asRecord(item);
    if (!record) continue;
    const raw = typeof record.product === "string" ? record.product : typeof record.name === "string" ? record.name : "";
    const name = planLabel(raw.replace(/([a-z])([A-Z])/g, "$1 $2"));
    const used = finiteNumber(record.usagePercent ?? record.usedPercent ?? record.utilization);
    if (!name || used == null) continue;
    rows.push({ name, window: extraLine(label, openWindow(used, sample.resetsAt)) });
  }
  return rows;
}

function durationLabel(seconds: number): string {
  if (seconds >= 86400) return `${Math.max(1, Math.round(seconds / 86400))}-day`;
  if (seconds >= 3600) return `${Math.max(1, Math.round(seconds / 3600))}-hour`;
  return `${Math.max(1, Math.round(seconds / 60))}-minute`;
}

function assignDurationWindows(windows: DurationWindow[]): PlanWindows {
  let fiveHour = closedWindow();
  let weekly = closedWindow();
  const extra: PlanExtra[] = [];
  for (const window of windows) {
    const open = openWindow(window.used, window.resetsAt);
    const fiveHourSlot = window.seconds >= FIVE_HOUR_MIN_SECONDS && window.seconds <= FIVE_HOUR_MAX_SECONDS;
    const weeklySlot = window.seconds >= WEEK_MIN_SECONDS && window.seconds <= WEEK_MAX_SECONDS;
    if (fiveHourSlot && !fiveHour.available) fiveHour = open;
    else if (weeklySlot && !weekly.available) weekly = open;
    else extra.push(extraLine(durationLabel(window.seconds), open));
  }
  return { plan: null, fiveHour, weekly, extra, models: [] };
}

type GrokSlot = "fiveHour" | "weekly" | "monthly" | "other";

interface GrokSample {
  used: number;
  slot: GrokSlot;
  resetsAt: string | null;
  seconds: number | null;
}

function classifyGrok(typeValue: unknown, seconds: number | null): GrokSlot {
  const type = typeof typeValue === "string" ? typeValue.toUpperCase() : "";
  if (type.includes("WEEK")) return "weekly";
  if (type.includes("MONTH")) return "monthly";
  if (/(^|[^A-Z0-9])(5|FIVE)[^A-Z0-9]*HOUR/.test(type)) return "fiveHour";
  if (seconds == null) return "other";
  if (seconds >= FIVE_HOUR_MIN_SECONDS && seconds <= FIVE_HOUR_MAX_SECONDS) return "fiveHour";
  if (seconds >= WEEK_MIN_SECONDS && seconds <= WEEK_MAX_SECONDS) return "weekly";
  if (seconds >= MONTH_MIN_SECONDS && seconds <= MONTH_MAX_SECONDS) return "monthly";
  return "other";
}

function readGrokSample(body: unknown): GrokSample | null {
  const root = asRecord(body);
  if (!root) return null;
  const config = asRecord(root.config) ?? root;
  let used = finiteNumber(config.creditUsagePercent);
  if (used == null) {
    const cap = finiteNumber(asRecord(config.onDemandCap)?.val ?? config.onDemandCap);
    const spent = finiteNumber(asRecord(config.onDemandUsed)?.val ?? config.onDemandUsed);
    if (cap != null && spent != null && cap > 0) used = (spent / cap) * 100;
  }
  if (used == null) return null;
  const period = asRecord(config.currentPeriod);
  const type = period?.type ?? period?.period ?? config.period ?? config.interval;
  const start = period?.start ?? period?.periodStart;
  const end = period?.end ?? period?.periodEnd ?? config.billingPeriodEnd ?? root.billingPeriodEnd;
  const startMs = timeMs(start);
  const endMs = timeMs(end);
  const seconds = startMs != null && endMs != null && endMs > startMs ? (endMs - startMs) / 1000 : null;
  return { used, slot: classifyGrok(type, seconds), resetsAt: isoOrNull(end), seconds };
}

function grokPlan(settings: unknown): string | null {
  const root = asRecord(settings);
  if (!root) return null;
  const nested = asRecord(root.settings);
  return planLabel(nested?.subscription_tier_display ?? root.subscription_tier_display);
}

function planUsageCacheKey(accounts: PlanAccount[]): string {
  return accounts.map((account) => {
    const environment = Object.entries(account.environment)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join("\n");
    return [account.id, account.driver, account.name, account.configDir ?? "", environment].join("\u0000");
  }).join("\n");
}

function claudeCredentialFromText(text: string | null, now: number): PlanCredential {
  const oauth = asRecord(asRecord(parseJson(text))?.claudeAiOauth);
  const token = secretString(oauth?.accessToken);
  if (!token) return missingCredential();
  const expiry = timeMs(oauth?.expiresAt);
  if (expiry != null && expiry <= now) return expiredCredential();
  return { token, accountId: null, expired: false };
}

/** macOS 26 `security -w` may print the JSON secret as hex. */
function decodeKeychainSecret(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{") && trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex").toString("utf8");
  }
  return trimmed;
}

function claudeKeychainServices(account: PlanAccount, env: NodeJS.ProcessEnv, resolvedDir: string): string[] {
  if (!account.configDir?.trim() && !env.CLAUDE_CONFIG_DIR?.trim()) return [CLAUDE_KEYCHAIN_SERVICE];
  let defaultDir: string | null = null;
  try {
    const withoutConfig = { ...env };
    delete withoutConfig.CLAUDE_CONFIG_DIR;
    defaultDir = resolveClaudeConfigDir(undefined, withoutConfig);
  } catch {
    defaultDir = null;
  }
  if (defaultDir != null && resolvedDir === defaultDir) return [CLAUDE_KEYCHAIN_SERVICE];
  const suffix = createHash("sha256").update(resolvedDir).digest("hex").slice(0, 8);
  return [`${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`];
}

function readDarwinClaudeKeychain(service: string): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(
        "security",
        ["find-generic-password", "-s", service, "-w"],
        {
          timeout: KEYCHAIN_TIMEOUT_MS,
          maxBuffer: KEYCHAIN_MAX_BUFFER,
          windowsHide: true,
          shell: false,
          encoding: "utf8",
        },
        (error, stdout) => {
          resolve(error || !stdout ? null : stdout);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

async function readClaudeCredential(
  account: PlanAccount,
  env: NodeJS.ProcessEnv,
  source: CredentialSource,
  now: number,
): Promise<PlanCredential> {
  let resolvedDir: string;
  try {
    resolvedDir = resolveClaudeConfigDir(account.configDir, env);
  } catch {
    return missingCredential();
  }
  const file = claudeCredentialFromText(source.readText(join(resolvedDir, ".credentials.json")), now);
  if (file.token || !source.readClaudeKeychain) return file;
  let sawExpired = file.expired;
  for (const service of claudeKeychainServices(account, env, resolvedDir)) {
    let raw: string | null = null;
    try {
      raw = (await source.readClaudeKeychain(service)) ?? null;
    } catch {
      raw = null;
    }
    const parsed = claudeCredentialFromText(decodeKeychainSecret(raw), now);
    if (parsed.token) return parsed;
    if (parsed.expired) sawExpired = true;
  }
  return sawExpired ? expiredCredential() : missingCredential();
}

function readCodexCredential(
  env: NodeJS.ProcessEnv,
  readText: (path: string) => string | null,
  now: number,
): PlanCredential {
  const home = codexHome(env);
  if (!home) return missingCredential();
  const root = asRecord(parseJson(readText(join(home, "auth.json"))));
  if (!root) return missingCredential();
  const tokens = asRecord(root.tokens);
  const token = secretString(tokens?.access_token) ?? secretString(root.access_token);
  if (!token) return missingCredential();
  const expiry = timeMs(tokens?.expires_at ?? tokens?.expiresAt ?? root.expires_at ?? root.expiresAt);
  if (expiry != null && expiry <= now) return expiredCredential();
  const accountId = secretString(tokens?.account_id) ?? secretString(root.account_id);
  return { token, accountId, expired: false };
}

interface GrokCandidate {
  token: string;
  expiresAt: number | null;
}

function grokCandidate(record: Record<string, unknown>): GrokCandidate | null {
  const token = secretString(record.access_token) ?? secretString(record.key);
  if (!token) return null;
  return { token, expiresAt: timeMs(record.expires_at ?? record.expiresAt) };
}

function readGrokCredential(
  env: NodeJS.ProcessEnv,
  readText: (path: string) => string | null,
  now: number,
): PlanCredential {
  const rootDir = env.GROK_HOME?.trim() || harnessHome("grok", env);
  const root = asRecord(parseJson(readText(join(rootDir, "auth.json"))));
  if (!root) return missingCredential();
  const direct = grokCandidate(root);
  if (direct) {
    if (direct.expiresAt != null && direct.expiresAt <= now) return expiredCredential();
    return { token: direct.token, accountId: null, expired: false };
  }
  let sawExpired = false;
  let best: GrokCandidate | null = null;
  for (const value of Object.values(root)) {
    const record = asRecord(value);
    if (!record) continue;
    const candidate = grokCandidate(record);
    if (!candidate) continue;
    if (candidate.expiresAt != null && candidate.expiresAt <= now) {
      sawExpired = true;
      continue;
    }
    const bestStamp = best?.expiresAt ?? Number.NEGATIVE_INFINITY;
    const stamp = candidate.expiresAt ?? Number.NEGATIVE_INFINITY;
    if (!best || stamp >= bestStamp) best = candidate;
  }
  if (best) return { token: best.token, accountId: null, expired: false };
  return sawExpired ? expiredCredential() : missingCredential();
}

function errorRow(account: PlanAccount, error: string): PlanProviderRow {
  return {
    id: account.id,
    name: account.name,
    driver: account.driver,
    plan: null,
    ok: false,
    error,
    fiveHour: closedWindow(),
    weekly: closedWindow(),
    extra: [],
    models: [],
  };
}

function okRow(account: PlanAccount, windows: PlanWindows): PlanProviderRow {
  return {
    id: account.id,
    name: account.name,
    driver: account.driver,
    plan: windows.plan,
    ok: true,
    error: null,
    fiveHour: windows.fiveHour,
    weekly: windows.weekly,
    extra: windows.extra,
    models: windows.models,
  };
}

async function fetchProvider(account: PlanAccount, deps: PlanUsageDeps): Promise<PlanProviderRow> {
  let credential: PlanCredential;
  try {
    credential = await deps.credentials.read(account);
  } catch {
    return errorRow(account, signInAgain(account.driver));
  }
  if (credential.expired || !credential.token) return errorRow(account, signInAgain(account.driver));
  try {
    if (account.driver === "claude") return await fetchClaude(account, credential.token, deps);
    if (account.driver === "codex") return await fetchCodex(account, credential.token, credential.accountId, deps);
    return await fetchGrok(account, credential.token, deps);
  } catch {
    return errorRow(account, couldNotReach(account.driver));
  }
}

interface HttpResult {
  status: number;
  ok: boolean;
  body: unknown;
}

async function fetchJson(
  fetchImpl: PlanFetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpResult> {
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    let body: unknown = null;
    if (text.trim()) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = null;
      }
    }
    return { status: response.status, ok: response.ok, body };
  } catch {
    return { status: 0, ok: false, body: null };
  }
}

function authRejected(status: number): boolean {
  return status === 401 || status === 403;
}

async function fetchClaude(account: PlanAccount, token: string, deps: PlanUsageDeps): Promise<PlanProviderRow> {
  const result = await fetchJson(deps.fetch, CLAUDE_USAGE_URL, {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "anthropic-beta": "oauth-2025-04-20",
  }, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS);
  if (authRejected(result.status)) return errorRow(account, signInAgain("claude"));
  if (!result.ok || result.body === null || typeof result.body !== "object") {
    return errorRow(account, result.status === 0 || result.status >= 500 ? couldNotReach("claude") : unexpectedUsage("claude"));
  }
  return okRow(account, parseClaudeUsage(result.body));
}

async function fetchCodex(
  account: PlanAccount,
  token: string,
  accountId: string | null,
  deps: PlanUsageDeps,
): Promise<PlanProviderRow> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  const result = await fetchJson(deps.fetch, CODEX_USAGE_URL, headers, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS);
  if (authRejected(result.status)) return errorRow(account, signInAgain("codex"));
  if (!result.ok || result.body === null || typeof result.body !== "object") {
    return errorRow(account, result.status === 0 || result.status >= 500 ? couldNotReach("codex") : unexpectedUsage("codex"));
  }
  return okRow(account, parseCodexUsage(result.body));
}

async function fetchGrok(account: PlanAccount, token: string, deps: PlanUsageDeps): Promise<PlanProviderRow> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "X-XAI-Token-Auth": "xai-grok-cli",
  };
  const timeout = deps.timeoutMs ?? PROVIDER_TIMEOUT_MS;
  const [credits, billing, settings] = await Promise.all([
    fetchJson(deps.fetch, GROK_CREDITS_URL, headers, timeout),
    fetchJson(deps.fetch, GROK_BILLING_URL, headers, timeout),
    fetchJson(deps.fetch, GROK_SETTINGS_URL, headers, timeout),
  ]);
  if (authRejected(credits.status) || (authRejected(billing.status) && !credits.ok)) {
    return errorRow(account, signInAgain("grok"));
  }
  const creditsBody = credits.ok ? credits.body : null;
  const billingBody = billing.ok && !authRejected(billing.status) ? billing.body : null;
  if (creditsBody === null && billingBody === null) {
    return errorRow(account, credits.status === 0 || credits.status >= 500 || billing.status === 0 || billing.status >= 500
      ? couldNotReach("grok")
      : unexpectedUsage("grok"));
  }
  const windows = parseGrokUsage(creditsBody, billingBody ?? undefined, settings.ok ? settings.body : undefined);
  return okRow(account, windows);
}
