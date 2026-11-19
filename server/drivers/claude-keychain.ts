import { execFile } from "node:child_process";
import { userInfo } from "node:os";

const KEYCHAIN_TIMEOUT_MS = 5_000;
const KEYCHAIN_MAX_BUFFER = 1_000_000;

/**
 * Claude Code saves its login under the macOS user name as the keychain account. An older login can remain under the
 * same service with another account ("unknown"), and `security` without `-a` returns whichever item it finds first.
 */
export function claudeKeychainQueries(service: string, user: string | null): string[][] {
  const any = ["find-generic-password", "-s", service, "-w"];
  return user ? [["find-generic-password", "-s", service, "-a", user, "-w"], any] : [any];
}

function securityPassword(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "security",
        args,
        { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: KEYCHAIN_MAX_BUFFER, windowsHide: true, shell: false, encoding: "utf8" },
        (error, stdout) => resolve(error || !stdout ? null : stdout),
      );
    } catch {
      resolve(null);
    }
  });
}

function currentUser(): string | null {
  try {
    return userInfo().username || null;
  } catch {
    return null;
  }
}

/** The first saved secret `usable` accepts, else the first one found, so an expired login still reads as expired. */
export async function readMacKeychainLogin(service: string, usable: (raw: string) => boolean): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  let fallback: string | null = null;
  for (const args of claudeKeychainQueries(service, currentUser())) {
    const raw = await securityPassword(args);
    if (raw && usable(raw)) return raw;
    fallback ??= raw;
  }
  return fallback;
}
