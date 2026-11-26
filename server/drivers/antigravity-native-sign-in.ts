// The access token of the Google sign-in the native Antigravity CLI keeps, for the plan-usage report.
//
// Security: only the access token is taken, and it stays in memory and request headers: never logged, written or
// returned in a result. The stored sign-in also holds the refresh token; it is never used, and nothing here refreshes
// or rewrites the sign-in.
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
 * or it is stale. A file the CLI no longer writes is dead within the hour. */
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
