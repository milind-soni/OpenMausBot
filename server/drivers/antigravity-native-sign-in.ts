// The access token of the Google sign-in the native Antigravity CLI keeps, for the plan-usage report.
//
// Security: only the access token is taken, and it stays in memory and request headers: never logged, written or
// returned in a result. The stored sign-in also holds the refresh token; it is never used, and nothing here refreshes
// or rewrites the sign-in.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";

import { sealedFixture } from "../env-path.ts";
import { antigravityProfileDirectory } from "./antigravity-acp.ts";
import { antigravityNativeTokenPath } from "./antigravity-native-status.ts";

// Antigravity CLI 1.5.14 stores its sign-in with go-keyring: on macOS in the login keychain item below, and in the file
// in its profile when the keychain is missing or a write to it failed (the keychain then keeps an older copy); off macOS
// the file is its store without a keyring. Both hold the same JSON; the keychain's is prefixed and base64-encoded.
const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_ACCOUNT = "antigravity";
const KEYRING_BASE64 = "go-keyring-base64:";
const SECURITY = "/usr/bin/security";
const KEYCHAIN_TIMEOUT_MS = 5_000;
const STORED_MAX_BYTES = 1024 * 1024;
const EXPIRY_MARGIN_MS = 60_000;

export interface NativeSignInStore {
  /** Runs `security` with the CLI's environment; null where the CLI keeps no sign-in in a keychain. */
  security: ((args: string[], env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; stdout: string }>) | null;
  readText: (path: string) => Promise<string | null>;
}

function runSecurity(args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      SECURITY,
      args,
      { env, timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: STORED_MAX_BYTES, windowsHide: true, shell: false, encoding: "utf8" },
      (error, stdout) => resolve({ ok: !error, stdout: stdout ?? "" }),
    );
  });
}

async function readSmallFile(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size <= STORED_MAX_BYTES ? await readFile(path, "utf8") : null;
  } catch {
    return null;
  }
}

export function defaultNativeSignInStore(platform: NodeJS.Platform = process.platform): NativeSignInStore {
  return { security: platform === "darwin" && !sealedFixture() ? runSecurity : null, readText: readSmallFile };
}

/** The live access token of the sign-in the CLI run with `env` keeps for this instance: the keychain's while it is live,
 * else the profile file's; null when neither has one. A file the CLI no longer writes is dead within the hour. Under SSH
 * the CLI keeps its sign-in in the profile file and never the keychain (1.5.14), so only the file is read. */
export async function readNativeAccessToken(instanceId: string, env: NodeJS.ProcessEnv, now: number, store: NativeSignInStore = defaultNativeSignInStore()): Promise<string | null> {
  const file = async () => nativeAccessToken(await store.readText(antigravityNativeTokenPath({ directory: antigravityProfileDirectory(instanceId) })), now);
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return file();
  const item = await store.security?.(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"], env);
  return (item?.ok ? nativeAccessToken(item.stdout, now) : null) ?? file();
}

function decodeStored(raw: string): string {
  const trimmed = raw.trim();
  // macOS 26 `security -w` may print the secret as hex.
  const text = /^(?:[0-9a-f]{2})+$/iu.test(trimmed) ? Buffer.from(trimmed, "hex").toString("utf8") : trimmed;
  return text.startsWith(KEYRING_BASE64) ? Buffer.from(text.slice(KEYRING_BASE64.length), "base64").toString("utf8") : text;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The stored sign-in's access token while it has more than a minute left, else null. */
export function nativeAccessToken(stored: string | null, now: number): string | null {
  if (!stored) return null;
  let token: Record<string, unknown> | null;
  try {
    token = record(record(JSON.parse(decodeStored(stored)))?.token);
  } catch {
    return null;
  }
  const accessToken = token?.access_token;
  const expiry = typeof token?.expiry === "string" ? Date.parse(token.expiry) : Number.NaN;
  if (typeof accessToken !== "string" || !accessToken || !Number.isFinite(expiry)) return null;
  return expiry > now + EXPIRY_MARGIN_MS ? accessToken : null;
}
