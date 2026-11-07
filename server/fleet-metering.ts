import type { FleetWorkspace } from "./fleet.ts";
import { FLEET_MAX_EVENTS, type FleetWorkspaceStatus } from "./fleet-reseller.ts";
import type { PeopleResult } from "./fleet-tenant-io.ts";

export type { PeopleResult } from "./fleet-tenant-io.ts";

export const DEFAULT_MAX_USERS = 1000;
export const MAX_USERS_LIMIT = 10_000;
/** The longest identity a person can have; an email address is at most 254 characters. */
export const MAX_PERSON_ID = 254;
export const MAX_LEDGER_LINE_BYTES = 1024 * 1024;

const EMAIL = /^[a-z0-9_%+'-]+(?:\.[a-z0-9_%+'-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const isControl = (char: string) => { const code = char.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159); };
export const hasControl = (text: string): boolean => [...text].some(isControl);
export { printable } from "./fleet-printable.ts";

/**
 * Appends a status change to the workspace as it stood before the change. A workspace from a registry that kept no events
 * starts its history with the status it has now, at its creation time, so the months before the change still bill as they did.
 */
export function recordWorkspaceEvent(workspace: FleetWorkspace, status: FleetWorkspaceStatus, at: string): FleetWorkspace {
  if (Number.isNaN(Date.parse(at)) || new Date(at).toISOString() !== at) throw new Error("a workspace event needs an ISO time");
  const created = Date.parse(workspace.createdAt);
  const seed = !Number.isNaN(created) && created < Date.parse(at) ? [{ at: workspace.createdAt, status: workspace.status }] : [];
  const events = [...(workspace.events ?? seed), { at, status }].slice(-FLEET_MAX_EVENTS);
  return { ...workspace, events };
}

/** A lowercased, strictly shaped email address, or undefined. */
export function personEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  const local = email.slice(0, email.indexOf("@"));
  return email.length <= MAX_PERSON_ID && local.length <= 64 && EMAIL.test(email) ? email : undefined;
}

function deviceId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.normalize("NFKC").trim().toLowerCase();
  if (!label || hasControl(label)) return undefined;
  const id = `device:${label}`;
  return id.length <= MAX_PERSON_ID ? id : undefined;
}

/** Sign-in list sizes: whole addresses and `@domain` entries, each counted once however many lists name it. */
export function signInSeats(configText: string | null): { emails: number; domains: number } {
  const seats = { emails: 0, domains: 0 };
  let config: unknown;
  try { config = JSON.parse(configText || "{}"); } catch { return seats; }
  const signIn = config && typeof config === "object" ? (config as { signIn?: unknown }).signIn : undefined;
  if (!signIn || typeof signIn !== "object") return seats;
  const entries = new Set<string>();
  for (const list of [(signIn as { admins?: unknown }).admins, (signIn as { members?: unknown }).members]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) if (typeof item === "string" && item.trim()) entries.add(item.trim().toLowerCase());
  }
  for (const entry of entries) {
    if (entry.startsWith("@")) seats.domains++;
    else if (entry.includes("@")) seats.emails++;
  }
  return seats;
}

export function monthWindow(month: string): { start: number; end: number } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw new Error("month must be YYYY-MM");
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  return { start: Date.UTC(year, index, 1), end: Date.UTC(year, index + 1, 1) };
}

export function checkMaxUsers(maxUsers: number | undefined): number {
  const limit = maxUsers ?? DEFAULT_MAX_USERS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_USERS_LIMIT) throw new Error(`--max-users takes a whole number from 1 to ${MAX_USERS_LIMIT}`);
  return limit;
}

interface Person { kind: "email" | "device"; asked: number; attributed: number; costUsd: number | null }

const validRow = (row: unknown): row is { at: string; costUsd?: unknown; trigger: { kind: string; email?: unknown; label?: unknown }; outcome?: unknown } => {
  if (!row || typeof row !== "object") return false;
  const value = row as Record<string, unknown>;
  const trigger = value.trigger as Record<string, unknown> | null;
  return typeof value.at === "string" && typeof value.botId === "string" && typeof value.model === "string" && typeof value.input === "number" && typeof value.output === "number" && Boolean(trigger) && typeof trigger === "object" && typeof trigger!.kind === "string";
};

const succeeded = (outcome: unknown): boolean => outcome === undefined || (Boolean(outcome) && typeof outcome === "object" && (outcome as { status?: unknown }).status === "ok");

function cost(row: { costUsd?: unknown }): number | null {
  return typeof row.costUsd === "number" && Number.isFinite(row.costUsd) && row.costUsd >= 0 ? row.costUsd : null;
}

function addCost(total: number | null, amount: number | null): number | null {
  if (amount === null) return total;
  const sum = (total ?? 0) + amount;
  if (!Number.isFinite(sum)) throw new Error("workspace usage total exceeds numeric range");
  return sum;
}

/**
 * The TS twin of the helper that runs as the workspace's own user, and the oracle the filesystem suite compares it to.
 * A month's distinct human askers: a ledger row of kind `user` that succeeded, keyed by its email or else its device label.
 * Owner, routine, bot and helper rows are never a seat; an email on them adds cost to that person only when they are one.
 */
export function meterLedgerText(text: string, month: string, maxUsers?: number, config: string | null = null): PeopleResult {
  const limit = checkMaxUsers(maxUsers);
  const { start, end } = monthWindow(month);
  const people = new Map<string, Person>();
  const result = { turns: 0, costUsd: null as number | null, ignoredLines: 0, unattributedTurns: 0 };
  const deferred: { key: string; cost: number | null }[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = Buffer.byteLength(line) > MAX_LEDGER_LINE_BYTES ? undefined : JSON.parse(line); } catch { row = undefined; }
    if (!validRow(row)) { result.ignoredLines++; continue; }
    const at = Date.parse(row.at);
    if (Number.isNaN(at)) { result.ignoredLines++; continue; }
    if (!(at >= start && at < end)) continue;
    const amount = cost(row);
    result.turns++;
    result.costUsd = addCost(result.costUsd, amount);
    const human = row.trigger.kind === "user";
    const key = human ? personEmail(row.trigger.email) ?? deviceId(row.trigger.label) : personEmail(row.trigger.email);
    if (human && succeeded(row.outcome)) {
      if (!key) { result.unattributedTurns++; continue; }
      let person = people.get(key);
      if (!person) {
        if (people.size >= limit) throw new Error(`more than ${limit} distinct people asked this workspace in ${month}`);
        person = { kind: key.startsWith("device:") ? "device" : "email", asked: 0, attributed: 0, costUsd: null };
        people.set(key, person);
      }
      person.asked++;
      person.attributed++;
      person.costUsd = addCost(person.costUsd, amount);
    } else if (key) deferred.push({ key, cost: amount });
  }
  for (const row of deferred) {
    const person = people.get(row.key);
    if (!person) continue;
    person.attributed++;
    person.costUsd = addCost(person.costUsd, row.cost);
  }
  return {
    v: 1,
    month,
    ...result,
    people: [...people].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, person]) => ({ id, ...person })),
    seats: signInSeats(config),
  };
}
