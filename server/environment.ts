// Served without auth at /.well-known/openmausbot/environment, so a saved connection can check it still reaches the same server.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { SERVER_ROOT } from "./proxy-paths.ts";

export interface EnvironmentDescriptor {
  environmentId: string;
  label: string;
  platform: NodeJS.Platform;
  version: string;
  capabilities: {
    /** Pairing and sessions are available (this build). */
    remoteSessions: true;
    /** Only while the maintainer flag `features.sharedComputers` is on; otherwise absent, like a build without the feature. */
    sharedComputers?: true;
    lendingDetails?: true;
    /** A Cloud home with lending on: a lent computer may open the device link and lend its internet connection. */
    deviceLink?: true;
    /** A personal Cloud home with lending on: a lent computer may lend its Chrome to the bots here. Never a team Cloud. */
    myChromeLink?: true;
    /** A lent computer may say it takes run_command's timeout_seconds; only then does this server send it. */
    commandTimeouts?: true;
    /** A person's own OMB Cloud home. */
    cloudHome?: true;
    /** A Cloud home that takes the one-time move from the person's computer: by-row chats, the manifest, the chats and
     * credentials checks, and lines its owner wrote there stamped as the owner's. */
    move?: 1;
    /** Who can update the server: the desktop app that runs it, or the operator. */
    selfUpdate: "desktop-managed" | "operator";
    /** Whether /pair offers "sign in with your email" (an allow-list is set). */
    emailSignIn?: boolean;
    /** GET /api/threads/:id/job answers, long-polled (the headless CLI needs it). */
    jobs: true;
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function readEnvironmentId(file: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw new Error(`Cannot read the existing environment identity at ${file}; refusing to replace it.`, {
      cause: error,
    });
  }

  const id = contents.trim();
  if (!UUID_PATTERN.test(id)) {
    throw new Error(`The existing environment identity at ${file} is not a valid UUID; refusing to replace it.`);
  }
  return id;
}

/** Read or create the id. Written once, never rotated by the server itself. */
export function loadEnvironmentId(dataDir: string): string {
  const file = join(dataDir, "environment-id");
  const existing = readEnvironmentId(file);
  if (existing) return existing;

  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const id = randomUUID();
  const temporaryFile = join(directory, `.environment-id.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;

  try {
    descriptor = openSync(temporaryFile, "wx", 0o600);
    writeFileSync(descriptor, id + "\n", "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    try {
      // A hard link publishes atomically without replacing, unlike rename, which overwrites on POSIX.
      linkSync(temporaryFile, file);
      return id;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const winner = readEnvironmentId(file);
      if (winner) return winner;
      throw new Error(`The environment identity at ${file} disappeared while it was being created.`);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryFile);
    } catch {
    }
  }
}

/** The desktop's own version, else the bundle's package.json (scripts/bundle-server.mjs), else the checkout's. */
export function serverVersion(root = SERVER_ROOT): string {
  const fromEnv = process.env.OMB_APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  for (const file of [join(root, "package.json"), join(root, "..", "package.json")]) {
    try {
      const version = Reflect.get(Object(JSON.parse(readFileSync(file, "utf8"))), "version");
      if (typeof version === "string" && version) return version;
    } catch {
    }
  }
  return "unknown";
}

export function environmentDescriptor(input: { environmentId: string; desktopManaged: boolean; emailSignIn?: boolean; sharedComputers?: boolean; cloudHome?: boolean; cloudTeam?: boolean; label?: string }): EnvironmentDescriptor {
  return {
    environmentId: input.environmentId,
    label: input.label?.trim() || process.env.OMB_ENVIRONMENT_LABEL?.trim() || hostname(),
    platform: process.platform,
    version: serverVersion(),
    capabilities: {
      remoteSessions: true,
      // Never advertise a protocol this server would refuse.
      // lendingDetails: a lent computer may say its platform, and this server remembers what was lent to it.
      ...(input.sharedComputers === true ? { sharedComputers: true as const, lendingDetails: true as const, commandTimeouts: true as const } : {}),
      ...(input.sharedComputers === true && input.cloudHome === true ? { deviceLink: true as const } : {}),
      ...(input.sharedComputers === true && input.cloudHome === true && input.cloudTeam !== true ? { myChromeLink: true as const } : {}),
      ...(input.cloudHome === true ? { cloudHome: true as const, move: 1 as const } : {}),
      selfUpdate: input.desktopManaged ? "desktop-managed" : "operator",
      emailSignIn: input.emailSignIn === true,
      jobs: true,
    },
  };
}
