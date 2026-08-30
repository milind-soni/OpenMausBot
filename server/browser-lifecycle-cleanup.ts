import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";

const BOT_ID = /^[A-Za-z0-9_-]{1,120}$/;
const PROFILE_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PENDING = 512;

const browserCleanupRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    requestId: z.string().regex(REQUEST_ID),
    kind: z.literal("bot"),
    id: z.string().regex(BOT_ID),
  }).strict(),
  z.object({
    requestId: z.string().regex(REQUEST_ID),
    kind: z.literal("profile"),
    id: z.string().regex(PROFILE_ID).refine((id) => id !== "guest"),
  }).strict(),
]);
const browserCleanupResultSchema = z.object({
  type: z.literal("openmausbot:browser-lifecycle-result"),
  requestId: z.string().regex(REQUEST_ID),
  ok: z.boolean(),
}).strict();

export type BrowserCleanupKind = "bot" | "profile";
export type BrowserCleanupRequest = z.infer<typeof browserCleanupRequestSchema>;
export type BrowserCleanupWireRequest = {
  type: "openmausbot:browser-bot-deleted" | "openmausbot:browser-profile-deleted";
  requestId: string;
  botId?: string;
  profileId?: string;
};
export interface BrowserCleanupIncomingMessage {
  type?: string;
  requestId?: string;
  ok?: boolean;
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

function validTarget(kind: BrowserCleanupKind, id: string): boolean {
  return kind === "bot" ? BOT_ID.test(id) : PROFILE_ID.test(id) && id !== "guest";
}


/**
 * Crash-safe handoff from the embedded server to Electron. A deletion is
 * journaled before its durable config/store mutation. Once that mutation is
 * known to have committed, Electron is asked to wipe the corresponding
 * partition and the journal entry remains until Electron acknowledges it.
 */
export class BrowserCleanupCoordinator {
  readonly #file: string;
  readonly #send: (message: BrowserCleanupWireRequest) => boolean;
  readonly #timeoutMs: number;
  readonly #retryMs: readonly number[];
  readonly #pending = new Map<string, BrowserCleanupRequest>();
  readonly #waiters = new Map<string, Waiter>();
  readonly #inflight = new Map<string, Promise<boolean>>();
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: {
    file: string;
    send: (message: BrowserCleanupWireRequest) => boolean;
    timeoutMs?: number;
    retryMs?: readonly number[];
  }) {
    this.#file = options.file;
    this.#send = options.send;
    this.#timeoutMs = Math.max(10, options.timeoutMs ?? 10_000);
    this.#retryMs = options.retryMs?.length ? options.retryMs : [1_000, 5_000, 30_000, 120_000];
    this.#load();
  }

  #load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.#file, "utf8"));
      if (!Array.isArray(raw)) return;
      for (const value of raw.slice(0, MAX_PENDING)) {
        const request = browserCleanupRequestSchema.safeParse(value);
        if (request.success) this.#pending.set(request.data.requestId, request.data);
      }
    } catch {
      // Fresh install (or an unreadable journal): there is nothing safe to
      // dispatch until a new deletion records its intent.
    }
  }

  #save(): void {
    writeFileAtomic(this.#file, JSON.stringify([...this.#pending.values()], null, 2), { mode: 0o600 });
  }

  prepare(kind: BrowserCleanupKind, id: string): BrowserCleanupRequest {
    if (!validTarget(kind, id)) throw new Error(`invalid browser ${kind} cleanup target`);
    const existing = [...this.#pending.values()].find((request) => request.kind === kind && request.id === id);
    if (existing) return existing;
    if (this.#pending.size >= MAX_PENDING) throw new Error("too many pending browser data cleanups");
    const request = { requestId: randomUUID(), kind, id } satisfies BrowserCleanupRequest;
    this.#pending.set(request.requestId, request);
    try {
      this.#save();
    } catch (error) {
      this.#pending.delete(request.requestId);
      throw error;
    }
    return request;
  }

  abort(request: BrowserCleanupRequest): void {
    if (!this.#pending.has(request.requestId)) return;
    this.#pending.delete(request.requestId);
    try {
      this.#save();
    } catch (error) {
      this.#pending.set(request.requestId, request);
      throw error;
    }
  }

  /** Remove pre-commit intents left by a crash. The caller owns the durable
   * config/store check that decides whether each deletion actually committed. */
  reconcile(committed: (request: BrowserCleanupRequest) => boolean): void {
    const removed: BrowserCleanupRequest[] = [];
    for (const request of this.#pending.values()) {
      if (!committed(request)) {
        this.#pending.delete(request.requestId);
        removed.push(request);
      }
    }
    if (!removed.length) return;
    try {
      this.#save();
    } catch (error) {
      for (const request of removed) this.#pending.set(request.requestId, request);
      throw error;
    }
  }

  pending(): BrowserCleanupRequest[] {
    return [...this.#pending.values()];
  }

  hasPendingProfile(profileId: string): boolean {
    return [...this.#pending.values()].some((request) => request.kind === "profile" && request.id === profileId);
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
    if (!this.#pending.has(request.requestId)) return true;
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
      type: request.kind === "bot"
        ? "openmausbot:browser-bot-deleted"
        : "openmausbot:browser-profile-deleted",
      requestId: request.requestId,
      ...(request.kind === "bot" ? { botId: request.id } : { profileId: request.id }),
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
    if (!this.#pending.has(request.requestId)) return true;
    const active = this.#inflight.get(request.requestId);
    if (active) return active;
    const operation = this.#attempt(request).finally(() => {
      if (this.#inflight.get(request.requestId) === operation) this.#inflight.delete(request.requestId);
    });
    this.#inflight.set(request.requestId, operation);
    const ok = await operation;
    if (!ok && this.#pending.has(request.requestId)) this.#schedule(request, 0);
    return ok;
  }

  #schedule(request: BrowserCleanupRequest, attempt: number): void {
    if (this.#retryTimers.has(request.requestId) || !this.#pending.has(request.requestId)) return;
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
    for (const request of this.#pending.values()) this.#schedule(request, 0);
  }
}
