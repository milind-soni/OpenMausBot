// A personal Cloud's bots browse in the Cloud's own browser sandbox at the provider (remote.ts), so a page's memory and
// CPU are not the home's. Decided once per browser session, when its browser opens; a session never moves while it runs.
// Every case this cannot serve opens the home's browser exactly as before, with one log line naming why. A desktop
// install never builds this. The one operator lever, never a product setting: OMB_CLOUD_BROWSER=home keeps every browser
// in the home, and after a day of it the sandbox is deleted.
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { cloudFailureOf } from "../boat-limit.ts";
import { connectCdp } from "../browser-sites.ts";
import { CloudBrowserDoors, dialable, probeDoor, type DoorTarget } from "./door.ts";
import { syncStore } from "./sync.ts";
import { CarryFailed, SandboxCompanion, SignInsUnreadable, type CompanionDeps, type SignInStore } from "./companion.ts";
import { createCloudBrowserRails, type CloudBrowserRails, type HomeReason } from "./rails.ts";
import { BROWSER_SANDBOX_CHROMES, BROWSER_SANDBOX_OWNER, COMPUTER_DOOR_PORT, OldRelay, profileKey, StaysHome, wakeSandbox, type ComputerOps } from "./remote.ts";

/** A browser in the sandbox with no activity this long is closed; the sandbox sleeps once none is left. */
export const CLOUD_BROWSER_IDLE_MS = 3 * 60_000;
const SWEEP_MS = 30_000;
/** However the sandbox is doing, a browser call waits at most this long for it: past it the call opens the home's browser,
 * and the sandbox goes on coming up for the next one. Well inside the 60 s an engine gives a tool call. */
export const OPEN_DEADLINE_MS = 12_000;
/** What the bot's next call is told after its browser in the sandbox was closed (unused, or its machine stopped). */
export const REOPENED_NOTE = "The browser was reopened: the earlier page and tabs are gone, so open the page again before acting on it.";
const LEVER_CLEANUP_GAP_MS = 60 * 60_000;
/** While a browser is used, the provider's own auto-stop is pushed to this far ahead, at most every TTL_REFRESH_MS: it then
 * stops the sandbox by itself when everything here died, and never in the middle of a session in use. */
export const SANDBOX_IDLE_TTL_SECONDS = 1_200;
export const TTL_REFRESH_MS = 10 * 60_000;

const READY_STATES = new Set(["idle", "ready", "running"]);

export const cloudBrowserLever = (env: NodeJS.ProcessEnv = process.env): boolean => env.OMB_CLOUD_BROWSER?.trim() === "home";

export interface CloudBrowserDeps {
  dataDir: string;
  /** The provider, or null while this Cloud has no cloud computers set up. */
  ops(): ComputerOps | null;
  /** The cloud computers' own idle path (host/cloud-computer-power.ts), keyed by BROWSER_SANDBOX_OWNER: `windowMs` asks
   * for a sleep that soon unless something keeps the sandbox on longer. */
  used(owner: string, windowMs: number): void;
  /** Closes the session's browser engine in the home (its connection to the sandbox goes with it). */
  closeEngine(session: string): Promise<unknown>;
  /** A turn holds this session's browser, a call runs in it, or a person watches or drives it: real use, which keeps it open.
   * Bytes on the connection are not: the attached engine's keepalives and the companion's own reads never count. */
  held(session: string): boolean;
  /** The home's saved sign-ins (agent-browser's restore file), carried in and back; null keeps them apart. */
  signIns?: SignInStore | null;
  /** The bot's working folder, where its downloads land. */
  folder?(botId: string): string | null;
  /** Tests: the companion's own connection through the door. */
  connect?: CompanionDeps["connect"];
  /** Tests: the Cloud disk's free and total bytes. */
  disk?: CompanionDeps["disk"];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  log?: (line: string) => void;
  rails?: CloudBrowserRails;
  /** Tests: a shorter sweep and wake reads. */
  sweepMs?: number;
  pollMs?: number;
  openDeadlineMs?: number;
}

export interface OpenRequest {
  session: string;
  botId: string;
  /** Why this session may not use the sandbox (the caller's rules), or null. */
  refusal: HomeReason | null;
}

export type Opened = { cdpUrl: string } | { home: HomeReason };

/** The relay says no browser sandbox may start now (the fleet's or this Cloud's day spent, or switched off). */
class Unavailable extends Error {
  readonly reason: string;
  readonly resetsAt: string | null;
  constructor(reason: string, resetsAt: string | null) {
    super(reason);
    this.reason = reason;
    this.resetsAt = resetsAt;
  }
}

export function createCloudBrowser(deps: CloudBrowserDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const rails = deps.rails ?? createCloudBrowserRails({ dataDir: deps.dataDir, now });
  const doors = new CloudBrowserDoors(now);
  const sync = syncStore(join(deps.dataDir, "cloud-browser", "sync"));
  /** Each running session's bot; one Chrome per bot's profile. */
  const sessions = new Map<string, string>();
  /** Bots whose browser is being opened now. */
  const opening = new Set<string>();
  /** A session's open under way: a second call for the same session waits on it, so one session never splits in two. */
  const pendingSessions = new Map<string, Promise<Opened>>();
  const closing = new Set<string>();
  const companions = new Map<string, SandboxCompanion>();
  /** When each session was last really used (opened, a bot's call, held by a turn, a person): the only activity that counts. */
  const lastUse = new Map<string, number>();
  /** What a closed session's companion still had to say (a last download retry), for that session's next call. */
  const leftNotes = new Map<string, string[]>();
  /** One wake of the sandbox at a time, shared by every bot opening meanwhile. */
  let waking: Promise<{ id: string; started: boolean }> | null = null;
  /** Erasures of deleted bots' profiles in a sleeping sandbox, one after another. */
  let erasing: Promise<void> = Promise.resolve();
  let boxId: string | null = null;
  let sweep: ReturnType<typeof setInterval> | null = null;
  let leftAwakeArmed = false;
  /** Woken (or found awake) by an open here and not yet let sleep. */
  let awake = false;
  let leverCleanupAt = -Infinity;
  let ttlRefreshedAt = 0;
  /** How many bots' Chromes this Cloud's sandbox takes at once, as the relay last said (by its size). */
  let chromesAllowed = BROWSER_SANDBOX_CHROMES;

  const fallback = (request: OpenRequest, reason: HomeReason): Opened => {
    rails.home(reason);
    log(`browser ${request.session}: opens in the home, not in the Cloud's browser sandbox (${reason})`);
    return { home: reason };
  };
  const home = fallback;
  const bots = () => new Set([...sessions.values(), ...opening]);

  /** A refusal's own words decide: the account's starts, the sandbox's minutes, or a failure that counts toward the back-off. */
  function refused(error: unknown): HomeReason {
    const failure = cloudFailureOf(error);
    const limit = failure.limit;
    // No machine free right now: the provider answered at once and counted no start. Not the sandbox's failure.
    if (failure.code === "no_ready_machine") return "no-machine";
    if (limit?.reason === "too_many_starts" && (limit.window === "day" || limit.window === undefined)) { rails.accountLimit(limit); return "account-limit"; }
    if (limit?.reason === "hours_used") { rails.hoursUsed(limit); return "hours-used"; }
    if (limit?.reason === "at_once") { rails.holdOff(); return "at-once"; }
    if (limit) { rails.holdOff(); return "backoff"; }
    // The account's start pool is busy for now (the relay's "busy", a minute or hour window): a few minutes, not the day.
    if (failure.status === 429) { rails.holdOff(); return "backoff"; }
    rails.failed();
    return "start-failed";
  }

  /** Once no browser is left in it: the sandbox's idle path may stop it within a second. */
  function letSleep(): void {
    if (!awake || bots().size > 0) return;
    awake = false;
    deps.used(BROWSER_SANDBOX_OWNER, 1_000);
    rails.asleep();
  }

  /** Asked once before a start: an Admin that cannot mark the sandbox as the browser's gets no box at all. */
  async function allowed(ops: ComputerOps): Promise<void> {
    const said = await ops.probe();
    if (said.kind === "old-relay") throw new OldRelay();
    if (said.kind === "unavailable") throw new Unavailable(said.reason, said.resetsAt);
    if (said.chromes !== null) chromesAllowed = said.chromes;
    rails.caps(said.caps.resumes, said.caps.awakeMinutes);
  }

  async function wake(ops: ComputerOps): Promise<{ id: string; started: boolean }> {
    waking ??= wakeSandbox(ops, {
      mayStart: () => rails.refusal(true) === null,
      allowed: () => allowed(ops),
      // Timed from the moment a start is sent, whatever follows: a sandbox started is never left untimed.
      starting: () => { rails.resumed(); armed(); },
      ...(deps.pollMs ? { pollMs: deps.pollMs } : {}),
    }).finally(() => { waking = null; });
    const box = await waking;
    boxId = box.id;
    // Woken now: the deadline the Admin set at the resume is fresh.
    if (box.started) ttlRefreshedAt = now();
    armed();
    await erasePending(ops, box.id);
    return box;
  }

  /** On from here: the sandbox's idle path times it, whatever happens next. */
  function armed(): void {
    awake = true;
    rails.awake();
    deps.used(BROWSER_SANDBOX_OWNER, CLOUD_BROWSER_IDLE_MS);
  }

  /** Deleted bots' profiles, erased while the sandbox is awake anyway: a deletion never wakes it on its own. */
  async function erasePending(ops: ComputerOps, id: string): Promise<void> {
    for (const key of rails.pendingErasures()) {
      try {
        await ops.erase(id, key);
        rails.erased(key);
        log("browser sandbox: erased a deleted bot's profile");
      } catch {
        // Kept for the next wake (an Admin without the action keeps it pending).
      }
    }
  }

  /** A deleted bot: its sessions end without their sign-ins going home, its sync stamps go, and its profile in the
   * sandbox is erased now if the sandbox is awake. A profile in a sleeping sandbox is not left for a wake that may never
   * come (eraseAsleep, after this returns). */
  async function erase(botId: string): Promise<void> {
    const key = profileKey(botId);
    const had = rails.hasProfile(key);
    rails.forgetProfile(key);
    sync.forget(key);
    const ops = deps.ops();
    // Erased while the sandbox is still awake for this session, before its close lets it sleep.
    if (awake && boxId && ops) await erasePending(ops, boxId);
    for (const [session, owner] of Array.from(sessions)) if (owner === botId) await close(session, { discard: true, why: "its bot was deleted" });
    // A bot that never had a profile there keeps today's way: its erase waits for the next wake.
    if (had && ops && rails.pendingErasures().includes(key)) {
      erasing = erasing.then(() => eraseAsleep(ops)).catch((error: unknown) => log(`browser sandbox: a deleted bot's profile is erased at its next wake (${error instanceof Error ? error.name : "error"})`));
    }
  }

  /** Deleted bots' profiles in a sleeping sandbox: with no other bot's profile left in it the whole sandbox is deleted (the
   * next browser makes a fresh one); else it is woken once for the erase and let sleep, when a start may be sent now. When
   * none may (the day's starts, a hold), the erase waits for the next wake. */
  async function eraseAsleep(ops: ComputerOps): Promise<void> {
    if (rails.pendingErasures().length === 0) return;
    // A browser open or opening: its wake erases them.
    if (bots().size > 0 || awake) return;
    const box = await ops.find();
    if (!box) {
      for (const key of rails.pendingErasures()) rails.erased(key);
      return;
    }
    boxId = box.id;
    // Awake without a browser of this run (one an earlier run left): erased now; its idle path lets it sleep.
    if (READY_STATES.has(box.state)) { await erasePending(ops, box.id); return; }
    const broken = box.state === "error" || box.state === "cancelled";
    if (broken || rails.profilesIn(box.id).length === 0) {
      if (bots().size > 0) return;
      const removed = await ops.remove(box.id);
      for (const key of rails.pendingErasures()) rails.erased(key);
      if (boxId === box.id) boxId = null;
      log(`browser sandbox: ${removed ? "deleted" : "deletion requested and journaled"}: no bot with a browser profile is left in it`);
      return;
    }
    if (rails.refusal(true) !== null) { log("browser sandbox: a deleted bot's profile is erased at its next wake: no start may be sent now"); return; }
    try {
      // wake() erases the pending profiles once the sandbox is ready.
      await wake(ops);
      log("browser sandbox: woken to erase a deleted bot's profile");
    } catch (error) {
      if (error instanceof StaysHome) return;
      if (error instanceof OldRelay) { rails.oldRelay(); return; }
      if (error instanceof Unavailable) { rails.unavailable(error.reason, error.resetsAt); return; }
      refused(error);
    } finally {
      letSleep();
    }
  }

  async function launch(request: OpenRequest, ops: ComputerOps, gaveUp: () => boolean): Promise<Opened> {
    const key = profileKey(request.botId);
    let box: { id: string; started: boolean } | null = null;
    const quit = async () => { if (box) await ops.quit(box.id, key).catch(() => undefined); };
    // Past the deadline this call already opened the home's browser: what follows only readies the sandbox for the next.
    const home = (_request: OpenRequest, reason: HomeReason): Opened => (gaveUp() ? { home: reason } : fallback(request, reason));
    // An erase of a deleted bot's profile under way (a sandbox being deleted, or woken for it) finishes first: this open then
    // finds the sandbox as that left it, never one half deleted.
    await erasing;
    try {
      box = await wake(ops);
      if (gaveUp()) return { home: "slow" };
      const secret = randomBytes(24).toString("hex");
      // The door's port is put on the relay while Chrome starts: it needs no Chrome.
      const hosted = ops.host(box.id, COMPUTER_DOOR_PORT).catch(() => null);
      const answer = await ops.launch(box.id, key, secret);
      // Given up while the launch ran: nothing more is spent on this call (no port, no carry); its Chrome quits.
      if (gaveUp()) { await quit(); return { home: "slow" }; }
      if (!answer.chrome || !answer.home) {
        rails.failed();
        await quit();
        return home(request, "start-failed");
      }
      // Without the policy a page could open file:// and read another process's files in the sandbox: no browser runs there today.
      if (!answer.policy) {
        rails.noRoute();
        await quit();
        return home(request, "no-policy");
      }
      const relay = await hosted;
      const url = relay ? dialable(relay) : null;
      if (!url) {
        rails.noRoute();
        await quit();
        return home(request, "no-route");
      }
      const target: DoorTarget = { url, secret: `${key}/${secret}` };
      // No separate probe of the path: the companion's own connection through the door, next, proves it (or fails the open).
      if (gaveUp()) { await quit(); return { home: "slow" }; }
      const cdpUrl = await doors.open(request.session, target);
      const companion = new SandboxCompanion({
        session: request.session, botId: request.botId, key, boxId: box.id, home: answer.home, ops, rails, signIns: deps.signIns ?? null,
        folder: (botId) => deps.folder?.(botId) ?? null, log, now, sync, ...(deps.disk ? { disk: deps.disk } : {}),
        connect: deps.connect ?? ((url, listeners) => connectCdp(url, 10_000, listeners)),
      });
      try {
        await companion.start(cdpUrl);
      } catch (error) {
        companion.close();
        doors.close(request.session);
        await quit();
        if (error instanceof SignInsUnreadable) return home(request, "sign-ins");
        if (error instanceof CarryFailed) { rails.setCarryBad(key, error.modified); return home(request, "sign-ins"); }
        rails.failed();
        return home(request, "unreachable");
      }
      if (gaveUp()) {
        companion.close();
        doors.close(request.session);
        await quit();
        return { home: "slow" };
      }
      rails.setCarryBad(key, null);
      companions.set(request.session, companion);
      sessions.set(request.session, request.botId);
      lastUse.set(request.session, now());
      rails.opened();
      startSweep();
      log(`browser ${request.session}: opened in the Cloud's browser sandbox${box.started ? " (started for it)" : ""}`);
      return { cdpUrl };
    } catch (error) {
      if (error instanceof StaysHome) return home(request, error.reason);
      if (error instanceof OldRelay) { rails.oldRelay(); return home(request, "old-relay"); }
      if (error instanceof Unavailable) return home(request, rails.unavailable(error.reason, error.resetsAt));
      await quit();
      return home(request, refused(error));
    }
  }

  /** The lever held for a day: the sandbox is deleted (journaled, retried by the deletion journal if it fails). */
  function leverCleanup(): void {
    if (!rails.lever(true) || now() - leverCleanupAt < LEVER_CLEANUP_GAP_MS || bots().size > 0) return;
    leverCleanupAt = now();
    const ops = deps.ops();
    if (!ops) return;
    void (async () => {
      const box = await ops.find();
      if (!box) return;
      const removed = await ops.remove(box.id);
      log(`browser sandbox: ${removed ? "deleted" : "deletion requested and journaled"} after a day with every browser kept in the home`);
      rails.asleep();
    })().catch((error: unknown) => log(`browser sandbox: could not delete it yet (${error instanceof Error ? error.name : "error"}); retrying within the hour`));
  }

  /** Where the session's browser opens: in the sandbox (`cdpUrl`, the engine's address for it), or in the home. */
  function open(request: OpenRequest): Promise<Opened> {
    const live = doors.url(request.session);
    if (live) return Promise.resolve({ cdpUrl: live });
    const pending = pendingSessions.get(request.session);
    if (pending) return pending;
    const decided = decide(request).finally(() => pendingSessions.delete(request.session));
    pendingSessions.set(request.session, decided);
    return decided;
  }

  async function decide(request: OpenRequest): Promise<Opened> {
    if (cloudBrowserLever(deps.env)) { leverCleanup(); return home(request, "lever"); }
    rails.lever(false);
    if (request.refusal) return home(request, request.refusal);
    const ops = deps.ops();
    if (!ops) return home(request, "not-set-up");
    const held = rails.refusal(false);
    if (held) return home(request, held);
    // One Chrome per bot's profile: a second session of the same bot (another audience's) stays in the home.
    if (bots().has(request.botId)) return home(request, "busy");
    if (bots().size >= chromesAllowed) return home(request, "sandbox-full");
    // The home's copy Chrome refused before, unchanged since: not worth a wake.
    const known = deps.signIns?.load(request.session);
    const bad = rails.carryBad(profileKey(request.botId));
    if (bad !== null && known && known !== "unreadable" && known.modified === bad) return home(request, "sign-ins");
    opening.add(request.botId);
    let late = false;
    const attempt = launch(request, ops, () => late).finally(() => {
      opening.delete(request.botId);
      letSleep();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deps.openDeadlineMs ?? OPEN_DEADLINE_MS);
      timer.unref?.();
    });
    const first = await Promise.race([attempt, deadline]);
    clearTimeout(timer);
    if (first) return first;
    late = true;
    void attempt.catch(() => undefined);
    return home(request, "slow");
  }

  /** The bot's Chrome quits cleanly (its cookies written), the engine's session ends, and the sandbox may sleep. */
  /** `why`: what the log says; an idle close says how long it really sat unused. */
  async function close(session: string, options: { discard?: boolean; why?: string } = {}): Promise<void> {
    const botId = sessions.get(session);
    const unusedFor = Math.round((now() - (lastUse.get(session) ?? now())) / 60_000);
    if (!botId || closing.has(session)) return;
    closing.add(session);
    try {
      const companion = companions.get(session);
      if (options.discard) companion?.close();
      else await companion?.stop().catch(() => undefined);
      // The bot's next call opens a fresh browser (here or in the home): it is told the earlier page is gone.
      const notes = options.discard ? [] : [REOPENED_NOTE, ...companion?.takeNotes() ?? []];
      if (notes.length) leftNotes.set(session, notes); else leftNotes.delete(session);
      companions.delete(session);
      lastUse.delete(session);
      await deps.closeEngine(session).catch(() => undefined);
      doors.close(session);
      sessions.delete(session);
      const ops = deps.ops();
      if (ops && boxId) await ops.quit(boxId, bots().size > 0 ? profileKey(botId) : null).catch(() => undefined);
      letSleep();
      log(`browser ${session}: closed in the Cloud's browser sandbox: ${options.why ?? `${unusedFor} minutes unused`}`);
    } finally {
      closing.delete(session);
    }
  }

  /** The provider's auto-stop pushed ahead while some browser here was used since the last push. */
  /** Stamped only once the deadline really moved (or the Admin refused on purpose); a failed push is tried again at the
   * next sweep, well before the deadline it was meant to move. */
  async function refreshTtl(at: number): Promise<void> {
    const ops = deps.ops();
    if (!ops || !boxId || at - ttlRefreshedAt < TTL_REFRESH_MS) return;
    const used = [...lastUse.values()].some((at) => at > ttlRefreshedAt);
    if (!used) return;
    const outcome = await ops.refreshTtl(boxId, SANDBOX_IDLE_TTL_SECONDS).catch(() => "failed" as const);
    if (outcome !== "failed") ttlRefreshedAt = at;
  }

  /** A call in a session on the sandbox failed: when the sandbox is no longer ready (stopped by a cap, the Admin's maximum
   * session age, an outage) or the door no longer answers, the session ends so the next call opens again, in the home if
   * the sandbox can't be had. A session never fails call after call on a dead sandbox. */
  async function failed(session: string): Promise<boolean> {
    const ops = deps.ops();
    if (!sessions.has(session) || !ops || !boxId) return false;
    const state = await ops.state(boxId).catch(() => null);
    const target = doors.target(session);
    const alive = state !== null && READY_STATES.has(state) && target !== null && await probeDoor(target, 5_000);
    if (alive) return false;
    log(`browser ${session}: its browser sandbox is ${state && !READY_STATES.has(state) ? `${state}` : "not answering"}; the session ends and the next call opens again`);
    await close(session, { why: `its browser sandbox is ${state && !READY_STATES.has(state) ? state : "not answering"}` });
    return true;
  }

  async function closeIdle(): Promise<void> {
    const at = now();
    await Promise.all([...companions.values()].map((companion) => companion.periodic()));
    await Promise.all(doors.sessions().map(async (session) => {
      if (deps.held(session)) { lastUse.set(session, at); return; }
      const last = lastUse.get(session);
      if (last !== undefined && at - last >= CLOUD_BROWSER_IDLE_MS) await close(session);
    }));
    await refreshTtl(at);
    if (doors.sessions().length === 0 && sweep) { clearInterval(sweep); sweep = null; }
  }

  function startSweep(): void {
    if (sweep) return;
    sweep = setInterval(() => void closeIdle().catch(() => undefined), deps.sweepMs ?? SWEEP_MS);
    sweep.unref?.();
  }

  return {
    open,
    /** The engine's address for a session running in the sandbox, or null. */
    active: (session: string): string | null => doors.url(session),
    attached: (session: string): boolean => doors.url(session) !== null,
    /** A bot's call (or a person's action) in the session's browser: real use, which keeps it open and the sandbox awake. */
    touch: (session: string): void => { if (lastUse.has(session)) lastUse.set(session, now()); },
    /** A browser is open or opening in the sandbox: its idle path must not stop it. */
    busy: (owner: string): boolean => owner === BROWSER_SANDBOX_OWNER && bots().size > 0,
    close,
    closeIdle,
    dialed: (session: string): number => doors.dialed(session),
    failed,
    erase,
    /** Settles once the erasures erase() started in the background are done (tests). */
    erased: (): Promise<void> => erasing,
    /** Lines for the session's next browser call (downloads that arrived, or could not). */
    takeNotes: (session: string): string[] => {
      const left = leftNotes.get(session) ?? [];
      leftNotes.delete(session);
      return [...left, ...(companions.get(session)?.takeNotes() ?? [])];
    },
    /** A file of the Cloud given to the session's browser for a page's file input: its path in the sandbox, or the line to say. */
    upload: (session: string, file: string, name: string | null, size: number) =>
      companions.get(session)?.upload(file, name, size) ?? Promise.resolve({ error: "This browser closed; try the upload again." }),
    /** Today's counts for the health report. Read on the Admin's poll, never at start: a sandbox an earlier run of this
     * server left awake gets its idle window here, and the lever's day-old cleanup runs here. */
    report: () => {
      if (!leftAwakeArmed && bots().size === 0 && rails.leftAwake()) {
        leftAwakeArmed = true;
        deps.used(BROWSER_SANDBOX_OWNER, CLOUD_BROWSER_IDLE_MS);
        rails.asleep();
      }
      if (cloudBrowserLever(deps.env)) leverCleanup();
      return rails.report();
    },
    closeAll(): void {
      if (sweep) clearInterval(sweep);
      sweep = null;
      for (const companion of companions.values()) companion.close();
      companions.clear();
      doors.closeAll();
      lastUse.clear();
      sessions.clear();
    },
  };
}
export type CloudBrowser = ReturnType<typeof createCloudBrowser>;
export type { HomeReason } from "./rails.ts";
