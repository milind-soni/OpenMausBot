import { posix } from "node:path";
import type { FleetBillingMoney, FleetBillingReport, FleetBillingUser, FleetBillingWorkspace } from "../shared/fleet-billing.ts";
import type { FleetDeps, FleetInput, FleetIo } from "./fleet-cli.ts";
import { assertManagedWorkspace, fleetLayout, fleetUser, parseRegistry, workspaceDataDir, type FleetLayout, type FleetRegistry, type FleetStep, type FleetWorkspace } from "./fleet.ts";
import { monthWindow, printable } from "./fleet-metering.ts";
import { TWO_DECIMAL_CURRENCIES, type FleetReseller, type RateSet } from "./fleet-reseller.ts";
import { csvCell, csvNumber } from "./usage-ledger.ts";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const FOOTER = "This report is built from tenant-reported ledgers; evidence, not enforcement.";
const METER_CONCURRENCY = 4;
const REQUIRED_FEATURES = ["admin", "billing"] as const;

export function billingMonth(raw: string | undefined, now: Date): string {
  const current = now.toISOString().slice(0, 7);
  if (raw === undefined) return current;
  if (!MONTH.test(raw)) throw new Error(`the month must look like ${current} (YYYY-MM, UTC)`);
  if (raw > current) throw new Error(`${raw} has not started yet; the latest month is ${current}`);
  return raw;
}

function ranDuring(workspace: FleetWorkspace, start: number, end: number): boolean {
  if (workspace.events?.length) {
    const events = [...workspace.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let atStart: string | undefined;
    for (const event of events) {
      const at = Date.parse(event.at);
      if (at <= start) atStart = event.status;
      else if (at < end && event.status === "running") return true;
    }
    return atStart === "running";
  }
  if (workspace.status !== "running") return false;
  const created = Date.parse(workspace.createdAt);
  return Number.isNaN(created) || created < end;
}

export function isBillableWorkspace(workspace: FleetWorkspace, month: string, hasUsage: boolean): { billable: boolean; reason: FleetBillingWorkspace["billableReason"] } {
  const { start, end } = monthWindow(month);
  if (ranDuring(workspace, start, end)) return { billable: true, reason: "running" };
  return hasUsage ? { billable: true, reason: "usage" } : { billable: false, reason: "none" };
}

function whole(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error("a billing amount is too large to count in whole minor units");
  return value;
}

function charge(billable: boolean, users: number | null, rates: RateSet): FleetBillingMoney {
  const workspaceMinor = billable ? rates.workspaceMonthMinor : 0;
  const usersMinor = users === null ? null : whole(users * rates.userMonthMinor);
  return { workspaceMinor, usersMinor, totalMinor: usersMinor === null ? null : whole(workspaceMinor + usersMinor) };
}

export function priceWorkspace(input: { reseller: FleetReseller; workspace: FleetWorkspace; billable: boolean; users: number | null }): { wholesale: FleetBillingMoney; retail: FleetBillingMoney; marginMinor: number | null } {
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
  const billing = isBillableWorkspace(workspace, month, (metered?.turns ?? 0) > 0);
  const users = ledgerOk ? (metered?.people.length ?? 0) : null;
  const priced = priceWorkspace({ reseller, workspace, billable: billing.billable, users });
  const people: FleetBillingUser[] | undefined = detail && ledgerOk
    ? (metered?.people ?? []).map((person) => ({ ...person })).sort((a, b) => b.attributed - a.attributed || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    : undefined;
  return {
    ...base,
    billable: billing.billable,
    billableReason: billing.reason,
    ledger: ledgerOk ? "ok" : "unavailable",
    ...(unavailableReason ? { unavailableReason } : {}),
    turns: ledgerOk ? (metered?.turns ?? 0) : null,
    costUsd: ledgerOk ? (metered?.costUsd ?? null) : null,
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

function closingLines(input: { layout: FleetLayout; deps: FleetDeps; month: string; currency: string; taken: Set<string> }): FleetBillingWorkspace[] {
  const directory = posix.join(input.layout.billingDir, "closing");
  const lines: FleetBillingWorkspace[] = [];
  for (const name of [...(input.deps.listDir?.(directory) ?? [])].sort()) {
    if (!name.endsWith(".json")) continue;
    const text = input.deps.readText(posix.join(directory, name));
    if (text === null) continue;
    const snapshot = parseClosing(text, name);
    if (snapshot.month !== input.month || input.taken.has(snapshot.workspace.workspaceId)) continue;
    if (snapshot.currency !== input.currency) throw new Error(`closing snapshot ${name} is in ${snapshot.currency} but this fleet bills in ${input.currency}`);
    lines.push(snapshot.workspace);
  }
  return lines;
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
  const closed = closingLines({ layout: input.layout, deps: input.deps, month, currency: reseller.currency, taken: new Set(lines.map((line) => line.workspaceId)) })
    .map(({ users, ...line }) => (input.detail && users ? { ...line, users } : line));
  const all = [...lines, ...closed].sort((a, b) => a.slug.localeCompare(b.slug) || (a.workspaceId < b.workspaceId ? -1 : 1));
  return {
    version: 1,
    reseller: { name: reseller.name },
    month,
    currency: reseller.currency,
    generatedAt: now.toISOString(),
    final: month < now.toISOString().slice(0, 7),
    basis: "tenant-reported-ledger",
    complete: all.every((line) => line.ledger === "ok"),
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
    row([text(report.month), "workspace", text(line.slug), text(line.host), "", "", "", csvNumber(line.turns), csvNumber(line.costUsd), String(line.billable), line.ledger, csvNumber(line.wholesale.totalMinor), csvNumber(line.retail.totalMinor), csvNumber(line.marginMinor), text(report.currency)]);
    for (const user of line.users ?? []) {
      row([text(report.month), "user", text(line.slug), text(line.host), text(user.id), user.kind, csvNumber(user.asked), csvNumber(user.attributed), csvNumber(user.costUsd), "", "", "", "", "", text(report.currency)]);
    }
  }
  const priced = report.workspaces.filter((line) => line.costUsd !== null);
  const cost = report.complete && priced.length ? priced.reduce((total, line) => total + line.costUsd!, 0) : null;
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
      plain(line.slug), plain(line.host), plain(line.status), line.billable ? `yes (${line.billableReason})` : "no",
      known ? String(line.activeUsers) : "?", known ? String(line.turns) : "?", known ? (line.costUsd === null ? "-" : line.costUsd.toFixed(4)) : "?",
      formatMinor(line.wholesale.totalMinor), formatMinor(line.retail.totalMinor), formatMinor(line.marginMinor),
    ]));
    for (const user of line.users ?? []) out.push(`    ${plain(user.id)}  asked ${user.asked}, attributed ${user.attributed}${user.costUsd === null ? "" : `, ${user.costUsd.toFixed(4)} USD`}`);
  }
  out.push("");
  const totals = report.totals;
  out.push(cells(["TOTAL", `${totals.workspaces} workspace${totals.workspaces === 1 ? "" : "s"}`, "", "", totals.activeUsers === null ? "?" : String(totals.activeUsers), "", "", formatMinor(totals.wholesaleMinor), formatMinor(totals.retailMinor), formatMinor(totals.marginMinor)]));
  if (!report.complete) {
    out.push("");
    out.push("INCOMPLETE: these ledgers could not be read, so their lines and the totals that depend on them are unavailable:");
    for (const line of report.workspaces) if (line.ledger === "unavailable") out.push(`  ${plain(line.slug)}: ${plain(line.unavailableReason ?? "unavailable")}`);
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
  try {
    const registry = readRegistry(context.layout, context.deps);
    if (!registry.reseller) return { status: 409, body: { error: "this fleet has no reseller yet: run `openmausbot fleet init --yes --reseller-name NAME` first" } };
    return { status: 200, body: await buildBillingReport({ registry, layout: context.layout, deps: context.deps, month, detail: query.get("detail") === "true", now: context.now }) };
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

export function planFleetRates(input: FleetInput, deps: FleetDeps): FleetStep[] {
  const layout = fleetLayout(input.root ?? "/");
  const registry = readRegistry(layout, deps);
  const reseller = registry.reseller;
  if (!reseller) throw new Error("this fleet has no reseller yet: run `openmausbot fleet init --yes --reseller-name NAME` first");
  const patch = input.ratesPatch;
  if (input.currency !== undefined && !TWO_DECIMAL_CURRENCIES.has(input.currency)) throw new Error(`--currency ${input.currency} is not supported; use a currency with two decimals, such as USD, EUR or GBP`);
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
  if (!registry.reseller || !workspace) return;
  assertManagedWorkspace(workspace);
  const month = now.toISOString().slice(0, 7);
  const report = await buildBillingReport({ registry: { ...registry, workspaces: { [workspace.slug]: workspace } }, layout, deps, month, detail: true, now });
  const line = report.workspaces[0];
  if (!line) throw new Error(`could not take the closing billing snapshot for ${input.slug}; the workspace was not deleted`);
  const snapshot: ClosingSnapshot = { version: 1, month, closedAt: now.toISOString(), currency: report.currency, workspace: { ...line, status: "deleted" } };
  const directory = posix.join(layout.billingDir, "closing");
  try {
    deps.mkdir(directory, 0o700);
    deps.writeText(posix.join(directory, `${line.workspaceId}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, 0o600);
  } catch (error) {
    throw new Error(`could not write the closing billing snapshot for ${input.slug} (${error instanceof Error ? error.message : String(error)}); the workspace was not deleted`);
  }
}
