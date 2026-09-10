// What a client learns about this server before it authenticates: a stable
// identity, a label, the version, and what it can do. Served without auth at
// /.well-known/openmausbot/environment so a saved connection can check it is
// still talking to the same server, and so version skew is visible.
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
    /** Who can update the server: the desktop app that runs it, or the operator. */
    selfUpdate: "desktop-managed" | "operator";
    /** Whether /pair offers "sign in with your email" (an allow-list is set). */
    emailSignIn?: boolean;
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
      // The temporary file is complete before it becomes visible at the final
      // path. A hard link is an atomic, no-replace publish on every supported
      // desktop platform, unlike rename (which overwrites on POSIX).
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
      // A leftover private temporary file is harmless and must not make a
      // successfully published identity unusable.
    }
  }
}

/** The desktop app passes its own version; a checkout reads package.json;
 * an image sets OMB_APP_VERSION at build time. */
export function serverVersion(): string {
  const fromEnv = process.env.OMB_APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(SERVER_ROOT, "..", "package.json"), "utf8"));
    const version = Reflect.get(Object(pkg), "version");
    if (typeof version === "string" && version) return version;
  } catch {
    /* no package.json next to the bundle */
  }
  return "unknown";
}

export function environmentDescriptor(input: { environmentId: string; desktopManaged: boolean; emailSignIn?: boolean }): EnvironmentDescriptor {
  return {
    environmentId: input.environmentId,
    label: process.env.OMB_ENVIRONMENT_LABEL?.trim() || hostname(),
    platform: process.platform,
    version: serverVersion(),
    capabilities: {
      remoteSessions: true,
      selfUpdate: input.desktopManaged ? "desktop-managed" : "operator",
      emailSignIn: input.emailSignIn === true,
    },
  };
}
