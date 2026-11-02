import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomicIfChanged } from "../atomic.ts";
import type { InstanceId, ProviderSnapshot } from "../contracts.ts";

export interface EngineStatusRow {
  instanceId: InstanceId;
  driverKind: string;
  cli: string | null;
  snapshot: ProviderSnapshot;
}

type Target = (instanceId: InstanceId) => { driverKind: string; cli: string | null } | null;

const text = (value: unknown): value is string => typeof value === "string";
const flag = (value: unknown): value is boolean => typeof value === "boolean";

function strings<K extends string>(value: unknown, keys: readonly K[]): Record<K, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return keys.every((key) => text(record[key])) ? Object.fromEntries(keys.map((key) => [key, record[key]])) as Record<K, string> : undefined;
}

function account(value: unknown): ProviderSnapshot["account"] {
  if (!value || typeof value !== "object") return undefined;
  const { email, organization, method } = value as Record<string, unknown>;
  return {
    ...(text(email) ? { email } : {}),
    ...(text(organization) ? { organization } : {}),
    ...(method === "login" || method === "api-key" ? { method } : {}),
  };
}

export function snapshotFrom(value: unknown): ProviderSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.state !== "available" && raw.state !== "unavailable") return null;
  const update = strings(raw.update, ["title", "message", "command"] as const);
  const warning = strings(raw.warning, ["title", "message"] as const);
  const signedInAs = account(raw.account);
  return {
    state: raw.state,
    ...(text(raw.reason) ? { reason: raw.reason } : {}),
    ...(flag(raw.authenticated) ? { authenticated: raw.authenticated } : {}),
    ...(flag(raw.chatgptPlan) ? { chatgptPlan: raw.chatgptPlan } : {}),
    // Until the start-up read reaches it, OpenCode on its free models alone still ranks and reads as the backup it is.
    ...(flag(raw.freeFallback) ? { freeFallback: raw.freeFallback } : {}),
    ...(text(raw.authenticationUnavailableReason) ? { authenticationUnavailableReason: raw.authenticationUnavailableReason } : {}),
    ...(signedInAs ? { account: signedInAs } : {}),
    ...(text(raw.version) || raw.version === null ? { version: raw.version } : {}),
    ...(update ? { update } : {}),
    ...(raw.billing === "metered" || raw.billing === "subscription" ? { billing: raw.billing } : {}),
    ...(warning ? { warning } : {}),
  };
}

/** At most one write a second, of the latest rows: the start-up read lands a probe at a time, and on Windows each
 * rename onto a file a scanner holds is retried for up to ~155 ms. */
export const STATUS_SAVE_DELAY_MS = 1_000;

const unsaved = new Set<() => void>();
let exitHooked = false;

/** Writes what every file's delay still holds. A clean exit runs it, so a stopped Cloud's next wake starts from the
 * latest status; a hard kill (SIGKILL, kill() on Windows) loses at most that second, until the next read corrects it. */
export function flushEngineStatusFiles(): void {
  for (const write of unsaved) write();
}

/** Account display identity only, never credentials; kept beside the engines' other local state under providers/. */
export function engineStatusFile(file: string) {
  let saved: string | undefined;
  let pending: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  const write = () => {
    unsaved.delete(write);
    if (timer) clearTimeout(timer);
    timer = undefined;
    const body = pending;
    pending = undefined;
    if (body === undefined || body === saved) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileAtomicIfChanged(file, body, { mode: 0o600, durable: false });
      saved = body;
    } catch {
    }
  };
  return {
    /** The statuses the last run recorded, for the engines still configured with the same driver and CLI. */
    read(target: Target): Map<InstanceId, ProviderSnapshot> {
      const seeds = new Map<InstanceId, ProviderSnapshot>();
      let rows: unknown;
      try {
        rows = (JSON.parse(readFileSync(file, "utf8")) as { engines?: unknown }).engines;
      } catch {
        return seeds;
      }
      if (!Array.isArray(rows)) return seeds;
      for (const row of rows as Array<Partial<Record<keyof EngineStatusRow, unknown>>>) {
        if (!row || !text(row.instanceId)) continue;
        const now = target(row.instanceId);
        const snapshot = snapshotFrom(row.snapshot);
        if (snapshot && now && now.driverKind === row.driverKind && now.cli === (row.cli ?? null)) seeds.set(row.instanceId, snapshot);
      }
      return seeds;
    },
    save(rows: readonly EngineStatusRow[]): void {
      pending = JSON.stringify({ v: 1, engines: rows });
      if (pending === saved) {
        pending = undefined;
        return;
      }
      if (!timer) {
        timer = setTimeout(write, STATUS_SAVE_DELAY_MS);
        timer.unref?.();
        unsaved.add(write);
        if (!exitHooked) {
          exitHooked = true;
          process.once("exit", flushEngineStatusFiles);
        }
      }
    },
  };
}
