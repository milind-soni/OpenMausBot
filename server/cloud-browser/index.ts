// A personal Cloud's bots browse in the Cloud's own browser sandbox at the provider (remote.ts), so a page's memory and
// CPU are not the home's. Decided once per browser session, when its browser opens; a session never moves while it runs.
// Every case this cannot serve opens the home's browser exactly as before, with one log line naming why. A desktop
// install never builds this. The one operator lever, never a product setting: OMB_CLOUD_BROWSER=home keeps every browser
// in the home, and after a day of it the sandbox is deleted.
import { randomBytes } from "node:crypto";

import { cloudFailureOf } from "../boat-limit.ts";
import { CloudBrowserDoors, dialable, probeDoor, type DoorTarget } from "./door.ts";
import { connectCdp } from "../browser-sites.ts";
import { CarryFailed, SandboxCompanion, SignInsUnreadable, type CompanionDeps, type SignInStore } from "./companion.ts";
import { createCloudBrowserRails, type CloudBrowserRails, type HomeReason } from "./rails.ts";
import { BROWSER_SANDBOX_CHROMES, BROWSER_SANDBOX_OWNER, COMPUTER_DOOR_PORT, OldRelay, profileKey, StaysHome, wakeSandbox, type ComputerOps } from "./remote.ts";

/** A browser in the sandbox with no activity this long is closed; the sandbox sleeps once none is left. */
export const CLOUD_BROWSER_IDLE_MS = 3 * 60_000;
const SWEEP_MS = 30_000;
const LEVER_CLEANUP_GAP_MS = 60 * 60_000;
/** While a browser is used, the provider's own auto-stop is pushed to this far ahead, at most every TTL_REFRESH_MS: it then
 * stops the sandbox by itself when everything here died, and never in the middle of a session in use. */
export const SANDBOX_IDLE_TTL_SECONDS = 1_200;
export const TTL_REFRESH_MS = 10 * 60_000;

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
  /** A turn holds this session's browser now: it is not closed for being idle. */
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
  /** Each running session's bot; one Chrome per bot's profile. */
  const sessions = new Map<string, string>();
  /** Bots whose browser is being opened now. */
  const opening = new Set<string>();
  /** A session's open under way: a second call for the same session waits on it, so one session never splits in two. */
  const pendingSessions = new Map<string, Promise<Opened>>();
  const closing = new Set<string>();
  const companions = new Map<string, SandboxCompanion>();
  /** What a closed session's companion still had to say (a last download retry), for that session's next call. */
  const leftNotes = new Map<string, string[]>();
  /** One wake of the sandbox at a time, shared by every bot opening meanwhile. */
  let waking: Promise<{ id: string; started: boolean }> | null = null;
  let boxId: string | null = null;
  let sweep: ReturnType<typeof setInterval> | null = null;
  let leftAwakeArmed = false;
  /** Woken (or found awake) by an open here and not yet let sleep. */
  let awake = false;
  let leverCleanupAt = -Infinity;
  let ttlRefreshedAt = 0;

  const home = (request: OpenRequest, reason: HomeReason): Opened => {
    rails.home(reason);
    log(`browser ${request.session}: opens in the home, not in the Cloud's browser sandbox (${reason})`);
    return { home: reason };
  };
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
    // The account's start pool (the relay's "busy", or the provider's own limit met with a person's own key): the rest of the day.
    if (failure.status === 429) { rails.accountLimit(undefined); return "account-limit"; }
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
  }

  async function wake(ops: ComputerOps): Promise<{ id: string; started: boolean }> {
    waking ??= wakeSandbox(ops, {
      mayStart: () => rails.refusal(true) === null,
      allowed: () => allowed(ops),
      starting: () => rails.resumed(),
      ...(deps.pollMs ? { pollMs: deps.pollMs } : {}),
    }).finally(() => { waking = null; });
    const box = await waking;
    boxId = box.id;
    awake = true;
    // Woken now: the deadline the Admin set at the resume is fresh.
    if (box.started) ttlRefreshedAt = now();
    rails.awake();
    // On from here: the idle path times it, whatever happens next.
    deps.used(BROWSER_SANDBOX_OWNER, CLOUD_BROWSER_IDLE_MS);
    return box;
  }

  async function launch(request: OpenRequest, ops: ComputerOps): Promise<Opened> {
    const key = profileKey(request.botId);
    let box: { id: string; started: boolean } | null = null;
    const quit = async () => { if (box) await ops.quit(box.id, key).catch(() => undefined); };
    try {
      box = await wake(ops);
      const secret = randomBytes(24).toString("hex");
      const answer = await ops.launch(box.id, key, secret);
      if (!answer.chrome || !answer.home) {
        rails.failed();
        await quit();
        return home(request, "start-failed");
      }
      const relay = await ops.host(box.id, COMPUTER_DOOR_PORT).catch(() => null);
      const url = relay ? dialable(relay) : null;
      if (!url) {
        rails.noRoute();
        await quit();
        return home(request, "no-route");
      }
      const target: DoorTarget = { url, secret: `${key}/${secret}` };
      if (!await probeDoor(target)) {
        rails.failed();
        await quit();
        return home(request, "unreachable");
      }
      const cdpUrl = await doors.open(request.session, target);
      const companion = new SandboxCompanion({
        session: request.session, botId: request.botId, key, boxId: box.id, home: answer.home, ops, rails, signIns: deps.signIns ?? null,
        folder: (botId) => deps.folder?.(botId) ?? null, log, now, ...(deps.disk ? { disk: deps.disk } : {}),
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
      rails.setCarryBad(key, null);
      companions.set(request.session, companion);
      sessions.set(request.session, request.botId);
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
    if (bots().size >= BROWSER_SANDBOX_CHROMES) return home(request, "sandbox-full");
    // The home's copy Chrome refused before, unchanged since: not worth a wake.
    const known = deps.signIns?.load(request.session);
    const bad = rails.carryBad(profileKey(request.botId));
    if (bad !== null && known && known !== "unreadable" && known.modified === bad) return home(request, "sign-ins");
    opening.add(request.botId);
    try {
      return await launch(request, ops);
    } finally {
      opening.delete(request.botId);
      letSleep();
    }
  }

  /** The bot's Chrome quits cleanly (its cookies written), the engine's session ends, and the sandbox may sleep. */
  async function close(session: string): Promise<void> {
    const botId = sessions.get(session);
    if (!botId || closing.has(session)) return;
    closing.add(session);
    try {
      const companion = companions.get(session);
      await companion?.stop().catch(() => undefined);
      const notes = companion?.takeNotes() ?? [];
      if (notes.length) leftNotes.set(session, notes);
      companions.delete(session);
      await deps.closeEngine(session).catch(() => undefined);
      doors.close(session);
      sessions.delete(session);
      const ops = deps.ops();
      if (ops && boxId) await ops.quit(boxId, bots().size > 0 ? profileKey(botId) : null).catch(() => undefined);
      letSleep();
      log(`browser ${session}: closed in the Cloud's browser sandbox after ${Math.round(CLOUD_BROWSER_IDLE_MS / 60_000)} minutes unused`);
    } finally {
      closing.delete(session);
    }
  }

  /** The provider's auto-stop pushed ahead while some browser here was used since the last push. */
  async function refreshTtl(at: number): Promise<void> {
    const ops = deps.ops();
    if (!ops || !boxId || at - ttlRefreshedAt < TTL_REFRESH_MS) return;
    const used = doors.sessions().some((session) => (doors.lastActivity(session) ?? 0) > ttlRefreshedAt);
    if (!used) return;
    ttlRefreshedAt = at;
    await ops.refreshTtl(boxId, SANDBOX_IDLE_TTL_SECONDS).catch(() => undefined);
  }

  async function closeIdle(): Promise<void> {
    const at = now();
    await refreshTtl(at);
    await Promise.all([...companions.values()].map((companion) => companion.periodic()));
    await Promise.all(doors.sessions().map(async (session) => {
      const last = doors.lastActivity(session);
      if (last !== null && at - last >= CLOUD_BROWSER_IDLE_MS && !deps.held(session)) await close(session);
    }));
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
    /** A browser is open or opening in the sandbox: its idle path must not stop it. */
    busy: (owner: string): boolean => owner === BROWSER_SANDBOX_OWNER && bots().size > 0,
    close,
    closeIdle,
    dialed: (session: string): number => doors.dialed(session),
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
      sessions.clear();
    },
  };
}
export type CloudBrowser = ReturnType<typeof createCloudBrowser>;
export type { HomeReason } from "./rails.ts";
