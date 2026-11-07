import { posix } from "node:path";
import type { FleetBillingMoney, FleetBillingReport, FleetBillingUser, FleetBillingWorkspace } from "../shared/fleet-billing.ts";
import type { FleetDeps, FleetInput, FleetIo } from "./fleet-cli.ts";
import { assertManagedWorkspace, fleetLayout, fleetUser, parseRegistry, workspaceDataDir, type FleetLayout, type FleetRegistry, type FleetStep, type FleetWorkspace } from "./fleet.ts";
import { MAX_USERS_LIMIT, monthWindow, printable } from "./fleet-metering.ts";
import { TWO_DECIMAL_CURRENCIES, type FleetReseller, type RateSet } from "./fleet-reseller.ts";
import { csvCell, csvNumber } from "./usage-ledger.ts";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const FOOTER = "This report is built from tenant-reported ledgers; evidence, not enforcement.";
const METER_CONCURRENCY = 4;
const roundUsd = (value: number | null): number | null => (value === null ? null : Math.round(value * 1e6) / 1e6);
const REQUIRED_FEATURES = ["admin", "billing"] as const;

export function billingMonth(raw: string | undefined, now: Date): string {
  const current = now.toISOString().slice(0, 7);
  if (raw === undefined) return current;
  if (!MONTH.test(raw)) throw new Error(`the month must look like ${current} (YYYY-MM, UTC)`);
  if (raw > current) throw new Error(`${raw} has not started yet; the latest month is ${current}`);
  return raw;
}

function ranDuring(workspace: FleetWorkspace, start: number, end: number): boolean {
  const created = Date.parse(workspace.createdAt);
  if (!Number.isNaN(created) && created >= end) return false;
  if (workspace.events?.length) {
    const events = [...workspace.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const [first] = events;
    const trimmed = first!.at !== workspace.createdAt && Date.parse(first!.at) > start;
    let atStart: string | undefined = trimmed ? (first!.status === "running" ? "suspended" : "running") : undefined;
    for (const event of events) {
      const at = Date.parse(event.at);
      if (at <= start) atStart = event.status;
      else if (at < end && event.status === "running") return true;
    }
    return atStart === "running";
  }
  return workspace.status === "running";
}

/** `hasUsage` is `null` when the ledger could not be read. */
export function isBillableWorkspace(workspace: FleetWorkspace, month: string, hasUsage: boolean | null): { billable: boolean | null; reason: FleetBillingWorkspace["billableReason"] } {
  const { start, end } = monthWindow(month);
  if (ranDuring(workspace, start, end)) return { billable: true, reason: "running" };
  if (hasUsage === null) return { billable: null, reason: "unknown" };
  return hasUsage ? { billable: true, reason: "usage" } : { billable: false, reason: "none" };
}

function whole(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error("a billing amount is too large to count in whole minor units");
  return value;
}

function charge(billable: boolean | null, users: number | null, rates: RateSet): FleetBillingMoney {
  if (billable === null) return { workspaceMinor: null, usersMinor: null, totalMinor: null };
  const workspaceMinor = billable ? rates.workspaceMonthMinor : 0;
  const usersMinor = users === null ? null : whole(users * rates.userMonthMinor);
  return { workspaceMinor, usersMinor, totalMinor: usersMinor === null ? null : whole(workspaceMinor + usersMinor) };
}

export function priceWorkspace(input: { reseller: FleetReseller; workspace: FleetWorkspace; billable: boolean | null; users: number | null }): { wholesale: FleetBillingMoney; retail: FleetBillingMoney; marginMinor: number | null } {
  const { reseller, workspace, billable, users } = input;
  const wholesale = charge(billable, users, reseller.wholesale);
  const retail = charge(billable, users, { ...reseller.retail, ...workspace.retailOverride });
  return { wholesale, retail, marginMinor: wholesale.totalMinor === null || retail.totalMinor === null ? null : whole(retail.totalMinor - wholesale.totalMinor) };
}

const workspaceIdOf = (workspace: Pick<FleetWorkspace, "slug" | "createdAt">) => `${workspace.slug}@${workspace.createdAt}`;

const reasonOf = (error: unknown): string => printable(error instanceof Error ? error.message : "the ledger could not be read").slice(0, 200);

async function lineFor(input: { reseller: FleetReseller; layout: FleetLayout; deps: FleetDeps; month: string; detail: boolean; maxUsers?: number }, workspace: FleetWorkspace): Promise<FleetBillingWorkspace> {
  const { reseller, layout, deps, month, detail, maxUsers } = input;
  const base = { workspaceId: workspaceIdOf(workspace), slug: workspace.slug, host: workspace.host, status: workspace.status };
  // A reservation that never served has no ledger to read and no account to read it as.
  const neverServed = workspace.status === "provisioning" || workspace.status === "error";
  let metered: Awaited<ReturnType<NonNullable<FleetDeps["people"]>>> | null = null;
  let unavailableReason: string | undefined;
  if (!neverServed) {
    try {
      if (!deps.people) throw new Error("this fleet build cannot meter a workspace's people");
      metered = await deps.people(workspaceDataDir(layout, workspace.slug), fleetUser(workspace.slug), month, maxUsers);
    } catch (error) {
      unavailableReason = reasonOf(error);
    }
  }
  const ledgerOk = neverServed || metered !== null;
  const billing = isBillableWorkspace(workspace, month, ledgerOk ? (metered?.turns ?? 0) > 0 : null);
  const users = ledgerOk ? (metered?.people.length ?? 0) : null;
  const priced = priceWorkspace({ reseller, workspace, billable: billing.billable, users });
  const people: FleetBillingUser[] | undefined = detail && ledgerOk
    ? (metered?.people ?? []).map((person) => ({ ...person, costUsd: roundUsd(person.costUsd) })).sort((a, b) => b.attributed - a.attributed || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    : undefined;
  return {
    ...base,
    billable: billing.billable,
    billableReason: billing.reason,
    ledger: ledgerOk ? "ok" : "unavailable",
    ...(unavailableReason ? { unavailableReason } : {}),
    turns: ledgerOk ? (metered?.turns ?? 0) : null,
    costUsd: ledgerOk ? roundUsd(metered?.costUsd ?? null) : null,
    activeUsers: users,
    provisionedSeats: ledgerOk ? (metered?.seats ?? { emails: 0, domains: 0 }) : null,
    wholesale: priced.wholesale,
    retail: priced.retail,
    marginMinor: priced.marginMinor,
    ...(people ? { users: people } : {}),
  };
}

interface ClosingSnapshot { version: 1; month: string; closedAt: string; currency: string; workspace: FleetBillingWorkspace }

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isMoney = (value: unknown): boolean => isRecord(value) && typeof value.workspaceMinor === "number" && [value.usersMinor, value.totalMinor].every((item) => item === null || typeof item === "number");

function parseClosing(text: string, name: string): ClosingSnapshot {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`closing snapshot ${name} is not JSON; restore or remove it before billing`); }
  const line = isRecord(value) ? value.workspace : undefined;
  if (!isRecord(value) || value.version !== 1 || typeof value.month !== "string" || !MONTH.test(value.month) || typeof value.closedAt !== "string" || typeof value.currency !== "string" || !isRecord(line)
    || typeof line.workspaceId !== "string" || typeof line.slug !== "string" || typeof line.host !== "string" || typeof line.billable !== "boolean" || !isMoney(line.wholesale) || !isMoney(line.retail)) {
    throw new Error(`closing snapshot ${name} is malformed; restore or remove it before billing`);
  }
  return value as unknown as ClosingSnapshot;
}

const closingName = (workspaceId: string, month: string) => `${workspaceId}@${month}.json`;

function closingLines(input: { layout: FleetLayout; deps: FleetDeps; month: string; currency: string; taken: Set<string> }): { lines: FleetBillingWorkspace[]; skipped: string[] } {
  const directory = posix.join(input.layout.billingDir, "closing");
  const suffix = `@${input.month}.json`;
  const lines: FleetBillingWorkspace[] = [];
  const skipped: string[] = [];
  for (const name of [...(input.deps.listDir?.(directory) ?? [])].sort()) {
    if (!name.endsWith(suffix)) continue;
    try {
      const text = input.deps.readText(posix.join(directory, name));
      if (text === null) continue;
      const snapshot = parseClosing(text, name);
      if (snapshot.month !== input.month) throw new Error(`closing snapshot ${name} says it is for ${snapshot.month}`);
      if (input.taken.has(snapshot.workspace.workspaceId)) continue;
      if (snapshot.currency !== input.currency) throw new Error(`closing snapshot ${name} is in ${snapshot.currency} but this fleet bills in ${input.currency}`);
      lines.push(snapshot.workspace);
    } catch (error) {
      skipped.push(`${reasonOf(error)}; skipped, so a deleted workspace may be missing from this month`);
    }
  }
  return { lines, skipped };
}

function sum(values: (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total = whole(total + value);
  }
  return total;
}

export async function buildBillingReport(input: { registry: FleetRegistry; layout: FleetLayout; deps: FleetDeps; month: string; detail: boolean; now: Date; maxUsers?: number }): Promise<FleetBillingReport> {
  const { registry, month, now } = input;
  const reseller = registry.reseller;
  if (!reseller) throw new Error("this fleet has no reseller yet: run `openmausbot fleet init --yes --reseller-name NAME` first");
  const workspaces = Object.values(registry.workspaces).sort((a, b) => a.slug.localeCompare(b.slug));
  const lines: FleetBillingWorkspace[] = [];
  for (let index = 0; index < workspaces.length; index += METER_CONCURRENCY) {
    lines.push(...await Promise.all(workspaces.slice(index, index + METER_CONCURRENCY).map((workspace) => lineFor({ ...input, reseller }, workspace))));
  }
  const snapshots = closingLines({ layout: input.layout, deps: input.deps, month, currency: reseller.currency, taken: new Set(lines.map((line) => line.workspaceId)) });
  const closed = snapshots.lines.map(({ users, ...line }) => (input.detail && users ? { ...line, users } : line));
  const all = [...lines, ...closed].sort((a, b) => a.slug.localeCompare(b.slug) || (a.workspaceId < b.workspaceId ? -1 : 1));
  return {
    version: 1,
    reseller: { name: reseller.name },
    month,
    currency: reseller.currency,
    generatedAt: now.toISOString(),
    final: month < now.toISOString().slice(0, 7),
    basis: "tenant-reported-ledger",
    complete: all.every((line) => line.ledger === "ok" && line.billable !== null) && snapshots.skipped.length === 0,
    ...(snapshots.skipped.length ? { skippedSnapshots: snapshots.skipped } : {}),
    workspaces: all,
    totals: {
      workspaces: all.length,
      activeUsers: sum(all.map((line) => line.activeUsers)),
      wholesaleMinor: sum(all.map((line) => line.wholesale.totalMinor)),
      retailMinor: sum(all.map((line) => line.retail.totalMinor)),
      marginMinor: sum(all.map((line) => line.marginMinor)),
    },
  };
}

function formatMinor(minor: number | null): string {
  if (minor === null) return "unavailable";
  const sign = minor < 0 ? "-" : "";
  const absolute = Math.abs(minor);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

const HEADER = ["month", "row_type", "workspace", "host", "user", "user_kind", "asked_turns", "attributed_turns", "cost_usd", "billable", "ledger", "wholesale_minor", "retail_minor", "margin_minor", "currency"];

export function billingCsv(report: FleetBillingReport): string {
  const rows: string[] = [HEADER.join(",")];
  const text = (value: string) => csvCell(value);
  const row = (cells: string[]) => rows.push(cells.join(","));
  for (const line of report.workspaces) {
    row([text(report.month), "workspace", text(line.slug), text(line.host), "", "", "", csvNumber(line.turns), csvNumber(roundUsd(line.costUsd)), line.billable === null ? "" : String(line.billable), line.ledger, csvNumber(line.wholesale.totalMinor), csvNumber(line.retail.totalMinor), csvNumber(line.marginMinor), text(report.currency)]);
    for (const user of line.users ?? []) {
      row([text(report.month), "user", text(line.slug), text(line.host), text(user.id), user.kind, csvNumber(user.asked), csvNumber(user.attributed), csvNumber(roundUsd(user.costUsd)), "", "", "", "", "", text(report.currency)]);
    }
  }
  const priced = report.workspaces.filter((line) => line.costUsd !== null);
  const cost = report.complete && priced.length ? roundUsd(priced.reduce((total, line) => total + line.costUsd!, 0)) : null;
  const turns = sum(report.workspaces.map((line) => line.turns));
  row([text(report.month), "total", "", "", "", "", "", csvNumber(turns), csvNumber(cost), "", report.complete ? "ok" : "unavailable", csvNumber(report.totals.wholesaleMinor), csvNumber(report.totals.retailMinor), csvNumber(report.totals.marginMinor), text(report.currency)]);
  return `${rows.join("\n")}\n`;
}

const plain = printable;

export function billingText(report: FleetBillingReport): string {
  const out: string[] = [];
  out.push(`Billing for ${report.month} (UTC), ${plain(report.reseller.name)}, amounts in ${report.currency}`);
  out.push(report.final ? `Month closed; report made ${report.generatedAt}.` : `Month still running: counts are as of ${report.generatedAt}.`);
  out.push("");
  const cells = (parts: string[]) => `${parts[0]!.padEnd(22)} ${parts[1]!.padEnd(34)} ${parts[2]!.padEnd(10)} ${parts[3]!.padEnd(9)} ${parts[4]!.padStart(5)} ${parts[5]!.padStart(7)} ${parts[6]!.padStart(9)} ${parts[7]!.padStart(11)} ${parts[8]!.padStart(11)} ${parts[9]!.padStart(11)}`;
  out.push(cells(["WORKSPACE", "HOST", "STATUS", "BILLABLE", "USERS", "TURNS", "COST USD", "WHOLESALE", "RETAIL", "MARGIN"]));
  for (const line of report.workspaces) {
    const known = line.ledger === "ok";
    out.push(cells([
      plain(line.slug), plain(line.host), plain(line.status), line.billable === null ? "?" : line.billable ? `yes (${line.billableReason})` : "no",
      known ? String(line.activeUsers) : "?", known ? String(line.turns) : "?", known ? (line.costUsd === null ? "-" : line.costUsd.toFixed(4)) : "?",
      formatMinor(line.wholesale.totalMinor), formatMinor(line.retail.totalMinor), formatMinor(line.marginMinor),
    ]));
    for (const user of line.users ?? []) out.push(`    ${plain(user.id)}  asked ${user.asked}, attributed ${user.attributed}${user.costUsd === null ? "" : `, ${user.costUsd.toFixed(4)} USD`}`);
  }
  out.push("");
  const totals = report.totals;
  out.push(cells(["TOTAL", `${totals.workspaces} workspace${totals.workspaces === 1 ? "" : "s"}`, "", "", totals.activeUsers === null ? "?" : String(totals.activeUsers), "", "", formatMinor(totals.wholesaleMinor), formatMinor(totals.retailMinor), formatMinor(totals.marginMinor)]));
  const unreadable = report.workspaces.filter((line) => line.ledger === "unavailable");
  if (unreadable.length) {
    out.push("");
    out.push("INCOMPLETE: these ledgers could not be read, so their lines and the totals that depend on them are unavailable:");
    for (const line of unreadable) out.push(`  ${plain(line.slug)}: ${plain(line.unavailableReason ?? "unavailable")}${line.billable === null ? " (billable unknown)" : ""}`);
  }
  if (report.skippedSnapshots?.length) {
    out.push("");
    out.push("INCOMPLETE: these closing snapshots of deleted workspaces were skipped:");
    for (const note of report.skippedSnapshots) out.push(`  ${plain(note)}`);
  }
  out.push("");
  out.push(FOOTER);
  return out.join("\n");
}

export async function assertBillingEntitled(input: FleetInput, deps: FleetDeps): Promise<void> {
  if (!deps.entitlements) throw new Error("this fleet build cannot check the licence for fleet billing");
  const entitled = await deps.entitlements(input.licenseKey);
  const missing = REQUIRED_FEATURES.filter((feature) => !entitled(feature));
  if (missing.length) {
    throw new Error(`fleet billing needs an enterprise licence with the ${REQUIRED_FEATURES.join(" and ")} features (missing: ${missing.join(", ")}); pass --license-key-file or set OMB_LICENSE_KEY`);
  }
}

function readRegistry(layout: FleetLayout, deps: FleetDeps): FleetRegistry {
  const text = deps.readText(layout.registryFile);
  if (text === null) throw new Error("no fleet on this server yet: run `openmausbot fleet init --domain your.domain` first");
  return parseRegistry(text);
}

export async function runFleetBilling(input: FleetInput, io: FleetIo, deps: FleetDeps): Promise<number> {
  try {
    await assertBillingEntitled(input, deps);
    const now = new Date();
    const month = billingMonth(input.month, now);
    const layout = fleetLayout(input.root ?? "/");
    const report = await buildBillingReport({ registry: readRegistry(layout, deps), layout, deps, month, detail: input.detail === true, now, maxUsers: input.maxUsers });
    io.log((input.csv ? billingCsv(report) : billingText(report)).replace(/\n$/, ""));
    return report.complete ? 0 : 1;
  } catch (error) {
    io.error(`fleet: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

/** The root agent's answer: no licence state here, because the socket's permissions decide who may ask. */
export async function billingReply(query: URLSearchParams, context: { layout: FleetLayout; deps: FleetDeps; now: Date }): Promise<{ status: number; body: unknown }> {
  let month: string;
  try { month = billingMonth(query.get("month") ?? undefined, context.now); }
  catch (error) { return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } }; }
  const rawMaxUsers = query.get("maxUsers");
  const maxUsers = rawMaxUsers === null ? undefined : Number(rawMaxUsers);
  if (rawMaxUsers !== null && !(/^\d+$/.test(rawMaxUsers) && maxUsers! >= 1 && maxUsers! <= MAX_USERS_LIMIT)) {
    return { status: 400, body: { error: `maxUsers takes a whole number from 1 to ${MAX_USERS_LIMIT}` } };
  }
  try {
    const registry = readRegistry(context.layout, context.deps);
    if (!registry.reseller) return { status: 409, body: { error: "this fleet has no reseller yet: run `openmausbot fleet init --yes --reseller-name NAME` first" } };
    return { status: 200, body: await buildBillingReport({ registry, layout: context.layout, deps: context.deps, month, detail: query.get("detail") === "true", now: context.now, maxUsers }) };
  } catch (error) {
    return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

function applyRates(current: RateSet, patch: Partial<RateSet> | undefined): RateSet {
  return { ...current, ...patch };
}

const rateLine = (label: string, rates: Partial<RateSet>, currency: string) => {
  const parts = [
    ...(rates.workspaceMonthMinor === undefined ? [] : [`${formatMinor(rates.workspaceMonthMinor)} per workspace`]),
    ...(rates.userMonthMinor === undefined ? [] : [`${formatMinor(rates.userMonthMinor)} per user`]),
  ];
  return `${label}: ${parts.join(", ") || "no rates"} per month in ${currency}`;
};

function refuseCurrencyChangeWithSnapshots(layout: FleetLayout, deps: FleetDeps, currency: string): void {
  const month = new Date().toISOString().slice(0, 7);
  const directory = posix.join(layout.billingDir, "closing");
  for (const name of [...(deps.listDir?.(directory) ?? [])].sort()) {
    if (!name.endsWith(`@${month}.json`)) continue;
    let held: unknown;
    try { held = (JSON.parse(deps.readText(posix.join(directory, name)) ?? "null") as { currency?: unknown } | null)?.currency; } catch { continue; }
    if (typeof held === "string" && held !== currency) {
      throw new Error(`closing snapshots for ${month} are in ${held}, so --currency ${currency} would mix two currencies in one report; change the currency in the first days of next month, after billing ${month}`);
    }
  }
}

export function planFleetRates(input: FleetInput, deps: FleetDeps): FleetStep[] {
  const layout = fleetLayout(input.root ?? "/");
  const registry = readRegistry(layout, deps);
  const reseller = registry.reseller;
  if (!reseller) throw new Error("this fleet has no reseller yet: run `openmausbot fleet init --yes --reseller-name NAME` first");
  const patch = input.ratesPatch;
  if (input.currency !== undefined && !TWO_DECIMAL_CURRENCIES.has(input.currency)) throw new Error(`--currency ${input.currency} is not supported; use a currency with two decimals, such as USD, EUR or GBP`);
  if (input.currency !== undefined) refuseCurrencyChangeWithSnapshots(layout, deps, input.currency);
  const overrides = patch?.overrides ?? {};
  const cleared = patch?.clearOverrides ?? [];
  for (const slug of [...Object.keys(overrides), ...cleared]) if (!registry.workspaces[slug]) throw new Error(`no workspace "${slug}"`);
  for (const slug of cleared) if (slug in overrides) throw new Error(`${slug} cannot be both set and cleared`);
  const changed = input.currency !== undefined || patch?.wholesale || patch?.retail || Object.keys(overrides).length || cleared.length;
  if (!changed) {
    const lines = [
      `currency ${reseller.currency}`,
      rateLine("wholesale (what you owe the vendor)", reseller.wholesale, reseller.currency),
      rateLine("retail (what you charge)", reseller.retail, reseller.currency),
      ...Object.values(registry.workspaces).filter((workspace) => workspace.retailOverride).map((workspace) => rateLine(`retail override for ${workspace.slug}`, workspace.retailOverride!, reseller.currency)),
    ];
    return lines.map((text): FleetStep => ({ kind: "note", text }));
  }
  const next: FleetRegistry = {
    ...registry,
    reseller: {
      ...reseller,
      currency: input.currency ?? reseller.currency,
      wholesale: applyRates(reseller.wholesale, patch?.wholesale),
      retail: applyRates(reseller.retail, patch?.retail),
    },
    workspaces: Object.fromEntries(Object.entries(registry.workspaces).map(([slug, workspace]) => {
      if (cleared.includes(slug)) {
        const { retailOverride: _cleared, ...rest } = workspace;
        return [slug, rest];
      }
      return [slug, overrides[slug] ? { ...workspace, retailOverride: { ...workspace.retailOverride, ...overrides[slug] } } : workspace];
    })),
  };
  const content = `${JSON.stringify(next, null, 2)}\n`;
  parseRegistry(content);
  const after = next.reseller!;
  return [
    { kind: "write", path: layout.registryFile, content, mode: 0o600 },
    { kind: "note", text: `rates saved: currency ${after.currency}; wholesale ${formatMinor(after.wholesale.workspaceMonthMinor)} per workspace and ${formatMinor(after.wholesale.userMonthMinor)} per user; retail ${formatMinor(after.retail.workspaceMonthMinor)} per workspace and ${formatMinor(after.retail.userMonthMinor)} per user, per month` },
    ...Object.keys(overrides).map((slug): FleetStep => ({ kind: "note", text: `retail override for ${slug}: ${JSON.stringify(next.workspaces[slug]!.retailOverride)}` })),
    ...cleared.map((slug): FleetStep => ({ kind: "note", text: `retail override for ${slug} cleared` })),
  ];
}

export async function snapshotBeforeDelete(input: FleetInput, deps: FleetDeps, now: Date): Promise<void> {
  if (input.action !== "delete" || !input.yes || input.keepData || !input.slug) return;
  const layout = fleetLayout(input.root ?? "/");
  const text = deps.readText(layout.registryFile);
  if (text === null) return;
  const registry = parseRegistry(text);
  const workspace = registry.workspaces[input.slug];
  const reseller = registry.reseller;
  if (!reseller || !workspace) return;
  assertManagedWorkspace(workspace);
  const current = now.toISOString().slice(0, 7);
  const created = Date.parse(workspace.createdAt);
  const previous = new Date(monthWindow(current).start - 1).toISOString().slice(0, 7);
  const months = Number.isNaN(created) || created < monthWindow(current).start ? [previous, current] : [current];
  const directory = posix.join(layout.billingDir, "closing");
  for (const month of months) {
    const line = await lineFor({ reseller, layout, deps, month, detail: true }, workspace);
    const path = posix.join(directory, closingName(line.workspaceId, month));
    if (month !== current && deps.readText(path) !== null) continue;
    const snapshot: ClosingSnapshot = { version: 1, month, closedAt: now.toISOString(), currency: reseller.currency, workspace: { ...line, status: "deleted" } };
    try {
      deps.mkdir(directory, 0o700);
      deps.writeText(path, `${JSON.stringify(snapshot, null, 2)}\n`, 0o600);
    } catch (error) {
      throw new Error(`could not write the closing billing snapshot for ${input.slug} (${error instanceof Error ? error.message : String(error)}); the workspace was not deleted`);
    }
  }
}
