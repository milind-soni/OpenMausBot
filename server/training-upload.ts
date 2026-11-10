// Sharing training data with the MausBot team (docs/training-data.md), only while Training data is set to "share".
// Turns recorded since sharing was turned on that ended well go up, each as its whole conversation (the last step's
// request and answer), gzipped, in batches; the rows on disk are the queue and `upload.json` keeps how far it got.
// POST <origin>/api/training-data {v, contributorId, consentVersion, turns} answers 201 {accepted}; 400 or 413 {error};
// 429 {error, retryAfter}. The contributor id is random, so the team can delete one install's turns on request.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { writeFileAtomic } from "./atomic.ts";
import { PRODUCTION_CLOUD_ORIGIN, STAGING_CLOUD_ORIGIN } from "./devs-report-send.ts";
import type { TrainingLog, TrainingOutcomeRow, TrainingStepRow } from "./training-log.ts";

export const TRAINING_DATA_PATH = "/api/training-data";
export const CONSENT_VERSION = 1;
export const UPLOAD_LIMITS = { gzipBytes: 1024 * 1024, rawBytes: 8 * 1024 * 1024, everyMs: 60 * 60_000, retryMs: 30 * 60_000, timeoutMs: 30_000 } as const;

export interface SharedTurn {
  turnId: string;
  model: string;
  driverKind: string;
  local: boolean;
  tools: unknown[];
  /** The conversation the model saw on its last step, then its answer. */
  messages: unknown[];
  steps: number;
  endedAt: string;
}

interface UploadState {
  contributorId: string;
  /** When sharing was turned on; nothing recorded before it goes. Null while sharing is off. */
  shareSince: string | null;
  /** The end of the last turn sent (or refused): later outcomes are the queue. */
  cursor: string | null;
  sentTurns: number;
  refusedTurns: number;
  lastSentAt: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
}

export type UploadStatus = Omit<UploadState, "contributorId" | "cursor">;

/** OMB_TRAINING_DATA_URL (https, or http on loopback for fixtures), else a Cloud home's Admin origin, else the staging
 * or production Cloud: the same rules as the @devs report endpoint. */
export function trainingDataEndpoint(env: NodeJS.ProcessEnv, cloudOrigin?: string | null): string {
  const explicit = env.OMB_TRAINING_DATA_URL?.trim();
  if (explicit) {
    try {
      const url = new URL(explicit);
      const loopback = url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
      if ((url.protocol === "https:" || loopback) && !url.username && !url.password) return url.href;
    } catch { /* not an address: the default below */ }
  }
  const origin = cloudOrigin ?? (env.OMB_CLOUD_STAGING === "1" ? STAGING_CLOUD_ORIGIN : PRODUCTION_CLOUD_ORIGIN);
  return `${origin.replace(/\/+$/, "")}${TRAINING_DATA_PATH}`;
}

/** Each turn that ended ok after `after` and began no earlier than `since`, whole, in the order they ended. Its steps
 * may sit in the day before its outcome. */
export function sharedTurns(log: TrainingLog, after: string, since: string): SharedTurn[] {
  const days = log.days();
  const turns: SharedTurn[] = [];
  let previous: TrainingStepRow[] = [];
  for (const day of days) {
    const rows = log.rows(day);
    const steps = [...previous, ...rows.filter((row): row is TrainingStepRow => row.kind === "step")];
    const byTurn = new Map<string, TrainingStepRow[]>();
    for (const step of steps) byTurn.set(step.turnId, [...(byTurn.get(step.turnId) ?? []), step]);
    for (const outcome of rows.filter((row): row is TrainingOutcomeRow => row.kind === "outcome")) {
      if (!outcome.ok || outcome.at <= after) continue;
      const own = (byTurn.get(outcome.turnId) ?? []).sort((a, b) => a.round - b.round);
      const last = own.at(-1);
      if (!last || own[0]!.at < since) continue;
      turns.push({ turnId: outcome.turnId, model: last.model, driverKind: last.driverKind, local: last.local, tools: last.tools,
        messages: [...last.messages, last.completion], steps: own.length, endedAt: outcome.at });
    }
    previous = rows.filter((row): row is TrainingStepRow => row.kind === "step");
  }
  return turns;
}

type SendAnswer = { ok: true } | { ok: false; retry: boolean; error: string; retryAfterMs?: number };

export class TrainingUploader {
  private readonly file: string;
  private readonly deps: {
    log: TrainingLog;
    dir: string;
    endpoint: () => string;
    /** False where this install may not share: a Team Cloud member's session, a hosted workspace. */
    allowed: () => boolean;
    fetch?: typeof fetch;
    now?: () => number;
  };
  private running = false;

  constructor(deps: TrainingUploader["deps"]) {
    this.deps = deps;
    this.file = join(deps.dir, "upload.json");
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private state(): UploadState {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as UploadState;
    } catch {
      return { contributorId: randomBytes(16).toString("hex"), shareSince: null, cursor: null, sentTurns: 0, refusedTurns: 0, lastSentAt: null, lastError: null, nextAttemptAt: null };
    }
  }

  private save(state: UploadState): void {
    mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }

  status(): UploadStatus {
    const { contributorId: _id, cursor: _cursor, ...rest } = this.state();
    return rest;
  }

  /** Called often and cheaply: notes when sharing starts or stops, and sends at most once an hour while it is on. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const state = this.state();
      const sharing = this.deps.log.currentMode() === "share" && this.deps.allowed();
      const nowIso = new Date(this.now()).toISOString();
      if (!sharing) {
        if (state.shareSince !== null) this.save({ ...state, shareSince: null, nextAttemptAt: null });
        return;
      }
      if (state.shareSince === null) {
        this.save({ ...state, shareSince: nowIso, cursor: nowIso, nextAttemptAt: new Date(this.now() + UPLOAD_LIMITS.everyMs).toISOString() });
        return;
      }
      if (state.nextAttemptAt && state.nextAttemptAt > nowIso) return;
      await this.send(state);
    } finally {
      this.running = false;
    }
  }

  private async send(state: UploadState): Promise<void> {
    const pending = sharedTurns(this.deps.log, state.cursor ?? state.shareSince!, state.shareSince!);
    let next = { ...state, nextAttemptAt: new Date(this.now() + UPLOAD_LIMITS.everyMs).toISOString() };
    while (pending.length) {
      const batch = this.batch(pending, next.contributorId);
      if (!batch.body) {
        // One turn too large to send at all: skipped, never retried.
        next = { ...next, cursor: pending.shift()!.endedAt, refusedTurns: next.refusedTurns + 1 };
        continue;
      }
      const answer = await this.post(batch.body);
      if (!answer.ok && answer.retry) {
        next = { ...next, lastError: answer.error, nextAttemptAt: new Date(this.now() + (answer.retryAfterMs ?? UPLOAD_LIMITS.retryMs)).toISOString() };
        break;
      }
      const sent = pending.splice(0, batch.count);
      next = answer.ok
        ? { ...next, cursor: sent.at(-1)!.endedAt, sentTurns: next.sentTurns + sent.length, lastSentAt: new Date(this.now()).toISOString(), lastError: null }
        : { ...next, cursor: sent.at(-1)!.endedAt, refusedTurns: next.refusedTurns + sent.length, lastError: answer.error };
    }
    this.save(next);
  }

  /** As many of the first turns as fit one request, gzipped. */
  private batch(turns: readonly SharedTurn[], contributorId: string): { body: Buffer | null; count: number } {
    let count = 0, raw = 0;
    while (count < turns.length && raw + Buffer.byteLength(JSON.stringify(turns[count])) <= UPLOAD_LIMITS.rawBytes) raw += Buffer.byteLength(JSON.stringify(turns[count++]));
    while (count > 0) {
      const body = gzipSync(JSON.stringify({ v: 1, contributorId, consentVersion: CONSENT_VERSION, turns: turns.slice(0, count) }));
      if (body.byteLength <= UPLOAD_LIMITS.gzipBytes) return { body, count };
      count = Math.floor(count / 2);
    }
    return { body: null, count: 1 };
  }

  private async post(body: Buffer): Promise<SendAnswer> {
    let response: Response;
    try {
      response = await (this.deps.fetch ?? fetch)(this.deps.endpoint(), {
        method: "POST", redirect: "error", cache: "no-store", body: new Uint8Array(body),
        headers: { accept: "application/json", "content-type": "application/json", "content-encoding": "gzip" },
        signal: AbortSignal.timeout(UPLOAD_LIMITS.timeoutMs),
      });
    } catch {
      return { ok: false, retry: true, error: "offline" };
    }
    const text = await response.text().catch(() => "");
    let answer: { error?: unknown; retryAfter?: unknown } = {};
    try { answer = JSON.parse(text.slice(0, 16_384)) as typeof answer; } catch { /* not JSON */ }
    if (response.status === 200 || response.status === 201) return { ok: true };
    const error = typeof answer.error === "string" ? answer.error.replace(/\p{Cc}+/gu, " ").slice(0, 200) : `HTTP ${response.status}`;
    if (response.status === 429) {
      const seconds = Number(answer.retryAfter ?? response.headers.get("retry-after"));
      return { ok: false, retry: true, error, ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: seconds * 1000 } : {}) };
    }
    return { ok: false, retry: response.status >= 500, error };
  }
}
