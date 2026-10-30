import { randomUUID } from "node:crypto";
import { z } from "zod";

import { isPhoneWrite } from "../../shared/phone-apps.ts";

export const PHONE_JOB_CODES = ["denied", "foreground_required", "not_found", "too_large", "unsupported", "offline", "timeout", "turn_ended"] as const;
export type PhoneJobCode = (typeof PHONE_JOB_CODES)[number];
export type PhoneJobOutcome = { ok: true; result: unknown } | { ok: false; error: string; code?: PhoneJobCode };
const KNOWN_CODES: readonly unknown[] = PHONE_JOB_CODES;
/** A newer phone's extra field is stripped, and a code this server does not know yet reads as none: the error still
 * reaches the bot. */
export const phoneJobOutcome = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string().max(2000), code: z.preprocess((code) => (KNOWN_CODES.includes(code) ? code : undefined), z.enum(PHONE_JOB_CODES).optional()) }),
]);

export const PHONE_JOB_TIMEOUT_MS = 45_000;
export const PHONE_SEND_TIMEOUT_MS = 120_000;
export const PHONE_POLL_MS = 20_000;
export const PHONE_DELIVERY_MS = 10_000;
export const PHONE_RESULT_MAX_BYTES = 262_144;
/** How long a job waits to be delivered to a phone not seen lately before it fails as offline. */
export const PHONE_RECONNECT_WAIT_MS = 15_000;
const RESTARTING = "This server is restarting. Phone jobs resume by themselves once it is back.";

export type PhoneJobOptions = { active: () => boolean; timeoutMs: number; offlineText: string; online: () => boolean; background?: boolean };
export type PhoneJobDelivery = { id: string; tool: string; arguments: Record<string, unknown>; expiresAt: number };

type Job = {
  id: string; tool: string; args: Record<string, unknown>; active: () => boolean; background: boolean; seq: number; expiresAt: number;
  sent: boolean; leased: boolean; nudged: boolean; resolve: (outcome: PhoneJobOutcome) => void; timer: NodeJS.Timeout; delivery?: NodeJS.Timeout;
  offline?: NodeJS.Timeout;
};
type Phone = { jobs: Map<string, Job>; wake?: () => void; polls: number };
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });

/** In-memory rendezvous per phone key: one job in flight at a time, the newest poll wins, and a job whose delivery was never
 * leased is re-keyed and offered again. Requests always resolve with an outcome; none rejects. */
export class PhoneJobs {
  private phones = new Map<string, Phone>();
  private closed = false;
  private seq = 0;
  private onQueued: ((key: string, jobId: string) => void) | undefined;
  constructor(onQueued?: (key: string, jobId: string) => void) { this.onQueued = onQueued; }
  private phone(key: string) {
    let phone = this.phones.get(key);
    if (!phone) { phone = { jobs: new Map(), polls: 0 }; this.phones.set(key, phone); }
    return phone;
  }
  /** One job in flight per phone; a second request waits for the first to finish, up to its own timeout.
   * Two classes: an in-turn job is bound to `active()` and times out in seconds; a `background` job (a routine's
   * check) has no caller waiting, is never failed by `active()`, waits `timeoutMs` (the routine's tick) and
   * is dequeued only when no in-turn job is waiting. Background jobs are reads only: the queue refuses a write tool with
   * {ok:false, code:"unsupported"}. */
  async request(key: string, tool: string, args: Record<string, unknown>, options: PhoneJobOptions): Promise<PhoneJobOutcome> {
    const background = options.background === true;
    if (background && isPhoneWrite(tool)) return { ok: false, code: "unsupported", error: "Background checks only read the phone." };
    if (this.closed) return { ok: false, code: "offline", error: RESTARTING };
    if (!background && !options.active()) return { ok: false, code: "turn_ended", error: "The requesting turn ended" };
    const phone = this.phone(key);
    const seconds = Math.round(options.timeoutMs / 1000);
    return new Promise<PhoneJobOutcome>(resolve => {
      const job: Job = { id: randomUUID(), tool, args, active: background ? () => true : options.active, background, seq: ++this.seq,
        expiresAt: Date.now() + options.timeoutMs, sent: false, leased: false, nudged: false, resolve,
        // A job the phone never took never ran; one it took may have.
        timer: setTimeout(() => this.finish(key, phone, job, { ok: false, code: "timeout", error: job.sent || job.leased
          ? `${tool} did not finish on the phone within ${seconds} seconds. It may still have run; check before repeating.`
          : `${tool} was never picked up by the phone within ${seconds} seconds. It did not run.` }), options.timeoutMs) };
      // Queued and nudged before anything asks whether the phone is online: a phone only listening for the nudge polls
      // within the reconnect window. Still undelivered then, from a phone not seen lately, it is offline.
      job.offline = setTimeout(() => {
        if (job.sent) return;
        if (!job.active()) this.finish(key, phone, job, { ok: false, code: "turn_ended", error: "The requesting turn ended" });
        else if (!options.online()) this.finish(key, phone, job, { ok: false, code: "offline", error: options.offlineText });
      }, PHONE_RECONNECT_WAIT_MS);
      phone.jobs.set(job.id, job);
      phone.wake?.();
      this.nudge(key, phone);
    });
  }
  /** The next job to hand out: in-turn before background, arrival order within a class; none while one is in flight. */
  private front(key: string, phone: Phone): Job | null {
    let best: Job | null = null;
    for (const job of phone.jobs.values()) {
      if (!job.active()) { this.finish(key, phone, job, { ok: false, code: "turn_ended", error: "The requesting turn ended" }); continue; }
      if (job.sent) return null;
      if (!best || (best.background && !job.background) || (best.background === job.background && job.seq < best.seq)) best = job;
    }
    return best;
  }
  private nudge(key: string, phone: Phone) {
    const next = this.front(key, phone);
    if (!next || next.nudged) return;
    next.nudged = true;
    this.onQueued?.(key, next.id);
  }
  /** The newest poll wins: one whose client dropped never takes the next job. */
  async poll(key: string, gone?: AbortSignal): Promise<PhoneJobDelivery | null> {
    if (this.closed) return null;
    const phone = this.phone(key);
    const mine = ++phone.polls;
    phone.wake?.();
    const next = (): PhoneJobDelivery | null => {
      if (this.closed || phone.polls !== mine || gone?.aborted) return null;
      const job = this.front(key, phone);
      if (!job) return null;
      this.send(key, phone, job);
      return { id: job.id, tool: job.tool, arguments: job.args, expiresAt: job.expiresAt };
    };
    const queued = next();
    if (queued) return queued;
    await new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); gone?.removeEventListener("abort", wake); if (phone.wake === wake) phone.wake = undefined; resolve(); };
      const timer = setTimeout(wake, PHONE_POLL_MS);
      gone?.addEventListener("abort", wake, { once: true });
      phone.wake = wake;
    });
    return next();
  }
  private send(key: string, phone: Phone, job: Job) {
    job.sent = true;
    job.delivery = setTimeout(() => {
      if (job.leased || phone.jobs.get(job.id) !== job) return;
      phone.jobs.delete(job.id);
      job.id = randomUUID(); job.sent = false; job.nudged = false;
      phone.jobs.set(job.id, job); phone.wake?.();
      this.nudge(key, phone);
    }, PHONE_DELIVERY_MS);
  }
  /** The phone is about to run the job: true while its turn is still waiting for it. */
  lease(key: string, jobId: string): boolean {
    const phone = this.phones.get(key);
    const job = phone?.jobs.get(jobId);
    if (!phone || job?.sent !== true) return false;
    job.leased = true; clearTimeout(job.delivery);
    if (job.active()) return true;
    this.finish(key, phone, job, { ok: false, code: "turn_ended", error: "The requesting turn ended" });
    return false;
  }
  complete(key: string, jobId: string, outcome: PhoneJobOutcome): void {
    const phone = this.phones.get(key);
    const job = phone?.jobs.get(jobId);
    if (!phone || !job || !job.sent) throw failure("This job expired; it will not be replayed.");
    if (!job.active()) {
      this.finish(key, phone, job, { ok: false, code: "turn_ended", error: "The requesting turn ended" });
      throw failure("This job expired; it will not be replayed.");
    }
    if (outcome.ok && Buffer.byteLength(JSON.stringify(outcome.result) ?? "") > PHONE_RESULT_MAX_BYTES) {
      return this.finish(key, phone, job, { ok: false, code: "too_large", error: "The phone's answer was over 256 KB; ask for a narrower range." });
    }
    this.finish(key, phone, job, outcome);
  }
  /** The phone's access changed (it was removed): every job queued for it or in its hands fails at once as denied, and
   * its open poll answers empty. */
  drop(key: string, error: string): void {
    const phone = this.phones.get(key);
    if (!phone) return;
    for (const job of phone.jobs.values()) this.finish(key, phone, job, { ok: false, code: "denied", error }, false);
    phone.wake?.();
  }
  busy(key: string): boolean {
    for (const job of this.phones.get(key)?.jobs.values() ?? []) if (job.sent) return true;
    return false;
  }
  polling(key: string): boolean { return this.phones.get(key)?.wake !== undefined; }
  close(): void {
    this.closed = true;
    for (const [key, phone] of this.phones) {
      phone.wake?.();
      for (const job of phone.jobs.values()) this.finish(key, phone, job, { ok: false, code: "offline", error: RESTARTING }, false);
    }
    this.phones.clear();
  }
  private finish(key: string, phone: Phone, job: Job, outcome: PhoneJobOutcome, advance = true) {
    clearTimeout(job.timer); clearTimeout(job.delivery); clearTimeout(job.offline);
    if (phone.jobs.get(job.id) === job) phone.jobs.delete(job.id);
    job.resolve(outcome);
    if (advance) { this.nudge(key, phone); if (phone.jobs.size) phone.wake?.(); }
  }
}
