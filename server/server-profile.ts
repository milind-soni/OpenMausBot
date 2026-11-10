// The hardened profile: what a Cloud home runs, as one named thing a self-hosted server turns on in one place. A server
// more than one person can sign in to, and the server image on Linux, run it: every bot turn in the bot box
// (server/bot-box), local requests without a session trusted as a service and never as the owner (request-auth.ts), and
// memory read only from regular files. A server one person uses on their own computer stays `standard`, as before.
//
// Security: the parts hold together or not at all. Without the box a bot's shell is the server's own user: it reads
// config.json (the AI keys), the saved logins and every chat whatever local requests are trusted as. So a server that
// must run the profile and cannot box says so and stops, or, when it already holds someone's work, keeps running and
// tells its admin on every start and in Settings until it is fixed.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sharedSignIn, signInListsOf, type SignInLists } from "./admin-activity.ts";
import type { BoxDetection } from "./bot-box/detect.ts";

export type ProfileName = "hardened" | "standard";

/** Why the server runs the profile it runs, as a fixed code. */
export type ProfileReason =
  | "cloud-home" | "desktop-app" | "switched-off" | "requested" | "from-source" | "hosted-workspace" | "licence" | "shared" | "server-image" | "one-owner";

export interface ProfileFacts {
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** The desktop app runs this server: its local changes already need the app's own per-launch capability. */
  desktopManaged: boolean;
  cloudHome: boolean;
  hostedWorkspace: boolean;
  /** This server runs from TypeScript source rather than a build: a checkout someone develops or tests in. */
  fromSource?: boolean;
  /** Who may sign in with an emailed code: config.json's lists, or the environment's when set. */
  signIn: SignInLists;
}

export interface ServerProfile {
  name: ProfileName;
  reason: ProfileReason;
  /** Someone besides its one owner can sign in, or its operator asked for the profile: it is not optional here. When
   * false the profile is a default (the server image) that a host unable to box may fall short of, loudly. */
  required: boolean;
  /** More than one person can sign in, whatever profile runs. */
  shared: boolean;
  warning?: string;
}

/** `OMB_PROFILE`: the one switch. `hardened` asks for the profile anywhere; `standard` declines it; `auto` is the
 * default said aloud, for a server run from source, which otherwise never turns the profile on by itself. */
export const PROFILE_ENV = "OMB_PROFILE";
/** Set by the server image (Dockerfile, target `server`): a container is a server, never someone's own desktop. */
export const SERVER_IMAGE_ENV = "OMB_IMAGE";

/** In the data folder, which no box contains: reading it proves a command runs on the server itself, outside every bot. */
export const OPERATOR_TOKEN_FILE = "operator-token";

export function readOperatorToken(dataDir: string | undefined): string | undefined {
  if (!dataDir) return undefined;
  try {
    const token = readFileSync(join(dataDir, OPERATOR_TOKEN_FILE), "utf8").trim();
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Unboxed, a bot's shell is the server's own user: it reads the data folder and writes it too. */
const UNSANDBOXED_RISK = "anyone who can chat with a bot can make it read this server's AI keys, saved logins and other people's chats, and change its settings, including who may sign in";

/** The sign-in lists as the server reads them (server/config.ts loadConfig): the environment's win when set. */
export function signInListsFor(dataDir: string, env: Record<string, string | undefined> = process.env): SignInLists {
  let stored: unknown = null;
  try { stored = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")); } catch { stored = null; }
  const lists = signInListsOf(stored);
  const split = (value: string) => value.split(/[,\s]+/).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return {
    admins: env.OMB_SIGNIN_EMAILS !== undefined ? split(env.OMB_SIGNIN_EMAILS) : lists.admins,
    members: env.OMB_SIGNIN_MEMBER_EMAILS !== undefined ? split(env.OMB_SIGNIN_MEMBER_EMAILS) : lists.members,
  };
}

/** More than one person can sign in: a hosted workspace, an organization's licence, or a sign-in list that names more
 * than its one owner. A Cloud home is its own case. */
export function sharedServer(facts: Pick<ProfileFacts, "env" | "hostedWorkspace" | "signIn">): "hosted-workspace" | "licence" | "shared" | null {
  if (facts.hostedWorkspace) return "hosted-workspace";
  if (facts.env.OMB_LICENSE_KEY?.trim()) return "licence";
  return sharedSignIn(facts.signIn) ? "shared" : null;
}

export function resolveServerProfile(facts: ProfileFacts): ServerProfile {
  const raw = facts.env[PROFILE_ENV];
  const asked = raw?.trim().toLowerCase() ?? "";
  const ignored = (where: string) => (raw !== undefined && asked !== "" ? { warning: `${PROFILE_ENV} is ignored ${where}` } : {});
  if (facts.cloudHome) return { name: "hardened", reason: "cloud-home", required: true, shared: true, ...ignored("on a MausBot Cloud home: it always runs the hardened profile") };
  const sharedBy = sharedServer(facts);
  const shared = sharedBy !== null;
  if (facts.desktopManaged) return { name: "standard", reason: "desktop-app", required: false, shared, ...ignored("in the desktop app") };
  if (asked === "standard") {
    return {
      name: "standard", reason: "switched-off", required: false, shared,
      ...(shared ? { warning: `${PROFILE_ENV}=standard on a server more than one person can sign in to: ${UNSANDBOXED_RISK}` } : {}),
    };
  }
  if (asked === "hardened") return { name: "hardened", reason: "requested", required: true, shared };
  if (asked !== "" && asked !== "auto") {
    return { name: "hardened", reason: "requested", required: true, shared, warning: `${PROFILE_ENV}="${raw!.replace(/[^\w.-]/g, "").slice(0, 40)}" is not hardened or standard; using hardened` };
  }
  // Every released form of the server is a build. A checkout run from source is someone's development or test server:
  // it keeps its behaviour and is told, rather than refusing to start on a laptop with no bubblewrap.
  if (facts.fromSource && asked !== "auto") {
    return {
      name: "standard", reason: "from-source", required: false, shared,
      ...(shared ? { warning: `this server runs from source, where the hardened profile is not turned on by itself, and more than one person can sign in: ${UNSANDBOXED_RISK}. Set ${PROFILE_ENV}=hardened` } : {}),
    };
  }
  if (sharedBy) return { name: "hardened", reason: sharedBy, required: true, shared };
  if (facts.env[SERVER_IMAGE_ENV] === "server" && (facts.platform ?? process.platform) === "linux") {
    return { name: "hardened", reason: "server-image", required: false, shared };
  }
  return { name: "standard", reason: "one-owner", required: false, shared };
}

/** Why the box is not running where the profile wants it. */
export type BoxFault = "switched-off" | "not-linux" | "no-bwrap" | "userns-refused";

export function boxFault(detection: Pick<BoxDetection, "box" | "reason">): BoxFault | null {
  if (detection.box !== "off") return null;
  return detection.reason === null || detection.reason === "not-cloud" ? "switched-off" : detection.reason;
}

/** What to do about it, as one plain sentence. */
export const BOX_FIX: Record<BoxFault, string> = {
  "switched-off": "OMB_BOT_BOX=0 turns the bots' sandbox off: remove it and start the server again.",
  "not-linux": "The bots' sandbox needs Linux: run this server on Linux, or in Docker on a Linux host.",
  "no-bwrap": "Install bubblewrap on this server (on Debian or Ubuntu: sudo apt-get install -y bubblewrap) and start it again.",
  "userns-refused": "This system does not let a program build its own sandbox (unprivileged user namespaces are off). In Docker, start the container with the bot box's seccomp and AppArmor profiles (docs/self-hosting.md, \"The hardened profile\"). On Ubuntu 23.10 or later without Docker, run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0",
};

/** What the data folder says about earlier starts. */
export interface ProfileRecord {
  /** Someone already uses this server: it holds settings or a signed-in device from before this start. */
  inUse: boolean;
  /** An earlier start ran the whole profile here. */
  hardenedBefore: boolean;
}

export type ProfileOutcome =
  | { state: "standard" }
  /** The whole profile: boxed turns, service trust. */
  | { state: "hardened" }
  /** Running without the box, and saying so. `serviceTrust`: local requests are still a service's, never the owner's. */
  | { state: "unboxed"; fault: BoxFault; serviceTrust: boolean }
  | { state: "refused"; fault: BoxFault; message: string };

export function refusalMessage(profile: Pick<ServerProfile, "shared">, fault: BoxFault, record: ProfileRecord): string {
  const why = record.hardenedBefore
    ? "this server ran its bots in a sandbox before, and now it can't"
    : profile.shared
      ? "more than one person can sign in to this server, so its bots must run in a sandbox, and here they can't"
      : `${PROFILE_ENV}=hardened asks for the bots' sandbox, and here it can't run`;
  return `OpenMausBot did not start: ${why}. ${BOX_FIX[fault]} Nothing was changed. To run without the sandbox anyway, set ${PROFILE_ENV}=standard: then ${UNSANDBOXED_RISK}.`;
}

/**
 * What the server does with the profile it resolved and the box it found.
 *
 * Security: a server never drops out of the profile quietly. One that ran it before, or a new one that must run it,
 * stops with the sentence to fix. One that is already in use and only now falls under the profile keeps its people
 * working and is told (`unboxed`), because stopping it would take their work offline for a change they did not make.
 */
export function profileOutcome(profile: ServerProfile, detection: Pick<BoxDetection, "box" | "reason">, record: ProfileRecord): ProfileOutcome {
  if (profile.name === "standard") return { state: "standard" };
  const fault = boxFault(detection);
  if (!fault) return { state: "hardened" };
  if (fault === "not-linux") return { state: "unboxed", fault, serviceTrust: true };
  if (record.hardenedBefore || (profile.required && !record.inUse)) return { state: "refused", fault, message: refusalMessage(profile, fault, record) };
  return { state: "unboxed", fault, serviceTrust: profile.required };
}

/** What Settings shows an admin about the profile. `on` and an optional `unboxed` are shown once; the rest stay. */
export type ProfileNotice =
  | { kind: "on" }
  | { kind: "unboxed"; fault: BoxFault; shared: boolean; dismissible: boolean }
  | { kind: "restart" };

export interface ProfileStatus {
  profile: ProfileName;
  boxed: boolean;
  notice?: ProfileNotice;
}

export function startLogLines(profile: ServerProfile, outcome: Exclude<ProfileOutcome, { state: "refused" }>): { level: "log" | "warn"; line: string }[] {
  const lines: { level: "log" | "warn"; line: string }[] = [];
  if (profile.warning) lines.push({ level: "warn", line: `server profile: ${profile.warning}` });
  if (outcome.state === "standard") lines.push({ level: "log", line: `server profile: standard (${profile.reason})` });
  else if (outcome.state === "hardened") lines.push({ level: "log", line: `server profile: hardened (${profile.reason}); bots run in a sandbox and local requests without a session are a service's` });
  else {
    lines.push({
      level: "warn",
      line: `server profile: hardened (${profile.reason}), but the bots are NOT sandboxed: ${BOX_FIX[outcome.fault]} Until then ${UNSANDBOXED_RISK}.${outcome.fault === "not-linux" ? "" : ` Set ${PROFILE_ENV}=standard to accept that and stop this warning.`}`,
    });
  }
  return lines;
}

/** Entries the change adds to either list. */
export function addedSignIns(current: SignInLists, next: SignInLists): string[] {
  const had = new Set([...current.admins, ...current.members].map((entry) => entry.trim().toLowerCase()));
  return [...next.admins, ...next.members].map((entry) => entry.trim().toLowerCase()).filter((entry) => entry && !had.has(entry));
}

/**
 * Whether a server may take the people a sign-in list change adds, given what it runs now. `canBox` is asked only of a
 * `standard` server on Linux, whose box was never tried. Returns the fault that refuses the change, `restart` when the
 * change stands and the profile starts with the next start, or null when nothing more is needed.
 */
export function wideningVerdict(input: {
  profile: ServerProfile;
  outcome: Exclude<ProfileOutcome, { state: "refused" }>;
  current: SignInLists;
  next: SignInLists;
  canBox(): BoxFault | null;
}): { refuse: BoxFault } | "restart" | null {
  const { profile, outcome } = input;
  if (profile.reason === "cloud-home" || profile.reason === "desktop-app" || profile.reason === "switched-off" || profile.reason === "from-source") return null;
  if (!sharedSignIn(input.next) || addedSignIns(input.current, input.next).length === 0) return null;
  if (outcome.state === "hardened") return null;
  if (outcome.state === "unboxed") return outcome.fault === "not-linux" ? null : { refuse: outcome.fault };
  const fault = input.canBox();
  if (fault && fault !== "not-linux") return { refuse: fault };
  return "restart";
}
