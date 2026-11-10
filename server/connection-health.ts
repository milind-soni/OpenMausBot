// Whether each connection a Team Cloud's bots use works, as real use shows it: every tool call, token refresh and Test
// moves it, and a rare background check (connection-health-check.ts) keeps one nothing used lately from resting on an old
// success. Who added a connection and when are kept beside it, from the time this was built.
// Security invariant: only fixed classes, times and the address of the admin who added a connection are kept or answered;
// never a key, token, header value, address or anything a server or tool said.
import { readFileSync } from "node:fs";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

export const CONNECTION_HEALTH_FILE = "connection-health.json";

export const HEALTH_STATES = ["working", "needs-sign-in", "refused", "unreachable"] as const;
export type ConnectionHealthState = typeof HEALTH_STATES[number];

/** Why a connection is not working, as a fixed class. */
export const FAILURE_CLASSES = [
  "sign-in", "expired", "refresh-rejected", "account-inactive",
  "refused", "account-failed",
  "cant-connect", "timeout", "not-found", "bad-answer",
] as const;
export type ConnectionFailure = typeof FAILURE_CLASSES[number];

const SIGNED_OUT: ReadonlySet<ConnectionFailure> = new Set(["sign-in", "expired", "refresh-rejected", "account-inactive"]);
const REFUSED: ReadonlySet<ConnectionFailure> = new Set(["refused", "account-failed"]);
/** A failure to reach a connection counts only once it repeats: one dropped call is not a server that is down. */
export const UNREACHABLE_AFTER = 2;

export type ConnectionKind = "app" | "mcp";
/** A connection, the team's or, with `person`, one member's own (a person key). */
export interface ConnectionRef { kind: ConnectionKind; id: string; person?: string }
export type ConnectionOutcome = { ok: true } | { ok: false; error: ConnectionFailure };

export const healthOf = (error: ConnectionFailure): ConnectionHealthState | null =>
  SIGNED_OUT.has(error) ? "needs-sign-in" : REFUSED.has(error) ? "refused" : null;

/** A connected-apps account's own status word, as one of the four. Unknown words have none. */
export function accountHealth(status: string): { health: ConnectionHealthState; error?: ConnectionFailure } | null {
  const word = status.trim().toUpperCase();
  if (word === "ACTIVE") return { health: "working" };
  if (word === "FAILED") return { health: "refused", error: "account-failed" };
  if (["EXPIRED", "INACTIVE", "INITIATED", "INITIALIZING", "PENDING", "REVOKED", "DISABLED"].includes(word)) return { health: "needs-sign-in", error: "account-inactive" };
  return null;
}

const failureSchema = z.enum(FAILURE_CLASSES);
const keptSchema = z.object({
  health: z.enum(HEALTH_STATES).optional(),
  checkedAt: z.number().optional(),
  lastError: failureSchema.optional(),
  usedAt: z.number().optional(),
  misses: z.number().int().nonnegative().optional(),
  missError: failureSchema.optional(),
});
const fileSchema = z.object({
  v: z.literal(1),
  connections: z.record(z.string(), keptSchema).default({}),
  people: z.record(z.string(), z.record(z.string(), keptSchema)).default({}),
  added: z.record(z.string(), z.object({ email: z.string().max(320), at: z.number() })).default({}),
});
type Kept = z.infer<typeof keptSchema>;
type HealthFile = z.infer<typeof fileSchema>;

export interface ConnectionHealthView {
  health?: ConnectionHealthState;
  checkedAt?: number;
  lastError?: ConnectionFailure;
  lastUsedAt?: number;
}

const key = (kind: ConnectionKind, id: string) => `${kind}:${id}`;

export function createConnectionHealth(options: { file: string; now?: () => number; saveDelayMs?: number }) {
  const now = options.now ?? Date.now;
  let data: HealthFile = { v: 1, connections: {}, people: {}, added: {} };
  try { data = fileSchema.parse(JSON.parse(readFileSync(options.file, "utf8"))); } catch {}
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    try { writeFileAtomic(options.file, `${JSON.stringify(data)}\n`, { mode: 0o600 }); } catch (error) {
      console.warn(`connection health: could not save: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const save = () => {
    if (timer) return;
    timer = setTimeout(flush, options.saveDelayMs ?? 2_000);
    timer.unref?.();
  };
  const slot = (ref: ConnectionRef, create: boolean): Kept | undefined => {
    const k = key(ref.kind, ref.id);
    if (!ref.person) return create ? (data.connections[k] ??= {}) : data.connections[k];
    const own = create ? (data.people[ref.person] ??= {}) : data.people[ref.person];
    return own ? (create ? (own[k] ??= {}) : own[k]) : undefined;
  };

  return {
    /** What a call, refresh or check showed. `use`: a real call (it moves lastUsedAt); a check or a refresh doesn't. */
    observe(ref: ConnectionRef, outcome: ConnectionOutcome, options: { use?: boolean } = {}): ConnectionHealthState | undefined {
      const kept = slot(ref, true)!;
      const at = now();
      if (options.use) kept.usedAt = at;
      if (outcome.ok) {
        Object.assign(kept, { health: "working", checkedAt: at });
        delete kept.lastError; delete kept.misses; delete kept.missError;
      } else {
        const decided = healthOf(outcome.error);
        if (decided) {
          Object.assign(kept, { health: decided, checkedAt: at, lastError: outcome.error });
          delete kept.misses; delete kept.missError;
        } else {
          kept.misses = (kept.misses ?? 0) + 1;
          kept.missError = outcome.error;
          if (kept.misses >= UNREACHABLE_AFTER) Object.assign(kept, { health: "unreachable", checkedAt: at, lastError: outcome.error });
        }
      }
      save();
      return kept.health;
    },
    /** A real call whose outcome says nothing about the connection. */
    used(ref: ConnectionRef): void {
      slot(ref, true)!.usedAt = now();
      save();
    },
    /** It was connected again: what was known about the old connection no longer holds. */
    reset(ref: ConnectionRef): void {
      const kept = slot(ref, false);
      if (!kept) return;
      for (const field of ["health", "checkedAt", "lastError", "misses", "missError"] as const) delete kept[field];
      save();
    },
    get(ref: ConnectionRef): ConnectionHealthView {
      const kept = slot(ref, false);
      if (!kept) return {};
      return {
        ...(kept.health ? { health: kept.health, checkedAt: kept.checkedAt } : {}),
        ...(kept.health && kept.health !== "working" && kept.lastError ? { lastError: kept.lastError } : {}),
        ...(kept.usedAt ? { lastUsedAt: kept.usedAt } : {}),
      };
    },
    /** An admin added the team's connection just now: who and when. Kept until it is removed. */
    added(kind: ConnectionKind, id: string, email: string): void {
      data.added[key(kind, id)] = { email: email.trim().toLowerCase(), at: now() };
      save();
    },
    /** Who added it, when that was recorded. */
    addedBy(kind: ConnectionKind, id: string): { email: string; at: number } | undefined {
      return data.added[key(kind, id)];
    },
    /** It was removed: its health, every member's own, and who added it go. */
    forget(kind: ConnectionKind, id: string): void {
      const k = key(kind, id);
      delete data.connections[k];
      delete data.added[k];
      for (const own of Object.values(data.people)) delete own[k];
      save();
    },
    /** The connections ever seen of a kind, by id: to drop what is gone. */
    known(kind: ConnectionKind): string[] {
      const prefix = `${kind}:`;
      return [...new Set([...Object.keys(data.connections), ...Object.keys(data.added)].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)))];
    },
    /** A member left: everything kept about them goes. */
    forgetPerson(person: string): void {
      delete data.people[person];
      save();
    },
    flush,
  };
}

export type ConnectionHealth = ReturnType<typeof createConnectionHealth>;
