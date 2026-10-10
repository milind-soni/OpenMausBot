import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const PROFILE_ID = /^[a-z0-9_-]{1,40}$/;
const PROFILE_PARTITION_ID = /^[A-Za-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PENDING = 512;
const missingFileErrorSchema = z.looseObject({ code: z.literal("ENOENT") });

const browserCleanupTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    requestId: z.string().regex(REQUEST_ID),
    kind: z.literal("bot"),
    id: z.string().regex(BOT_ID),
    phase: z.enum(["prepared", "committed"]),
  }).strict(),
  z.object({
    requestId: z.string().regex(REQUEST_ID),
    kind: z.literal("profile"),
    id: z.string().regex(PROFILE_ID).refine((id) => id !== "guest"),
    partitionId: z.string().regex(PROFILE_PARTITION_ID).refine((id) => id !== "guest"),
    phase: z.enum(["prepared", "committed"]),
  }).strict(),
]);
const browserCleanupJournalSchema = z.array(browserCleanupTargetSchema).max(MAX_PENDING).superRefine((entries, ctx) => {
  const requestIds = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (!requestIds.has(entry.requestId)) {
      requestIds.add(entry.requestId);
      continue;
    }
    ctx.addIssue({
      code: "custom",
      path: [index, "requestId"],
      message: "duplicate browser cleanup request id",
    });
  }
});
const browserCleanupResultSchema = z.object({
  type: z.literal("openmausbot:browser-lifecycle-result"),
  requestId: z.string().regex(REQUEST_ID),
  ok: z.boolean(),
}).strict();

export type BrowserCleanupKind = "bot" | "profile";
export type BrowserCleanupRequest = z.infer<typeof browserCleanupTargetSchema>;
export type BrowserCleanupWireRequest = {
  type: "openmausbot:browser-bot-deleted" | "openmausbot:browser-profile-deleted";
  requestId: string;
  botId?: string;
  partitionId?: string;
};
export interface BrowserCleanupIncomingMessage {
  type?: string;
  requestId?: string;
  ok?: boolean;
}

type CleanupJournalWriter = (path: string, data: string, options: { mode?: number }) => void;

/** Finish cleanup after the primary config mutation is already durable.
 * Journal/ACK failures are reported only after mandatory runtime effects run;
 * otherwise a failed bookkeeping write could leave a revoked feature's live
 * bearer or provider fleet active until restart. */
export async function finalizeBrowserCleanupMutation<T>(options: {
  requests: readonly BrowserCleanupRequest[];
  referenceError?: unknown;
  commit: (request: BrowserCleanupRequest) => BrowserCleanupRequest;
  ensure: (request: BrowserCleanupRequest) => Promise<boolean>;
  mandatory: () => Promise<T>;
}): Promise<{ value: T; acknowledgements: boolean[] }> {
  let firstError: unknown | null = options.referenceError ?? null;
  const pendingAcknowledgements: Array<Promise<boolean>> = [];
  if (firstError === null) {
    for (const request of options.requests) {
      try {
        const committed = options.commit(request);
        pendingAcknowledgements.push(options.ensure(committed));
      } catch (error) {
        firstError = error;
        break;
      }
    }
  }

  let value!: T;
  try {
    value = await options.mandatory();
  } catch (error) {
    if (firstError === null) firstError = error;
  }

  const settled = await Promise.allSettled(pendingAcknowledgements);
  const acknowledgements = settled.map((result) => result.status === "fulfilled" && result.value);
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (firstError === null && rejected) firstError = rejected.reason;
  if (firstError !== null) throw firstError;
  return { value, acknowledgements };
}

function unavailableJournalError(error: Error): Error & { status: number } {
  return Object.assign(new Error(
    "The browser cleanup journal could not be read safely. Browser profile reuse and deletion are blocked "
    + `until the journal is repaired (${error.message}).`,
  ), { status: 503, cause: error });
}

export function requireBrowserCleanupAcknowledged(ok: boolean, target: string): void {
  if (ok) return;
  const error = Object.assign(new Error(
    `${target} was removed, but OpenMausBot could not confirm its local browser data was erased. `
    + "Restart the desktop app before reusing it; cleanup will retry automatically.",
  ), { status: 503 });
  throw error;
}

type Waiter = {
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

function validTarget(kind: BrowserCleanupKind, id: string, partitionId: string): boolean {
  return kind === "bot"
    ? BOT_ID.test(id)
    : PROFILE_ID.test(id) && id !== "guest" && PROFILE_PARTITION_ID.test(partitionId) && partitionId !== "guest";
}


/**
 * Crash-safe handoff from the embedded server to Electron. A deletion is
 * journaled in the prepared phase before its durable config/store mutation.
 * The caller advances it to committed only after that mutation returns. Only
 * committed entries may be dispatched to Electron. A crash in the narrow
 * mutation-to-marker window therefore leaves a prepared entry which blocks
 * identifier reuse, but can never trigger a destructive wipe based on an
 * ambiguous or unreadable config/store snapshot.
 */
export class BrowserCleanupCoordinator {
  readonly #file: string;
  readonly #send: (message: BrowserCleanupWireRequest) => boolean;
  readonly #timeoutMs: number;
  readonly #retryMs: readonly number[];
  readonly #write: CleanupJournalWriter;
  readonly #pending = new Map<string, BrowserCleanupRequest>();
  readonly #waiters = new Map<string, Waiter>();
  readonly #inflight = new Map<string, Promise<boolean>>();
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #loadFailure: (Error & { status: number }) | null = null;

  constructor(options: {
    file: string;
    send: (message: BrowserCleanupWireRequest) => boolean;
    timeoutMs?: number;
    retryMs?: readonly number[];
    write?: CleanupJournalWriter;
  }) {
    this.#file = options.file;
    this.#send = options.send;
    this.#timeoutMs = Math.max(10, options.timeoutMs ?? 10_000);
    this.#retryMs = options.retryMs?.length ? options.retryMs : [1_000, 5_000, 30_000, 120_000];
    this.#write = options.write ?? writeFileAtomic;
    this.#load();
  }

  #load(): void {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#file, "utf8"));
      const journal = browserCleanupJournalSchema.safeParse(raw);
      if (!journal.success) {
        throw new Error(`invalid browser cleanup journal: ${journal.error.issues[0]?.message ?? "invalid entry"}`);
      }
      for (const request of journal.data) this.#pending.set(request.requestId, request);
    } catch (caught) {
      // A missing journal is the only empty state. Treat malformed JSON,
      // invalid entries, permissions failures, directories, and I/O errors as
      // unknown durable state: silently replacing any of them could resurrect
      // a supposedly deleted login partition.
      if (missingFileErrorSchema.safeParse(caught).success) return;
      const error = caught instanceof Error ? caught : new Error(String(caught));
      this.#loadFailure = unavailableJournalError(error);
    }
  }

  #assertHealthy(): void {
    if (this.#loadFailure) throw this.#loadFailure;
  }

  #save(): void {
    this.#assertHealthy();
    this.#write(this.#file, JSON.stringify([...this.#pending.values()], null, 2), { mode: 0o600 });
  }

  prepare(kind: BrowserCleanupKind, id: string, partitionId = id): BrowserCleanupRequest {
    this.#assertHealthy();
    if (!validTarget(kind, id, partitionId)) throw new Error(`invalid browser ${kind} cleanup target`);
    const existing = [...this.#pending.values()].find((request) => request.kind === kind && request.id === id);
    if (existing) return existing;
    if (this.#pending.size >= MAX_PENDING) throw new Error("too many pending browser data cleanups");
    const request: BrowserCleanupRequest = kind === "bot"
      ? { requestId: randomUUID(), kind, id, phase: "prepared" }
      : { requestId: randomUUID(), kind, id, partitionId, phase: "prepared" };
    this.#pending.set(request.requestId, request);
    try {
      this.#save();
    } catch (error) {
      this.#pending.delete(request.requestId);
      throw error;
    }
    return request;
  }

  /** Mark the primary config/store deletion durable. This marker is the only
   * authority startup replay uses; in-memory loaders are deliberately not
   * consulted because both currently recover parse failures as empty state. */
  commit(request: BrowserCleanupRequest): BrowserCleanupRequest {
    this.#assertHealthy();
    const current = this.#pending.get(request.requestId);
    if (!current || current.kind !== request.kind || current.id !== request.id) {
      throw new Error("unknown browser cleanup request");
    }
    if (current.phase === "committed") return current;
    const committed = { ...current, phase: "committed" as const } satisfies BrowserCleanupRequest;
    this.#pending.set(request.requestId, committed);
    try {
      this.#save();
    } catch (error) {
      this.#pending.set(request.requestId, current);
      throw error;
    }
    return committed;
  }

  abort(request: BrowserCleanupRequest): void {
    this.#assertHealthy();
    if (!this.#pending.has(request.requestId)) return;
    if (this.#pending.get(request.requestId)?.phase === "committed") {
      throw new Error("cannot abort a committed browser cleanup");
    }
    this.#pending.delete(request.requestId);
    try {
      this.#save();
    } catch (error) {
      this.#pending.set(request.requestId, request);
      throw error;
    }
  }

  pending(): BrowserCleanupRequest[] {
    this.#assertHealthy();
    return [...this.#pending.values()];
  }

  hasPendingProfile(profileId: string, partitionId = profileId): boolean {
    this.#assertHealthy();
    const foldedPartitionId = partitionId.toLowerCase();
    return [...this.#pending.values()].some((request) =>
      request.kind === "profile"
      && (request.id === profileId || request.partitionId.toLowerCase() === foldedPartitionId));
  }

  /** Profile references are secondary durable state. Before a committed wipe
   * is replayed at boot, the server clears every bot that still names one of
   * these canonical ids. Prepared entries are deliberately excluded because
   * their primary config deletion may not have committed. */
  committedProfileIds(): string[] {
    this.#assertHealthy();
    return [...new Set(
      [...this.#pending.values()]
        .filter((request): request is Extract<BrowserCleanupRequest, { kind: "profile" }> =>
          request.kind === "profile" && request.phase === "committed")
        .map((request) => request.id),
    )];
  }

  /** Consume only this protocol's result. A late success still clears the
   * durable journal even when the request's timeout already fired. */
  receive(message: BrowserCleanupIncomingMessage | undefined): boolean {
    if (message?.type !== "openmausbot:browser-lifecycle-result") return false;
    const parsed = browserCleanupResultSchema.safeParse(message);
    if (!parsed.success) throw new Error("invalid browser lifecycle result");
    const result = parsed.data;
    const completed = result.ok ? this.#finish(result.requestId) : false;
    const waiter = this.#waiters.get(result.requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.#waiters.delete(result.requestId);
      waiter.resolve(result.ok && completed);
    }
    return true;
  }

  #finish(requestId: string): boolean {
    const request = this.#pending.get(requestId);
    if (!request) return true;
    if (request.phase !== "committed") return false;
    this.#pending.delete(requestId);
    try {
      this.#save();
    } catch (error) {
      // Repeating a successful wipe is safe. Keep the in-memory item when the
      // acknowledgement itself could not be persisted, so a later retry or
      // restart cannot accidentally treat stale credentials as erased.
      this.#pending.set(requestId, request);
      console.error("browser cleanup: could not persist acknowledgement", error);
      return false;
    }
    const retry = this.#retryTimers.get(requestId);
    if (retry) clearTimeout(retry);
    this.#retryTimers.delete(requestId);
    return true;
  }

  async #attempt(request: BrowserCleanupRequest): Promise<boolean> {
    const current = this.#pending.get(request.requestId);
    if (!current) return true;
    if (current.phase !== "committed") return false;
    const result = new Promise<boolean>((resolve) => {
      const prior = this.#waiters.get(request.requestId);
      if (prior) {
        clearTimeout(prior.timer);
        prior.resolve(false);
      }
      const timer = setTimeout(() => {
        if (this.#waiters.get(request.requestId)?.timer !== timer) return;
        this.#waiters.delete(request.requestId);
        resolve(false);
      }, this.#timeoutMs);
      timer.unref?.();
      this.#waiters.set(request.requestId, { resolve, timer });
    });
    const sent = this.#send({
      type: current.kind === "bot"
        ? "openmausbot:browser-bot-deleted"
        : "openmausbot:browser-profile-deleted",
      requestId: current.requestId,
      ...(current.kind === "bot" ? { botId: current.id } : { partitionId: current.partitionId }),
    });
    if (!sent) {
      const waiter = this.#waiters.get(request.requestId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(request.requestId);
        waiter.resolve(false);
      }
    }
    return result;
  }

  async ensure(request: BrowserCleanupRequest): Promise<boolean> {
    this.#assertHealthy();
    const current = this.#pending.get(request.requestId);
    if (!current) return true;
    if (current.phase !== "committed") return false;
    const active = this.#inflight.get(request.requestId);
    if (active) return active;
    const operation = this.#attempt(current).finally(() => {
      if (this.#inflight.get(request.requestId) === operation) this.#inflight.delete(request.requestId);
    });
    this.#inflight.set(request.requestId, operation);
    const ok = await operation;
    if (!ok && this.#pending.has(request.requestId)) this.#schedule(current, 0);
    return ok;
  }

  #schedule(request: BrowserCleanupRequest, attempt: number): void {
    if (
      this.#retryTimers.has(request.requestId) ||
      this.#pending.get(request.requestId)?.phase !== "committed"
    ) return;
    const delay = this.#retryMs[Math.min(attempt, this.#retryMs.length - 1)]!;
    const timer = setTimeout(() => {
      this.#retryTimers.delete(request.requestId);
      void this.#attempt(request).then((ok) => {
        if (!ok && this.#pending.has(request.requestId)) this.#schedule(request, attempt + 1);
      });
    }, delay);
    timer.unref?.();
    this.#retryTimers.set(request.requestId, timer);
  }

  startPending(): void {
    if (this.#loadFailure) {
      console.error(`browser cleanup: ${this.#loadFailure.message}`);
      return;
    }
    for (const request of this.#pending.values()) {
      if (request.phase === "committed") this.#schedule(request, 0);
    }
  }
}
