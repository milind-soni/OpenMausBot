// Commands with receipts — the one shape every NEW mutation takes from
// Phase 0 on (docs/plans/2026-09-14-phase-0-foundation.md, item 0.5).
//
// A command is `{kind, key}` plus whatever the caller applies. Its receipt
// is written in the same SQLite transaction as the command's own rows, so a
// crash between "applied" and "recorded" cannot happen, and a retry with the
// same (kind, key) — a re-delivered hook, a wake that fired twice, a boot
// drain replaying a queue — returns the first result instead of applying a
// second time. Side effects that must not run twice belong INSIDE `apply`;
// anything after `runCommand` returns should be idempotent on its own.
//
// Deliberately small (t3code's decider/receipt shape without the rest of
// the CQRS zoo): no event log, no projections. Those arrive only if a later
// phase needs them.
import { readCommandReceipt, withCommandReceipt } from "./message-db.ts";

export interface Command {
  /** Stable, dotted name of the mutation: "digest.append", "hook.ingest". */
  kind: string;
  /** Idempotency key within the kind — a turn id, a tool_use_id, a ticket. */
  key: string;
}

export interface CommandReceipt<T = unknown> {
  kind: string;
  key: string;
  at: number;
  result: T;
}

/** Apply `apply` once for this (kind, key) and return its result. A repeat
 * returns the stored result without calling `apply`. Results must be JSON
 * values; `undefined` is stored as `null`. */
export function runCommand<T>(command: Command, apply: () => T, now: () => number = Date.now): T {
  const { result } = withCommandReceipt(
    command.kind,
    command.key,
    () => JSON.stringify(apply() ?? null),
    now(),
  );
  return JSON.parse(result) as T;
}

export function commandReceipt<T = unknown>(kind: string, key: string): CommandReceipt<T> | null {
  const stored = readCommandReceipt(kind, key);
  if (!stored) return null;
  return { kind: stored.kind, key: stored.key, at: stored.at, result: JSON.parse(stored.result) as T };
}
