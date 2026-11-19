// Access tokens stay in the request header only, never in the JSON result.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InstanceConfigMap } from "./contracts.ts";
import { resolveClaudeConfigDir } from "./drivers/claude.ts";
import { readMacKeychainLogin } from "./drivers/claude-keychain.ts";
import { codexHome } from "./drivers/codex-identity.ts";
import { antigravityPlanUsage } from "./drivers/antigravity-usage-limits.ts";
import { harnessHome, sealedFixture } from "./env-path.ts";
import { openCodeAuthText, openCodeDbText, readOpenCodeDbLogins } from "./opencode-credentials.ts";
import { DEEPSEEK_BALANCE_URL, parseDeepSeekBalance, type PlanBalance } from "./deepseek-balance.ts";
import { readDeepSeekKey } from "./drivers/acp/deepseek.ts";

export type PlanDriver = "claude" | "codex" | "grok" | "opencode" | "antigravity" | "deepseek";

export interface PlanWindow {
  available: boolean;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

/** Money in the provider's minor units: 4631 with exponent 2 is 46.31. */
export interface PlanSpend {
  usedMinor: number;
  limitMinor: number;
  currency: string;
  exponent: number;
}

export interface PlanExtra {
  label: string;
  remainingPercent: number;
  usedPercent: number;
  resetsAt: string | null;
  /** The amounts behind the percent, on a budget in money. */
  spend?: PlanSpend;
}

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
  /** A prepaid API balance, for a provider that has money left instead of quota windows. */
  balance?: PlanBalance;
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
  /** No usage reading: a ChatGPT plan signed in through OpenMausBot has no CLI login on disk, and a Claude instance whose config sets `usageMeter: false` keeps its login unread (a refused turn still fails over). */
  noUsage?: true;
}

export interface PlanCredential {
  token: string | null;
  accountId: string | null;
  expired: boolean;
  /** Signed in with a pay-per-use API key, which has no plan quota to report. */
  apiKeyOnly?: boolean;
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
  init: { headers: Record<string, string>; signal: AbortSignal; method?: "POST"; body?: string; redirect?: "manual" },
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
  readClaudeKeychain?: (service: string) => string | null | Promise<string | null>;
  /** OpenCode v2's active logins from its own database, as `auth.json`-shaped JSON keyed by integration. */
  readOpenCodeDb?: (path: string) => string | null;
}

const PROVIDER_TIMEOUT_MS = 8_000;
const PLAN_USAGE_CACHE_MS = 45_000;
const CREDENTIAL_READ_MAX_BYTES = 1_000_000;
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_MODEL_FAMILIES = ["opus", "sonnet", "haiku"];
const MONTHLY_SPEND = "Monthly spend";
const EXTRA_USAGE = "Extra Usage";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GROK_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const GROK_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
// OpenCode Go's own allowance: the rolling window, the weekly one and the month's, as the CLI reads them.
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

const FIVE_HOUR_MIN_SECONDS = 3 * 3600;
const FIVE_HOUR_MAX_SECONDS = 8 * 3600;
const WEEK_MIN_SECONDS = 5 * 86400;
const WEEK_MAX_SECONDS = 9 * 86400;
const MONTH_MIN_SECONDS = 27 * 86400;
const MONTH_MAX_SECONDS = 32 * 86400;

const DRIVER_OF: Record<string, PlanDriver> = { claudeAgent: "claude", codex: "codex", grokAgent: "grok", opencodeGo: "opencode", antigravityAgent: "antigravity", deepseekAgent: "deepseek" };

const PRODUCT_NAME: Record<PlanDriver, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  deepseek: "DeepSeek",
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
      // Reading ~/.codex/auth.json for a ChatGPT-plan provider would report (and hold it on) another account's limit.
      // A Claude instance that only runs on an API key has no plan quota; reading the CLI login would repeat the subscription's.
      ...(config?.authMode === "chatgpt-plan" || (driver === "claude" && (config?.usageMeter === false || config?.requireApiKey === true)) ? { noUsage: true as const } : {}),
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
      if (key === "five_hour" || key === "seven_day" || key === "spend" || key === "extra_usage") continue;
      if (!/^[a-z][a-z0-9_]{0,40}$/i.test(key)) continue;
      const window = readClaudeWindow(value);
      if (!window) continue;
      const model = claudeModelWindow(key);
      if (model) addModelWindow(models, model.name, extraLine(model.window, window));
      else extra.push(extraLine(claudeExtraLabel(key), window));
    }
  }
  sortModelWindows(models);
  const fiveHour = (root && readClaudeWindow(root.five_hour)) ?? closedWindow();
  const weekly = (root && readClaudeWindow(root.seven_day)) ?? closedWindow();
  const budget = root && readClaudeBudget(root, fiveHour.available || weekly.available);
  if (budget) extra.unshift(budget);
  return {
    plan: planLabel(root?.subscription_type ?? root?.plan ?? root?.plan_type),
    fiveHour,
    weekly,
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

/** OpenCode Go answers with a meter per window: the running one, the week's and the month's. */
export function parseOpenCodeUsage(body: unknown): PlanWindows {
  const usage = asRecord(asRecord(body)?.usage);
  const [rolling, weekly, monthly] = [usage?.rolling, usage?.weekly, usage?.monthly].map(openCodeMeter);
  return {
    plan: rolling || weekly || monthly ? "Go" : null,
    fiveHour: rolling ?? closedWindow(),
    weekly: weekly ?? closedWindow(),
    extra: monthly ? [extraLine("Monthly", monthly)] : [], models: [],
  };
}

/** One meter of Go's allowance: `percent` is what it has used, and `resetsAt` comes as an ISO stamp. */
function openCodeMeter(value: unknown): PlanWindow | null {
  const record = asRecord(value);
  const used = finiteNumber(record?.percent);
  if (used == null) return null;
  return openWindow(used, isoOrNull(record?.resetsAt));
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
      if (account.driver === "opencode") return readOpenCodeCredential(merged, source.readText, at, source.readOpenCodeDb);
      if (account.driver === "deepseek") { const key = readDeepSeekKey(merged); return key ? { token: key, accountId: null, expired: false } : missingCredential(); }
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
    ...(process.platform === "darwin" && !sealedFixture() ? { readClaudeKeychain: readDarwinClaudeKeychain } : {}),
    ...(sealedFixture() ? {} : { readOpenCodeDb: readOpenCodeDbLogins }),
  });
}

export async function fetchPlanUsage(accounts: PlanAccount[], deps: PlanUsageDeps): Promise<PlanUsageReport> {
  const now = deps.now?.() ?? Date.now();
  const providers = (await Promise.all(accounts.filter((account) => !account.noUsage).map((account) => fetchProvider(account, deps)))).filter((row) => row !== null);
  return { fetchedAt: new Date(now).toISOString(), providers };
}

let cachedReport: { at: number; key: string; accounts: Set<string>; report: PlanUsageReport } | null = null;

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
  if (!input.refresh && cachedReport && now - cachedReport.at < PLAN_USAGE_CACHE_MS) { // a read of more accounts serves a caller that asks for some of them (the limit clock)
    if (cachedReport.key === key) return cachedReport.report;
    if (input.accounts.every((account) => cachedReport!.accounts.has(planUsageCacheKey([account])))) return { ...cachedReport.report, providers: cachedReport.report.providers.filter((row) => input.accounts.some((account) => account.id === row.id)) };
  }
  const report = await fetchPlanUsage(input.accounts, {
    fetch: input.fetch ?? ((url, init) => globalThis.fetch(url, init)),
    credentials: input.credentials ?? defaultCredentialReader(input.env),
    now: () => now,
    timeoutMs: input.timeoutMs,
  });
  cachedReport = { at: now, key, accounts: new Set(input.accounts.map((account) => planUsageCacheKey([account]))), report };
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

const naturalNumber = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;

/** A currency code as the provider sent it, when Intl can name it: Intl.NumberFormat throws on anything else. */
function currencyCode(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value.trim())) return null;
  return value.trim().toUpperCase();
}

function budgetLine(label: string, spend: PlanSpend): PlanExtra | null {
  if (spend.limitMinor <= 0) return null;
  return { ...extraLine(label, openWindow((spend.usedMinor / spend.limitMinor) * 100, null)), spend };
}

function readSpendBudget(value: unknown): PlanExtra | null {
  const spend = asRecord(value);
  if (spend?.enabled !== true) return null;
  const used = asRecord(spend.used), limit = asRecord(spend.limit);
  const currency = currencyCode(used?.currency);
  const exponent = naturalNumber(used?.exponent), usedMinor = naturalNumber(used?.amount_minor), limitMinor = naturalNumber(limit?.amount_minor);
  if (!currency || currency !== currencyCode(limit?.currency) || exponent === null || exponent !== limit?.exponent || usedMinor === null || limitMinor === null) return null;
  return budgetLine(MONTHLY_SPEND, { usedMinor, limitMinor, currency, exponent });
}

/** Claude Code 2.1.312 documents `used_credits` and `monthly_limit` as minor units of `currency` ("cents for USD") and has
 * no field saying how many digits those are, so the currency says. `is_enabled` false: this budget cannot cover a send. */
function readExtraUsage(value: unknown, label: string): PlanExtra | null {
  const extra = asRecord(value);
  if (extra?.is_enabled !== true) return null;
  const currency = currencyCode(extra.currency);
  const usedMinor = naturalNumber(extra.used_credits), limitMinor = naturalNumber(extra.monthly_limit);
  if (currency && usedMinor !== null && limitMinor !== null) {
    const exponent = naturalNumber(extra.decimal_places) ?? currencyDigits(currency);
    const line = exponent === null ? null : budgetLine(label, { usedMinor, limitMinor, currency, exponent });
    if (line) return line;
  }
  const used = finiteNumber(extra.utilization);
  return used === null ? null : extraLine(label, openWindow(used, null));
}

function currencyDigits(currency: string): number | null {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? null;
  } catch {
    return null;
  }
}

/** Whether Claude's paid extra usage is on and not used up, on a plan with rolling windows: sends then go on past a
 * full window and are paid from it. */
export function claudeHasExtraUsageRoom(row: Pick<PlanProviderRow, "driver" | "fiveHour" | "weekly" | "extra">): boolean {
  if (row.driver !== "claude" || !(row.fiveHour.available || row.weekly.available)) return false;
  const budget = row.extra[0];
  return !!budget && (budget.label === EXTRA_USAGE || budget.label === MONTHLY_SPEND) && budget.usedPercent < 100;
}

/** A plan with no rolling windows lives on its monthly budget (Claude Enterprise); on others that budget is the extra usage
 * bought on top of them. */
function readClaudeBudget(root: Record<string, unknown>, hasWindows: boolean): PlanExtra | null {
  return readSpendBudget(root.spend) ?? readExtraUsage(root.extra_usage, hasWindows ? EXTRA_USAGE : MONTHLY_SPEND);
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
    return [account.id, account.driver, account.name, account.configDir ?? "", environment, account.noUsage ? "no-usage" : "usage"].join("\u0000");
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
  return readMacKeychainLogin(service, (raw) => claudeCredentialFromText(decodeKeychainSecret(raw), Date.now()).token != null);
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
  if (!token) return root.auth_mode === "apikey" ? { ...missingCredential(), apiKeyOnly: true } : missingCredential();
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

/** The key saved in Settings, or the login `opencode auth login` keeps: `auth.json` where OpenCode v1 wrote it, else the `credential` table of v2's `opencode.db`. */
function readOpenCodeCredential(env: NodeJS.ProcessEnv, readText: (path: string) => string | null, now: number, readDb?: (path: string) => string | null): PlanCredential {
  const key = secretString(env.OPENCODE_API_KEY);
  if (key) return { token: key, accountId: null, expired: false };
  // auth.json can hold other providers' keys with no OpenCode one, so the database is asked whenever it gave no login.
  const entry = openCodeLogin(env.OPENCODE_AUTH_CONTENT?.trim() || openCodeAuthText(env, readText))
    ?? (readDb ? openCodeLogin(openCodeDbText(env, readDb)) : null);
  const token = secretString(entry?.access) ?? secretString(entry?.key);
  if (!token) return missingCredential();
  const expiry = timeMs(entry?.expires ?? entry?.expires_at ?? entry?.expiresAt);
  if (expiry != null && expiry <= now) return expiredCredential();
  return { token, accountId: null, expired: false };
}

/** A Go login lives under "opencode-go", a Zen one under "opencode"; the CLI lists Go first too. */
function openCodeLogin(raw: string | null): Record<string, unknown> | null {
  const stored = asRecord(parseJson(raw));
  return [stored?.["opencode-go"], stored?.opencode].map((value) => asRecord(value))
    .find((record) => secretString(record?.access) ?? secretString(record?.key)) ?? null;
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

async function fetchProvider(account: PlanAccount, deps: PlanUsageDeps): Promise<PlanProviderRow | null> { // null: nothing to report, such as an engine with no key of its own or one on a pay-per-use API key
  let credential: PlanCredential;
  if (account.driver === "antigravity") { const windows = await antigravityPlanUsage(account.id, deps); return windows && okRow(account, windows); } // null: no sign-in, or Google gave nothing
  const quietWhenMissing = account.driver === "opencode" || account.driver === "deepseek";
  try {
    credential = await deps.credentials.read(account);
  } catch {
    return quietWhenMissing ? null : errorRow(account, signInAgain(account.driver));
  }
  if (credential.apiKeyOnly) return null;
  if (credential.expired || !credential.token) return quietWhenMissing && !credential.expired ? null : errorRow(account, signInAgain(account.driver));
  try {
    if (account.driver === "claude") return await fetchClaude(account, credential.token, deps);
    if (account.driver === "codex") return await fetchCodex(account, credential.token, credential.accountId, deps);
    if (account.driver === "opencode") return await fetchOpenCode(account, credential.token, deps);
    if (account.driver === "deepseek") return await fetchDeepSeek(account, credential.token, deps);
    return await fetchGrok(account, credential.token, deps);
  } catch {
    return errorRow(account, couldNotReach(account.driver));
  }
}

async function fetchDeepSeek(account: PlanAccount, token: string, deps: PlanUsageDeps): Promise<PlanProviderRow> {
  const result = await fetchJson(deps.fetch, DEEPSEEK_BALANCE_URL, { Authorization: `Bearer ${token}`, Accept: "application/json" }, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS);
  if (authRejected(result.status)) return errorRow(account, "DeepSeek refused the saved key");
  if (!result.ok) return errorRow(account, result.status === 0 || result.status >= 500 ? couldNotReach("deepseek") : unexpectedUsage("deepseek"));
  const balance = parseDeepSeekBalance(result.body);
  return balance ? { ...okRow(account, { plan: null, fiveHour: closedWindow(), weekly: closedWindow(), extra: [], models: [] }), balance } : errorRow(account, unexpectedUsage("deepseek"));
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

/** Go's allowance, read with the account's own key or login. A key without a Go subscription answers 403. */
async function fetchOpenCode(account: PlanAccount, token: string, deps: PlanUsageDeps): Promise<PlanProviderRow> {
  const result = await fetchJson(deps.fetch, OPENCODE_GO_USAGE_URL, { Authorization: `Bearer ${token}`, Accept: "application/json" }, deps.timeoutMs ?? PROVIDER_TIMEOUT_MS);
  // 403 is Go's own answer for a key without a Go subscription: the account works and has no allowance to report.
  if (result.status === 403) return okRow(account, { plan: null, fiveHour: closedWindow(), weekly: closedWindow(), extra: [], models: [] });
  if (authRejected(result.status)) return errorRow(account, "OpenCode refused the saved credentials");
  if (!result.ok || result.body === null || typeof result.body !== "object") return errorRow(account, result.status === 0 || result.status >= 500 ? couldNotReach("opencode") : unexpectedUsage("opencode"));
  const windows = parseOpenCodeUsage(result.body);
  // A 200 with no meter at all is not an allowance: it is an answer this row cannot read.
  return windows.plan ? okRow(account, windows) : errorRow(account, unexpectedUsage("opencode"));
}
