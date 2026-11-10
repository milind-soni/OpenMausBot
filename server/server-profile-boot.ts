// Turns the server's profile on at start (server-profile.ts decides which): starts the bot box, stops a server that must
// be boxed and can't be, keeps what earlier starts ran in the data folder, and holds the notice Settings shows an admin.
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

import type { SignInLists } from "./admin-activity.ts";
import { writeFileAtomic } from "./atomic.ts";
import { startBotBoxAtBoot } from "./bot-box/boot.ts";
import { detectBox, type BoxDetection } from "./bot-box/detect.ts";
import { hostedWorkspaceConfigured } from "./enterprise.ts";
import {
  boxFault, profileOutcome, resolveServerProfile, signInListsFor, startLogLines, wideningVerdict, BOX_FIX, OPERATOR_TOKEN_FILE,
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
  /** Starts the box and says what it found; the real one by default. */
  startBox?: (hardened: boolean) => Promise<Pick<BoxDetection, "box" | "reason">>;
  /** Stops the server with the sentence; the real one exits. */
  refuse?: (message: string) => never;
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
  const profile = resolveServerProfile({
    env, platform: options.platform, desktopManaged: env.OMB_DESKTOP_PARENT === "1", cloudHome: options.cloudHome,
    hostedWorkspace: hostedWorkspaceConfigured(env), signIn: signInListsFor(dataDir, env),
    fromSource: options.fromSource ?? import.meta.url.endsWith(".ts"),
  });
  const hardened = profile.name === "hardened";
  const startBox = options.startBox ?? ((wanted: boolean) => startBotBoxAtBoot({ dataDir, port: options.port, hardened: wanted }));
  const detection = await startBox(hardened && !options.cloudHome);
  const boxed = detection.box !== "off";
  if (options.cloudHome) {
    if (profile.warning) log("warn", `server profile: ${profile.warning}`);
    return { profile, outcome: { state: "hardened" }, boxed, boxesBrowser: false, serviceTrust: true, operatorToken: undefined, status: () => ({ profile: "hardened", boxed }), wideningRefusal: () => null, dismissNotice: () => {} };
  }
  const stored = readStored(dataDir);
  const record: ProfileRecord = { inUse: serverInUse(dataDir), hardenedBefore: stored.hardenedSince !== undefined };
  const outcome = profileOutcome(profile, detection, record);
  if (outcome.state === "refused") return (options.refuse ?? refuseToStart)(outcome.message);
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

  let restartOwed = false;
  const notice = (): ProfileNotice | undefined => {
    if (outcome.state === "unboxed") {
      // Where nobody else signs in the admin is told once; where others do, until it is fixed.
      const dismissible = !profile.shared;
      return dismissible && stored.unboxedRead ? undefined : { kind: "unboxed", fault: outcome.fault, shared: profile.shared, dismissible };
    }
    if (restartOwed) return { kind: "restart" };
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
      if (verdict === "restart") {
        restartOwed = true;
        log("warn", "server profile: more than one person can now sign in. Start this server again to turn on its hardened profile (the bots' sandbox, and local requests no longer trusted as the owner).");
      }
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
