// The access token of the Google sign-in the native Antigravity CLI keeps, for the plan-usage report.
//
// Security: only the access token is taken, and it stays in memory and request headers: never logged, written or
// returned in a result. The stored sign-in also holds the refresh token; it is never used. This app never refreshes
// or rewrites the sign-in itself; a stale file may be woken by asking the CLI to refresh its own file.
import { readFile, stat } from "node:fs/promises";

import { antigravityProfileDirectory } from "./antigravity-acp.ts";
import { antigravityCliAccessToken } from "./antigravity-account.ts";
import { antigravityNativeTokenPath } from "./antigravity-native-status.ts";

// Antigravity CLI keeps one sign-in per computer in the OS keyring (on macOS the login keychain), unless it runs over
// SSH (1.5.14, 1.5.15) or with AGY_CLI_FORCE_FILE_TOKEN_STORAGE (1.5.16): then each profile's is the file in that
// profile. This app always starts it with both, so the profile's file is the account's sign-in, and the keychain is
// never read.
const STORED_MAX_BYTES = 1024 * 1024;

export interface NativeSignInStore {
  readText: (path: string) => Promise<string | null>;
}

async function readSmallFile(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size <= STORED_MAX_BYTES ? await readFile(path, "utf8") : null;
  } catch {
    return null;
  }
}

export const defaultNativeSignInStore = (): NativeSignInStore => ({ readText: readSmallFile });

/** The live access token of the sign-in the CLI keeps for this instance, in its profile's file; null when there is none
 * or it is stale. Call {@link ensureNativeAccessToken} to ask the CLI to refresh a stale file first. */
export async function readNativeAccessToken(instanceId: string, _env: NodeJS.ProcessEnv, now: number, store: NativeSignInStore = defaultNativeSignInStore()): Promise<string | null> {
  return nativeAccessToken(await store.readText(antigravityNativeTokenPath({ directory: antigravityProfileDirectory(instanceId) })), now);
}

/** The stored sign-in's access token while it has more than a minute left, else null. */
export function nativeAccessToken(stored: string | null, now: number): string | null {
  if (!stored) return null;
  try {
    return antigravityCliAccessToken(JSON.parse(stored), now)?.accessToken ?? null;
  } catch {
    return null;
  }
}

const WAKE_HOLD_MS = 60_000;
const wakeHolds = new Map<string, number>();
const waking = new Map<string, Promise<void>>();

/** True when the native CLI's sign-in file is still on disk, even if the access token has expired. */
export async function nativeSignInFilePresent(
  instanceId: string,
  store: NativeSignInStore = defaultNativeSignInStore(),
): Promise<boolean> {
  return (await store.readText(antigravityNativeTokenPath({ directory: antigravityProfileDirectory(instanceId) }))) != null;
}

export type NativeTokenWake = (instanceId: string, env: NodeJS.ProcessEnv) => Promise<void>;

/** Ask the native CLI to refresh its own sign-in file. This app never uses the stored refresh token. */
export async function wakeNativeCliSignIn(instanceId: string, env: NodeJS.ProcessEnv, cli?: string): Promise<void> {
  const { resolveAntigravityRuntime } = await import("./antigravity-runtime.ts");
  const { prepareAntigravityProfile } = await import("./antigravity-acp.ts");
  const { antigravityCliSignIn } = await import("./antigravity-native-status.ts");
  const runtime = await resolveAntigravityRuntime(cli, env);
  const profile = await prepareAntigravityProfile({ instanceId, runtime, baseEnv: env });
  const state = await antigravityCliSignIn(runtime, profile, { waitForExit: true });
  if (state !== "in") throw new Error("native CLI sign-in is not active");
}

/** A live access token, after asking the CLI to refresh its file when the token has expired but the file is still there.
 * A missing file is a sign-out and is left alone. Failed wakes are retried after a short hold. */
export async function ensureNativeAccessToken(
  instanceId: string,
  env: NodeJS.ProcessEnv,
  now: number,
  options: { store?: NativeSignInStore; wake?: NativeTokenWake; clock?: () => number } = {},
): Promise<string | null> {
  const store = options.store ?? defaultNativeSignInStore();
  const wake = options.wake ?? ((id, environment) => wakeNativeCliSignIn(id, environment));
  const clock = options.clock ?? Date.now;
  const token = await readNativeAccessToken(instanceId, env, now, store);
  if (token) return token;
  if (!await nativeSignInFilePresent(instanceId, store)) return null;
  const heldUntil = wakeHolds.get(instanceId);
  if (heldUntil !== undefined && now < heldUntil) return null;
  const pending = waking.get(instanceId);
  if (pending) {
    await pending.catch(() => undefined);
    return readNativeAccessToken(instanceId, env, now, store);
  }
  const work = wake(instanceId, env);
  waking.set(instanceId, work);
  // The `waking` entry must stay registered through the post-wake reread and hold decision: removing it as soon as
  // the wake settles leaves a window where a concurrent read sees no pending wake and no hold yet and starts a
  // duplicate wake for the same instance.
  try {
    await work;
    // The clock is read again after the wake finishes: `now` was captured before it, so a slow wake would otherwise
    // record a hold deadline that has already expired.
    const finishedAt = clock();
    const refreshed = await readNativeAccessToken(instanceId, env, finishedAt, store);
    if (!refreshed) holdWake(instanceId, finishedAt);
    else wakeHolds.delete(instanceId);
    return refreshed;
  } catch {
    holdWake(instanceId, clock());
    return null;
  } finally {
    waking.delete(instanceId);
  }
}

function holdWake(instanceId: string, now: number): void {
  wakeHolds.set(instanceId, now + WAKE_HOLD_MS);
  if (wakeHolds.size < 128) return;
  const oldest = wakeHolds.keys().next().value;
  if (oldest !== undefined) wakeHolds.delete(oldest);
}

export function clearNativeTokenWakeHolds(): void {
  wakeHolds.clear();
  waking.clear();
}

