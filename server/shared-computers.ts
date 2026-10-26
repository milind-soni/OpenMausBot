import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DeviceLinks, LinkedComputer } from "./device-links.ts";
import { awayNotice, deviceWord, lendScreenSteps, LENT_PLATFORMS, type LentComputers } from "./lent-computers.ts";
export { LentComputers } from "./lent-computers.ts";

const folder = z.object({ id: z.string().uuid(), name: z.string().min(1).max(120), write: z.boolean() }).strict();
export const sharedComputerRegistration = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(120), environmentId: z.string().uuid(),
  folders: z.array(folder).max(20), terminal: z.boolean(), computer: z.boolean(),
  /** Sent only to a server that advertises lendingDetails; older servers refuse unknown fields. */
  platform: z.enum(LENT_PLATFORMS).optional(),
  /** Its internet connection, for the bots' browsers; sent only to a server that advertises deviceLink. */
  internet: z.boolean().optional(),
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
/** The registering session alone may poll, answer and disconnect; only that person's bot turns may see or use it. */
export type SharedComputerOwner = { session: string; person: string };
export type SharedComputerStatus = {
  id: string; name: string; online: boolean; busy: boolean; lastSeenAt: number;
  scopes: { folders: { id: string; name: string; write: boolean }[]; terminal: boolean; screen: boolean; internet: boolean };
};
/** A computer lent now or before: what the person's own Cloud page shows, online or not, across restarts. */
export type KnownLentComputer = {
  id: string; name: string; platform: "darwin" | "win32" | "linux" | null; online: boolean; busy: boolean; lent: boolean;
  lastSeenAt: number; lastUsedAt: number | null; scopes: { folders: number; terminal: boolean; screen: boolean; internet: boolean };
};
type Job = {
  id: string; operation: Operation; active: () => boolean; sent: boolean; leased: boolean; resolve: (result: unknown) => void; reject: (error: Error) => void;
  timer: NodeJS.Timeout; delivery?: NodeJS.Timeout;
};
type Computer = { registration: Registration; owner: SharedComputerOwner; secret: string; seen: number; jobs: Map<string, Job>; wake?: () => void; polls: number };
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });
const TOTAL = 100;
const RETAIN_MS = 14 * 24 * 60 * 60_000;
/** The desktop leases a job before it runs it, so a job not leased by then went to a poll whose answer never arrived. */
const DELIVERY_MS = 10_000;
/** How long a request waits for a computer seen this recently to finish reconnecting. */
const RECONNECTING_MS = 60_000;
const RECONNECT_WAIT_MS = 15_000;
const OFFLINE = "This shared computer is offline. Keep its desktop app open; do not substitute files on the server.";
const RESTARTING = "This server is restarting. Lending resumes by itself once it is back.";
const lentButOffline = (name: string, seen: number, device: "PC" | "Mac" | "computer" = "computer") => `${name} is lent but has been offline for ${Math.max(1, Math.round((Date.now() - seen) / 60_000))} min: OpenMausBot on it is closed, the ${device} is asleep or locked, or its desktop app is signed out of MausBot Cloud. Tell the person in one sentence to open OpenMausBot on that ${device}; do not substitute files on the server.`;

/** Aborts when the client of a long poll goes away before it is answered. */
export function responseGone(res: { once(event: "close", listener: () => void): unknown; readonly writableEnded: boolean }): AbortSignal {
  const gone = new AbortController();
  res.once("close", () => { if (!res.writableEnded) gone.abort(); });
  return gone.signal;
}

/** The desktop's grant is the authority and checks every operation again; the server just never queues work outside what it lends. */
export function sharedComputerScopeRefusal(registration: Registration, operation: Pick<Operation, "action" | "folder_id">): string | null {
  switch (operation.action) {
    case "run_command":
      return registration.terminal ? null : `Terminal is off on ${registration.name}, so it cannot run commands. Terminal is lent per computer: tell the person in one sentence to turn it on in OpenMausBot on ${registration.name}, under Settings \u2192 MausBot Cloud \u2192 Terminal. Only the person can turn it on; do not try to enable it or run the command anywhere else.`;
    case "computer_tools":
    case "computer_call":
      return registration.computer ? null : `Apps and screen are not lent to this server. ${lendScreenSteps(deviceWord(registration.platform))}`;
    case "list_files":
    case "read_file":
    case "write_file": {
      const lent = registration.folders.find(entry => entry.id === operation.folder_id);
      if (!lent) return "This folder has not been shared with this server.";
      return operation.action === "write_file" && !lent.write ? "This folder is read-only." : null;
    }
  }
}

/** The person behind a request proven for this exact turn generation, not stopped, from a person's message; anything else is nobody. */
export function provenRequestPerson(
  request: { messageId?: string; generations: ReadonlySet<string>; stopped?: boolean } | undefined,
  generation: string,
  personOf: (messageId: string) => string | undefined,
): string | null {
  if (!request?.messageId || request.stopped || !request.generations.has(generation)) return null;
  return personOf(request.messageId) ?? null;
}

/** In-memory rendezvous: authority stays on the desktop, and restart/disconnect never replays an operation with an unknown outcome.
 * Keyed by registering session and desktop id, so no other session takes over an id and a turn sees only its person's computers. */
export class SharedComputers {
  private computers = new Map<string, Computer>();
  private closed = false;
  private sessionLive: (id: string) => boolean;
  private lent: LentComputers | undefined;
  private links: Pick<DeviceLinks, "drop"> | undefined;
  constructor(sessionLive: (id: string) => boolean, lent?: LentComputers, links?: Pick<DeviceLinks, "drop">) { this.sessionLive = sessionLive; this.lent = lent; this.links = links; }
  private static key(session: string, id: string) { return `${session}\n${id}`; }
  register(registration: Registration, owner: SharedComputerOwner, secret: string) {
    if (this.closed) throw failure(RESTARTING, 503);
    if (!/^[a-f0-9]{64}$/.test(secret)) throw failure("Invalid computer credential", 400);
    const key = SharedComputers.key(owner.session, registration.id);
    const old = this.computers.get(key);
    if (old) {
      this.authorize(registration.id, owner.session, secret);
      // Its link was let in for the internet connection as lent then: lent or taken back since, the link starts over.
      if ((old.registration.internet === true) !== (registration.internet === true)) this.links?.drop(key);
      old.registration = registration; old.seen = Date.now();
      this.remember(registration, old.owner.person);
      return;
    }
    this.reap();
    // A new id from the same session replaces its entry; no other session can reach, replace or squat this key.
    for (const [stale, entry] of this.computers) {
      if (entry.owner.session !== owner.session) continue;
      this.computers.delete(stale); entry.wake?.(); this.links?.drop(stale);
      for (const job of entry.jobs.values()) this.finish(entry, job, failure("This computer's access changed. An in-flight action may have completed; inspect before retrying."));
    }
    if (this.computers.size >= TOTAL) throw failure("Too many shared computers");
    this.computers.set(key, { registration, owner: { ...owner }, secret, seen: Date.now(), jobs: new Map(), polls: 0 });
    this.remember(registration, owner.person);
  }
  private remember(registration: Registration, person: string) {
    this.lent?.connected(person, { id: registration.id, name: registration.name, platform: registration.platform,
      folders: registration.folders.length, terminal: registration.terminal, screen: registration.computer, internet: registration.internet === true });
  }
  private reap() {
    for (const [key, entry] of this.computers) {
      if (entry.jobs.size === 0 && (!this.sessionLive(entry.owner.session) || Date.now() - entry.seen > RETAIN_MS)) { this.computers.delete(key); this.links?.drop(key); }
    }
  }
  private online(entry: Computer) { return this.sessionLive(entry.owner.session) && Date.now() - entry.seen < 40_000; }
  /** The desktop takes a 401 or 403 for a lost sign-in and signs in again, so a stopping server answers 503. */
  private authorize(id: string, session: string, secret: string) {
    if (this.closed) throw failure(RESTARTING, 503);
    const entry = this.computers.get(SharedComputers.key(session, id));
    if (!entry || !this.sessionLive(session) || !/^[a-f0-9]{64}$/.test(secret) || !timingSafeEqual(Buffer.from(secret), Buffer.from(entry.secret))) throw failure("Shared computer is disconnected or not authorized", 403);
    return entry;
  }
  list(principal: string | null) {
    if (!principal) return [];
    return [...this.computers.values()].filter(entry => entry.owner.person === principal && this.online(entry)).map(({ registration: { platform, ...rest } }) => ({ ...rest, ...(platform ? { device: deviceWord(platform) } : {}) }));
  }
  /** Every computer this person lent, now or before, newest first: online, offline since, or no longer lent. */
  known(principal: string | null): KnownLentComputer[] {
    if (!principal) return [];
    const live = [...this.computers.values()].filter(entry => entry.owner.person === principal);
    return (this.lent?.list(principal) ?? []).map(record => {
      const entry = live.find(candidate => candidate.registration.id === record.id);
      return { id: record.id, name: record.name, platform: record.platform, online: entry ? this.online(entry) : false, busy: (entry?.jobs.size ?? 0) > 0,
        lent: record.stoppedAt === null, lastSeenAt: entry ? Math.max(entry.seen, record.lastSeenAt) : record.lastSeenAt, lastUsedAt: record.lastUsedAt,
        scopes: { folders: record.folders, terminal: record.terminal, screen: record.screen, internet: record.internet === true } };
    });
  }
  /** For a bot: which known computer is offline and since when, and the sentence to say; nothing while one is online. */
  away(principal: string | null) {
    if (!principal) return {};
    return awayNotice(this.lent?.list(principal) ?? [], new Set(this.list(principal).map(registration => registration.id)));
  }
  /** For a bot: how the person lends apps and screen, when an online computer of theirs lends neither. */
  screenNotLent(principal: string | null): { screen?: string } {
    if (!principal) return {};
    const entry = [...this.computers.values()].find(candidate => candidate.owner.person === principal && this.online(candidate) && !candidate.registration.computer);
    if (!entry) return {};
    return { screen: `${entry.registration.name} does not lend its apps and screen. ${lendScreenSteps(deviceWord(entry.registration.platform))}` };
  }
  /** A computer that lends its internet connection but is away: the bots' browsers here use My Cloud's own connection
   * meanwhile, and say so once. Nothing while one is online, or when none lends it. */
  internetAway(principal: string): { away: "PC" | "Mac" | "computer" } | null {
    const online = new Set(this.list(principal).map(registration => registration.id));
    const lending = (this.lent?.list(principal) ?? []).filter(record => record.internet === true && record.stoppedAt === null);
    if (!lending.length || lending.some(record => online.has(record.id))) return null;
    return { away: deviceWord(lending[0]!.platform) };
  }
  /** The registered computer behind a device link: the same session and secret as its poll. */
  linkable(id: string, session: string, secret: string): LinkedComputer {
    const entry = this.authorize(id, session, secret);
    entry.seen = Date.now();
    return { key: SharedComputers.key(session, id), person: entry.owner.person, internet: entry.registration.internet === true, seenAs: null,
      live: () => this.sessionLive(session), used: () => this.lent?.used(entry.owner.person, id) };
  }
  status(principal: string | null): SharedComputerStatus[] {
    if (!principal) return [];
    this.reap();
    return [...this.computers.values()].filter(entry => entry.owner.person === principal).map(entry => ({
      id: entry.registration.id, name: entry.registration.name, online: this.online(entry), busy: entry.jobs.size > 0, lastSeenAt: entry.seen,
      scopes: {
        folders: entry.registration.folders.map(({ id, name, write }) => ({ id, name, write })),
        terminal: entry.registration.terminal, screen: entry.registration.computer, internet: entry.registration.internet === true,
      },
    }));
  }
  /** The newest poll wins: one whose client dropped never takes the next job, and the reconnecting desktop is not refused. */
  async poll(id: string, session: string, secret: string, gone?: AbortSignal) {
    const entry = this.authorize(id, session, secret);
    const mine = ++entry.polls;
    entry.wake?.();
    entry.seen = Date.now();
    this.lent?.seen(entry.owner.person, id);
    const next = () => {
      if (entry.polls !== mine || gone?.aborted) return null;
      for (const job of entry.jobs.values()) {
        if (!job.active()) { this.finish(entry, job, failure("The requesting turn ended")); continue; }
        if (!job.sent) { this.send(entry, job); return { id: job.id, operation: job.operation }; }
      }
      return null;
    };
    const queued = next();
    if (queued) return queued;
    await new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); gone?.removeEventListener("abort", wake); if (entry.wake === wake) entry.wake = undefined; resolve(); };
      const timer = setTimeout(wake, 20_000);
      gone?.addEventListener("abort", wake, { once: true });
      entry.wake = wake;
    });
    this.authorize(id, session, secret);
    entry.seen = Date.now();
    this.lent?.seen(entry.owner.person, id);
    return next();
  }
  private send(entry: Computer, job: Job) {
    job.sent = true;
    job.delivery = setTimeout(() => {
      if (job.leased || entry.jobs.get(job.id) !== job) return;
      entry.jobs.delete(job.id);
      job.id = randomUUID(); job.sent = false;
      entry.jobs.set(job.id, job); entry.wake?.();
    }, DELIVERY_MS);
  }
  liveJob(id: string, session: string, secret: string, jobId: string) {
    const entry = this.authorize(id, session, secret);
    entry.seen = Date.now();
    const job = entry.jobs.get(jobId);
    if (job?.sent !== true) return false;
    job.leased = true; clearTimeout(job.delivery);
    return job.active();
  }
  complete(id: string, session: string, secret: string, jobId: string, result: unknown) {
    const entry = this.authorize(id, session, secret);
    const job = entry.jobs.get(jobId);
    if (!job || !job.sent) throw failure("This computer operation expired; it will not be replayed");
    this.lent?.used(entry.owner.person, id);
    this.finish(entry, job, job.active() ? null : failure("The requesting turn ended"), result);
  }
  /** `paused`: the desktop still lends and comes back by itself (waiting for its Cloud sign-in), so it reads as offline,
   * not as no longer lent. Older desktops never send it. */
  disconnect(id: string, session: string, secret: string, paused = false) {
    const entry = this.authorize(id, session, secret);
    if (paused) this.lent?.seen(entry.owner.person, id); else this.lent?.stopped(entry.owner.person, id);
    this.computers.delete(SharedComputers.key(session, id)); entry.wake?.(); this.links?.drop(SharedComputers.key(session, id));
    for (const job of entry.jobs.values()) this.finish(entry, job, failure("Computer disconnected. An in-flight action may have completed; inspect before retrying."));
  }
  /** Another person's computer answers exactly like one that does not exist. */
  async request(operation: Operation, principal: string | null, active: () => boolean): Promise<unknown> {
    if (!principal) throw failure("This conversation cannot use a shared computer: only a conversation started by the person who shared it can.", 403);
    const lent = () => [...this.computers.values()].find(candidate => candidate.registration.id === operation.computer_id && candidate.owner.person === principal);
    for (const deadline = Date.now() + RECONNECT_WAIT_MS; ;) {
      const known = lent();
      if (known && this.online(known)) break;
      if (!known || Date.now() - known.seen > RECONNECTING_MS || Date.now() >= deadline || !active()) {
        throw failure(known && this.sessionLive(known.owner.session)
          ? lentButOffline(known.registration.name, known.seen, deviceWord(known.registration.platform))
          : this.offline(principal, operation.computer_id));
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const entry = lent()!;
    const refusal = sharedComputerScopeRefusal(entry.registration, operation);
    if (refusal) throw failure(refusal, 403);
    if (entry.jobs.size >= 1) throw failure("This shared computer is busy. Wait for its current action to finish.");
    if (!active()) throw failure("The requesting turn ended", 401);
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const job: Job = { id, operation, active, sent: false, leased: false, resolve, reject, timer: setTimeout(() => this.finish(entry, job, failure("Computer action timed out. Its outcome is unknown; inspect before retrying.")), 45_000) };
      entry.jobs.set(id, job); entry.wake?.();
    });
  }
  /** Names the computer and its kind when it is known, so a bot says "your PC" to a Windows user, never "your Mac". */
  private offline(principal: string, id: string): string {
    const known = this.lent?.list(principal).find(computer => computer.id === id);
    if (!known) return OFFLINE;
    const device = deviceWord(known.platform);
    return known.stoppedAt === null
      ? `${known.name} is offline: OpenMausBot on that ${device} is closed, or the ${device} is asleep or off. Ask them to open it; it reconnects by itself. Do not substitute files on the server.`
      : `${known.name} is no longer lent: lending was turned off on that ${device}. Do not substitute files on the server.`;
  }
  close() {
    this.closed = true;
    for (const key of this.computers.keys()) this.links?.drop(key);
    for (const entry of this.computers.values()) {
      entry.wake?.();
      for (const job of entry.jobs.values()) this.finish(entry, job, failure("Workspace stopped. Inspect any in-flight action before retrying."));
    }
    this.computers.clear();
  }
  private finish(entry: Computer, job: Job, error: Error | null, result?: unknown) {
    clearTimeout(job.timer); clearTimeout(job.delivery); entry.jobs.delete(job.id);
    if (error) job.reject(error); else job.resolve(result);
  }
}
