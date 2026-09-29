import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const folder = z.object({ id: z.string().uuid(), name: z.string().min(1).max(120), write: z.boolean() }).strict();
export const sharedComputerRegistration = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(120), environmentId: z.string().uuid(),
  folders: z.array(folder).max(20), terminal: z.boolean(), computer: z.boolean(),
}).strict();
export const sharedComputerOperation = z.object({
  computer_id: z.string().uuid(),
  action: z.enum(["list_files", "read_file", "write_file", "run_command", "computer_tools", "computer_call"]),
  folder_id: z.string().uuid().optional(), path: z.string().max(2048).optional(),
  content: z.string().max(350_000).optional(), encoding: z.enum(["utf8", "base64"]).optional(),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  command: z.string().max(8000).optional(), tool_name: z.string().max(100).optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
}).strict();
type Registration = z.infer<typeof sharedComputerRegistration>;
type Operation = z.infer<typeof sharedComputerOperation>;
/** Who lent a computer: the paired session that registered it (it alone may
 * poll, answer and disconnect) and the person behind that session (only that
 * person's bot turns may see or use it). */
export type SharedComputerOwner = { session: string; person: string };
export type SharedComputerStatus = {
  id: string; name: string; online: boolean; busy: boolean; lastSeenAt: number;
  scopes: { folders: { id: string; name: string; write: boolean }[]; terminal: boolean; screen: boolean };
};
type Job = { id: string; operation: Operation; active: () => boolean; sent: boolean; resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Computer = { registration: Registration; owner: SharedComputerOwner; secret: string; seen: number; jobs: Map<string, Job>; wake?: () => void };
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });
/** Bounds memory, not anyone's share: a desktop session holds one entry. */
const TOTAL = 100;
/** How long a lent computer that stopped polling (asleep, app closed) stays
 * known, so a status reader can tell "lent but offline" from "not lent". */
const RETAIN_MS = 14 * 24 * 60 * 60_000;
const OFFLINE = "This shared computer is offline. Keep its desktop app open; do not substitute files on the server.";

/** The scopes the desktop registered, checked by the server as well. The
 * desktop's own grant is the authority and checks every operation again;
 * this only means the server never even queues work outside what the desktop
 * said it lends. */
export function sharedComputerScopeRefusal(registration: Registration, operation: Pick<Operation, "action" | "folder_id">): string | null {
  switch (operation.action) {
    case "run_command":
      return registration.terminal ? null : "Terminal access is not lent to this server.";
    case "computer_tools":
    case "computer_call":
      return registration.computer ? null : "Apps and screen are not lent to this server.";
    case "list_files":
    case "read_file":
    case "write_file": {
      const lent = registration.folders.find(entry => entry.id === operation.folder_id);
      if (!lent) return "This folder has not been shared with this server.";
      return operation.action === "write_file" && !lent.write ? "This folder is read-only." : null;
    }
  }
}

/** The person a bot turn acts for, from the harness's own record of which
 * message started it: that request must name this exact turn generation (a
 * continuation of the same request adds its generation), must not have been
 * stopped, and its message must come from a person. Anything else is nobody. */
export function provenRequestPerson(
  request: { messageId?: string; generations: ReadonlySet<string>; stopped?: boolean } | undefined,
  generation: string,
  personOf: (messageId: string) => string | undefined,
): string | null {
  if (!request?.messageId || request.stopped || !request.generations.has(generation)) return null;
  return personOf(request.messageId) ?? null;
}

/** In-memory rendezvous only. Authority over local resources stays on the
 * desktop. Restart/disconnect NEVER replays an operation with an unknown outcome.
 *
 * Partitioned by owner: an entry is keyed by the registering session and the
 * desktop's id, so another session can never take over an id, and a bot turn
 * sees only the computers of the person it acts for. A turn that acts for
 * nobody provable (principal null) sees none. */
export class SharedComputers {
  private computers = new Map<string, Computer>();
  private sessionLive: (id: string) => boolean;
  constructor(sessionLive: (id: string) => boolean) { this.sessionLive = sessionLive; }
  private static key(session: string, id: string) { return `${session}\n${id}`; }
  register(registration: Registration, owner: SharedComputerOwner, secret: string) {
    if (!/^[a-f0-9]{64}$/.test(secret)) throw failure("Invalid computer credential", 400);
    const key = SharedComputers.key(owner.session, registration.id);
    const old = this.computers.get(key);
    if (old) {
      this.authorize(registration.id, owner.session, secret);
      old.registration = registration; old.seen = Date.now();
      return;
    }
    this.reap();
    // A paired desktop runs one grant per server, so a new id from the same
    // session is a new save: its earlier entry is stale and goes. No other
    // session can reach, replace or squat this key.
    for (const [stale, entry] of this.computers) {
      if (entry.owner.session !== owner.session) continue;
      this.computers.delete(stale); entry.wake?.();
      for (const job of entry.jobs.values()) this.finish(entry, job, failure("This computer's access changed. An in-flight action may have completed; inspect before retrying."));
    }
    if (this.computers.size >= TOTAL) throw failure("Too many shared computers");
    this.computers.set(key, { registration, owner: { ...owner }, secret, seen: Date.now(), jobs: new Map() });
  }
  /** Forget entries whose session ended or that have been silent too long. */
  private reap() {
    for (const [key, entry] of this.computers) {
      if (entry.jobs.size === 0 && (!this.sessionLive(entry.owner.session) || Date.now() - entry.seen > RETAIN_MS)) this.computers.delete(key);
    }
  }
  private online(entry: Computer) { return this.sessionLive(entry.owner.session) && Date.now() - entry.seen < 40_000; }
  private authorize(id: string, session: string, secret: string) {
    const entry = this.computers.get(SharedComputers.key(session, id));
    if (!entry || !this.sessionLive(session) || !/^[a-f0-9]{64}$/.test(secret) || !timingSafeEqual(Buffer.from(secret), Buffer.from(entry.secret))) throw failure("Shared computer is disconnected or not authorized", 403);
    return entry;
  }
  /** The online computers one person lent. */
  list(principal: string | null) {
    if (!principal) return [];
    return [...this.computers.values()].filter(entry => entry.owner.person === principal && this.online(entry)).map(entry => entry.registration);
  }
  /** What one person has lent, online or not: the documented status a
   * reader (the Cloud UI, the next step's placement) uses to tell "your Mac
   * is lent and awake" from "lent but asleep" and "not lent". No secret, no
   * session. Resets when this server restarts; a lending desktop registers
   * again within seconds of being online. */
  status(principal: string | null): SharedComputerStatus[] {
    if (!principal) return [];
    this.reap();
    return [...this.computers.values()].filter(entry => entry.owner.person === principal).map(entry => ({
      id: entry.registration.id, name: entry.registration.name, online: this.online(entry), busy: entry.jobs.size > 0, lastSeenAt: entry.seen,
      scopes: {
        folders: entry.registration.folders.map(({ id, name, write }) => ({ id, name, write })),
        terminal: entry.registration.terminal, screen: entry.registration.computer,
      },
    }));
  }
  async poll(id: string, session: string, secret: string) {
    const entry = this.authorize(id, session, secret);
    if (entry.wake) throw failure("A computer poll is already running");
    entry.seen = Date.now();
    const next = () => {
      for (const job of entry.jobs.values()) {
        if (!job.active()) { this.finish(entry, job, failure("The requesting turn ended")); continue; }
        if (!job.sent) { job.sent = true; return { id: job.id, operation: job.operation }; }
      }
      return null;
    };
    const queued = next();
    if (queued) return queued;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { entry.wake = undefined; resolve(); }, 20_000);
      entry.wake = () => { clearTimeout(timer); entry.wake = undefined; resolve(); };
    });
    this.authorize(id, session, secret);
    entry.seen = Date.now();
    return next();
  }
  liveJob(id: string, session: string, secret: string, jobId: string) {
    const entry = this.authorize(id, session, secret);
    entry.seen = Date.now();
    const job = entry.jobs.get(jobId);
    return job?.sent === true && job.active();
  }
  complete(id: string, session: string, secret: string, jobId: string, result: unknown) {
    const entry = this.authorize(id, session, secret);
    const job = entry.jobs.get(jobId);
    if (!job || !job.sent) throw failure("This computer operation expired; it will not be replayed");
    this.finish(entry, job, job.active() ? null : failure("The requesting turn ended"), result);
  }
  disconnect(id: string, session: string, secret: string) {
    const entry = this.authorize(id, session, secret);
    this.computers.delete(SharedComputers.key(session, id)); entry.wake?.();
    for (const job of entry.jobs.values()) this.finish(entry, job, failure("Computer disconnected. An in-flight action may have completed; inspect before retrying."));
  }
  /** One bot operation for the person the turn acts for. Another person's
   * computer answers exactly like one that does not exist. */
  request(operation: Operation, principal: string | null, active: () => boolean): Promise<unknown> {
    if (!principal) return Promise.reject(failure("This conversation cannot use a shared computer: only a conversation started by the person who shared it can.", 403));
    const entry = [...this.computers.values()].find(candidate => candidate.registration.id === operation.computer_id && candidate.owner.person === principal && this.online(candidate));
    if (!entry) return Promise.reject(failure(OFFLINE));
    const refusal = sharedComputerScopeRefusal(entry.registration, operation);
    if (refusal) return Promise.reject(failure(refusal, 403));
    if (entry.jobs.size >= 1) return Promise.reject(failure("This shared computer is busy. Wait for its current action to finish."));
    if (!active()) return Promise.reject(failure("The requesting turn ended", 401));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const job: Job = { id, operation, active, sent: false, resolve, reject, timer: setTimeout(() => this.finish(entry, job, failure("Computer action timed out. Its outcome is unknown; inspect before retrying.")), 45_000) };
      entry.jobs.set(id, job); entry.wake?.();
    });
  }
  close() {
    for (const entry of this.computers.values()) {
      entry.wake?.();
      for (const job of entry.jobs.values()) this.finish(entry, job, failure("Workspace stopped. Inspect any in-flight action before retrying."));
    }
    this.computers.clear();
  }
  private finish(entry: Computer, job: Job, error: Error | null, result?: unknown) {
    clearTimeout(job.timer); entry.jobs.delete(job.id);
    if (error) job.reject(error); else job.resolve(result);
  }
}
