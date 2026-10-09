// The OMB Cloud home's secrets, and how the server gets them
// (docs/cloud-pro.md). This module imports nothing but node:fs, so the
// server can read them before anything else it loads can start a process
// (cloud-secrets-boot.ts, the server's first import).
import { closeSync, readFileSync } from "node:fs";

/** The Cloud home's secrets: the signing secret, the included services' relay
 * tokens and the trial's Claude credit token (server/included-services.ts). The
 * Admin sets them as Fly app
 * secrets, which reach the machine as the launcher's environment; the
 * launcher never puts them in a child's environment, because
 * /proc/<pid>/environ keeps a process's starting environment for anything
 * running as the same user to read. It hands them to the server over an
 * inherited pipe instead (CLOUD_SECRETS_FD_ENV names its descriptor). */
export const CLOUD_HOME_SECRET_KEYS = ["OMB_CLOUD_BOOTSTRAP_SECRET", "OMB_CLOUD_BOAT_TOKEN", "OMB_CLOUD_VOICE_TOKEN", "OMB_CLOUD_DECIDER_TOKEN", "OMB_CLOUD_AI_TOKEN"] as const;
export const CLOUD_SECRETS_FD_ENV = "OMB_CLOUD_SECRETS_FD";

/** The secrets present in an environment (the launcher's). */
export function cloudHomeSecrets(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(CLOUD_HOME_SECRET_KEYS.flatMap((key) => env[key] ? [[key, env[key]!]] : []));
}

/** An environment with no Cloud home secret in it. */
export function withoutCloudSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = { ...env };
  for (const key of CLOUD_HOME_SECRET_KEYS) delete kept[key];
  return kept;
}

function invalid(why: string): never {
  throw new Error(`Cloud home configuration is invalid: ${why}.`);
}

/** At server startup: the secrets the launcher handed over its pipe (read
 * to the end and closed, so no child inherits it), or none when the server
 * was started another way and reads its environment as before. Only the
 * known secret names are taken. */
export function takeCloudSecrets(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const named = env[CLOUD_SECRETS_FD_ENV];
  if (named === undefined) return {};
  delete env[CLOUD_SECRETS_FD_ENV];
  const fd = Number(named);
  if (!Number.isInteger(fd) || fd < 3 || fd > 1024) invalid(`${CLOUD_SECRETS_FD_ENV} must name an inherited descriptor`);
  let raw: string;
  try {
    raw = readFileSync(fd, "utf8");
  } catch {
    invalid("the Cloud home's secrets could not be read from the launcher");
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw!); } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("the Cloud home's secrets from the launcher are not readable");
  const record = parsed as Record<string, unknown>;
  return Object.fromEntries(CLOUD_HOME_SECRET_KEYS.flatMap((key) => typeof record[key] === "string" && record[key] ? [[key, record[key] as string]] : []));
}
