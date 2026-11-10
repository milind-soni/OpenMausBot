// Turns the server's profile on at start (server-profile.ts decides which): starts the bot box, stops a server that must
// be boxed and can't be, keeps what earlier starts ran in the data folder, and holds the notice Settings shows an admin.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { sharedSignIn, type SignInLists } from "./admin-activity.ts";
import { writeFileAtomic } from "./atomic.ts";
import { botBox, startBotBoxAtBoot } from "./bot-box/boot.ts";
import type { BotBox } from "./bot-box/box.ts";
import { detectBox, type BoxDetection } from "./bot-box/detect.ts";
import { hostedWorkspaceConfigured } from "./enterprise.ts";
import {
  boxFault, profileOutcome, resolveServerProfile, signInListsFor, startLogLines, wideningVerdict, BOX_FIX, OPERATOR_TOKEN_FILE, PROFILE_ENV, SERVER_IMAGE_ENV,
  type BoxFault, type ProfileNotice, type ProfileOutcome, type ProfileRecord, type ProfileStatus, type ServerProfile,
} from "./server-profile.ts";
import { readMemoryOnlyFromRegularFiles } from "./workspace.ts";

/** EX_CONFIG: the server will not start as it is set up. Never RESTART_EXIT_CODE, so no launcher starts it again. */
export const PROFILE_REFUSED_EXIT_CODE = 78;

const RECORD_FILE = "server-profile.json";

interface StoredRecord {
  /** When the whole profile first ran here. */
  hardenedSince?: string;
  /** The one-time "now hardened" notice is still owed to an admin. */
  announce?: boolean;
  /** An admin has read that this server's bots are not sandboxed. */
  unboxedRead?: boolean;
}

function readStored(dataDir: string): StoredRecord {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dataDir, RECORD_FILE), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.hardenedSince === "string" ? { hardenedSince: record.hardenedSince } : {}),
      ...(record.announce === true ? { announce: true } : {}),
      ...(record.unboxedRead === true ? { unboxedRead: true } : {}),
    };
  } catch {
    return {};
  }
}

function writeStored(dataDir: string, record: StoredRecord): void {
  writeFileAtomic(join(dataDir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/** Someone signed in here before this start: sessions.json holds a device or a person. */
export function serverInUse(dataDir: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, "sessions.json"), "utf8")) as { sessions?: unknown };
    return Array.isArray(parsed.sessions) && parsed.sessions.length > 0;
  } catch {
    return false;
  }
}

export function profileRecord(dataDir: string): ProfileRecord {
  return { inUse: serverInUse(dataDir), hardenedBefore: readStored(dataDir).hardenedSince !== undefined };
}

/** The secret a command on the server itself presents to get a pairing code (request-auth.ts): new at every start,
 * 0600, and only while every bot is boxed away from the data folder. */
export function writeOperatorToken(dataDir: string): string {
  const token = randomBytes(32).toString("base64url");
  writeFileAtomic(join(dataDir, OPERATOR_TOKEN_FILE), `${token}\n`, { mode: 0o600 });
  return token;
}

/** What a boxed shell in this server's own layout says of the server's files. */
export type LayoutVerdict = { hidden: true } | { hidden: false; why: string };

/**
 * Runs one boxed shell laid out as a bot's turn is here (the real data folder and HOME, a conversation folder of its
 * own) and asks it whether a file the server just wrote in its data folder is there.
 *
 * Security: the plan covers the data folder wherever it is (bot-box/plan.ts coverDataFolder), and the self-check proves
 * the box on a fixture. This proves the one thing a fixture cannot: that on this machine's layout the cover holds. A
 * server never says "hardened" over a data folder a bot can read.
 */
export function checkLayout(dataDir: string, box: Pick<BotBox, "wrap" | "startOptions"> = botBox): LayoutVerdict {
  const canary = join(dataDir, "box", `layout-${randomBytes(6).toString("hex")}`);
  const bot = "omb-layout-check";
  const cwd = join(dataDir, "task-workspaces", bot, "t"), own = join(dataDir, "workspaces", bot);
  try {
    for (const folder of [cwd, own]) mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(canary, "the server's own\n", { mode: 0o600 });
    const home = box.startOptions()?.home ?? dataDir;
    // The paths ride as arguments: a command line is not a grant, so naming them shows nothing.
    const script = 'for path in "$@"; do if [ -e "$path" ]; then echo "omb-layout:visible $path"; exit 0; fi; done; echo omb-layout:hidden';
    const wrapped = box.wrap({
      command: "/bin/sh", args: ["-c", script, "sh", canary, join(dataDir, "config.json"), join(dataDir, "sessions.json"), join(dataDir, OPERATOR_TOKEN_FILE)],
      cwd, env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: home }, botId: bot,
    });
    if (!wrapped) return { hidden: false, why: "the box is not on" };
    let result: SpawnSyncReturns<string>;
    try {
      result = spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe", ...wrapped.extraFds] });
    } finally {
      for (const fd of wrapped.extraFds) try { closeSync(fd); } catch {}
      wrapped.release();
    }
    const said = result.stdout.trim().split("\n").at(-1) ?? "";
    if (said === "omb-layout:hidden") return { hidden: true };
    if (said.startsWith("omb-layout:visible ")) return { hidden: false, why: `a bot can see ${said.slice("omb-layout:visible ".length)}` };
    return { hidden: false, why: `a sandboxed command could not run (${(result.stderr.trim().split("\n").at(-1) ?? "").slice(0, 200) || result.error?.message || `exit ${result.status}`})` };
  } catch (error) {
    return { hidden: false, why: `the check could not run (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    rmSync(canary, { force: true });
    // The box makes the turn's uploads folder (box.ts) beside the two this made.
    for (const folder of [join(dataDir, "task-workspaces", bot), own, join(dataDir, "box-uploads", bot)]) rmSync(folder, { recursive: true, force: true });
  }
}

let admit: <T extends SignInLists>(lists: T) => T = (lists) => lists;

/**
 * The sign-in lists this server honours now: the saved ones, except on a server that started as one person's and so
 * trusts local requests as its owner. There a list that lets a second person in is held until the next start, which
 * turns the profile on, and the lists as they last were for one person stay in force.
 *
 * Security: the lists are read on every request and can be edited on disk (`openmausbot access add`), while the profile
 * and loopback trust are decided at start. Without the hold, the new person's bot would be the owner over loopback
 * until someone restarted the server.
 */
export function admittedSignIns<T extends SignInLists>(lists: T): T {
  return admit(lists);
}

export interface RunningProfile {
  profile: ServerProfile;
  outcome: Exclude<ProfileOutcome, { state: "refused" }>;
  /** Every bot turn runs in the box. */
  boxed: boolean;
  /** A self-hosted server running the whole profile: each Chrome of its bots' browsers is boxed too, as on a Team Cloud. */
  boxesBrowser: boolean;
  /** Local requests without a session are a service's, never the owner's. */
  serviceTrust: boolean;
  operatorToken: string | undefined;
  status(): ProfileStatus;
  /** Why a sign-in list change that adds people is refused here, as the fault to fix; null lets it through. */
  wideningRefusal(current: SignInLists, next: SignInLists): BoxFault | null;
  dismissNotice(): void;
}

export interface ProfileBootOptions {
  dataDir: string;
  port: number;
  cloudHome: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** This server runs from TypeScript source; by default, whether this module does. */
  fromSource?: boolean;
  log?: (level: "log" | "warn", line: string) => void;
  /** Starts the box and says what it found; the real one by default. `guardHome`: HOME is a person's own here. */
  startBox?: (hardened: boolean, guardHome: boolean) => Promise<Pick<BoxDetection, "box" | "reason">>;
  /** Stops the server with the sentence; the real one exits. */
  refuse?: (message: string) => never;
  /** Whether the server's files are hidden from a boxed shell in this layout; the real check by default. */
  checkLayout?: () => LayoutVerdict;
  /** Whether this host could box, for a `standard` server asked to take more people. */
  probeBox?: () => Pick<BoxDetection, "box" | "reason">;
}

function refuseToStart(message: string): never {
  // Synchronous, so the sentence is out before the process is.
  try { writeSync(2, `${message}\n`); } catch {}
  process.exit(PROFILE_REFUSED_EXIT_CODE);
}

export async function startServerProfile(options: ProfileBootOptions): Promise<RunningProfile> {
  const env = options.env ?? process.env, dataDir = options.dataDir;
  const log = options.log ?? ((level, line) => (level === "warn" ? console.warn(line) : console.log(line)));
  const startLists = signInListsFor(dataDir, env);
  const profile = resolveServerProfile({
    env, platform: options.platform, desktopManaged: env.OMB_DESKTOP_PARENT === "1", cloudHome: options.cloudHome,
    hostedWorkspace: hostedWorkspaceConfigured(env), signIn: startLists,
    fromSource: options.fromSource ?? import.meta.url.endsWith(".ts"),
  });
  const hardened = profile.name === "hardened";
  const startBox = options.startBox ?? ((wanted: boolean, guardHome: boolean) => startBotBoxAtBoot({ dataDir, port: options.port, hardened: wanted, guardHome }));
  // The image's HOME holds only what its owner put there for the engines; anyone else's HOME, or one others' bots
  // work in, is guarded.
  const selfHosted = hardened && !options.cloudHome;
  const detection = await startBox(selfHosted, selfHosted && (profile.shared || env[SERVER_IMAGE_ENV] !== "server"));
  const boxed = detection.box !== "off";
  if (options.cloudHome) {
    if (profile.warning) log("warn", `server profile: ${profile.warning}`);
    return { profile, outcome: { state: "hardened" }, boxed, boxesBrowser: false, serviceTrust: true, operatorToken: undefined, status: () => ({ profile: "hardened", boxed }), wideningRefusal: () => null, dismissNotice: () => {} };
  }
  const stored = readStored(dataDir);
  const record: ProfileRecord = { inUse: serverInUse(dataDir), hardenedBefore: stored.hardenedSince !== undefined };
  const outcome = profileOutcome(profile, detection, record);
  if (outcome.state === "refused") return (options.refuse ?? refuseToStart)(outcome.message);
  if (outcome.state === "hardened") {
    const layout = (options.checkLayout ?? (() => checkLayout(dataDir)))();
    if (!layout.hidden) {
      return (options.refuse ?? refuseToStart)(`OpenMausBot did not start: its bots' sandbox is on, but it does not keep the server's own files from them here: ${layout.why}. The data folder is ${dataDir}. Nothing was changed. Please report this: it is a fault in OpenMausBot or in this server's bubblewrap, not in your settings. To run without the sandbox meanwhile, set ${PROFILE_ENV}=standard.`);
    }
  }
  for (const { level, line } of startLogLines(profile, outcome)) log(level, line);

  let operatorToken: string | undefined;
  if (outcome.state === "hardened") {
    // A link in a bot's folder must not make the server read its own settings back to that bot.
    readMemoryOnlyFromRegularFiles();
    if (!stored.hardenedSince) {
      stored.hardenedSince = new Date().toISOString();
      // Only a server already in use has something to be told: what changed under it.
      if (record.inUse) stored.announce = true;
      writeStored(dataDir, stored);
    }
    if (profile.reason !== "hosted-workspace") operatorToken = writeOperatorToken(dataDir);
  } else {
    rmSync(join(dataDir, OPERATOR_TOKEN_FILE), { force: true });
  }

  let restartOwed = false, held = false;
  // Only a server that took itself for one person's: a declined profile, a checkout run from source and the desktop app
  // keep the behaviour they had.
  const holds = profile.reason === "one-owner" || (profile.reason === "server-image" && outcome.state === "unboxed");
  // The lists it started with let one person in (else it would not hold): they stay in force until the next start.
  let oneOwners: SignInLists = startLists;
  // A shared server that cannot box keeps the people it started with and takes no new ones, by any way in.
  const frozen = outcome.state === "unboxed" && profile.required && outcome.fault !== "not-linux";
  const norm = (entry: string) => entry.trim().toLowerCase();
  const atStart = { admins: new Set(startLists.admins.map(norm)), members: new Set(startLists.members.map(norm)) };
  let refusedNew = false;
  admit = (lists) => {
    if (frozen) {
      const admins = lists.admins.filter((entry) => atStart.admins.has(norm(entry))), members = lists.members.filter((entry) => atStart.members.has(norm(entry)));
      if (admins.length === lists.admins.length && members.length === lists.members.length) return lists;
      if (!refusedNew) log("warn", "server profile: the sign-in list has people added since this server started. It cannot run its bots in a sandbox, so they are not let in; the people it started with still are.");
      refusedNew = true;
      return { ...lists, admins, members };
    }
    if (!holds) return lists;
    if (!sharedSignIn(lists)) {
      oneOwners = lists;
      held = false;
      restartOwed = false;
      return lists;
    }
    if (!held) log("warn", "server profile: the sign-in list now lets more than one person in. They can sign in once this server has started again, which turns on its hardened profile; until then the list is held as it was.");
    held = true;
    return oneOwners as typeof lists;
  };
  const notice = (): ProfileNotice | undefined => {
    if (restartOwed || held) return { kind: "restart" };
    if (outcome.state === "unboxed") {
      // Where nobody else signs in the admin is told once; where others do, until it is fixed.
      const dismissible = !profile.shared;
      return dismissible && stored.unboxedRead ? undefined : { kind: "unboxed", fault: outcome.fault, shared: profile.shared, dismissible };
    }
    return outcome.state === "hardened" && stored.announce ? { kind: "on" } : undefined;
  };
  return {
    profile, outcome, boxed, operatorToken, boxesBrowser: outcome.state === "hardened",
    serviceTrust: outcome.state === "hardened" || (outcome.state === "unboxed" && outcome.serviceTrust),
    status: () => {
      const shown = notice();
      return { profile: profile.name, boxed, ...(shown ? { notice: shown } : {}) };
    },
    wideningRefusal: (current, next) => {
      const verdict = wideningVerdict({
        profile, outcome, current, next,
        canBox: () => boxFault((options.probeBox ?? (() => detectBox({ env, platform: options.platform, hardened: true })))()),
      });
      if (verdict === "restart") restartOwed = true;
      return verdict !== null && verdict !== "restart" ? verdict.refuse : null;
    },
    dismissNotice: () => {
      if (outcome.state === "hardened" && stored.announce) { delete stored.announce; writeStored(dataDir, stored); }
      if (outcome.state === "unboxed" && !profile.shared && !stored.unboxedRead) { stored.unboxedRead = true; writeStored(dataDir, stored); }
    },
  };
}

/** The sentence a refused sign-in list change answers with. */
export function wideningRefusalText(fault: BoxFault): string {
  return `This server can't run its bots in a sandbox yet, so it can't take more people. ${BOX_FIX[fault]}`;
}
