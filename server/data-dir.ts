import { mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

let home: string | undefined;

/** The home the data folder lives under. Under vitest, with HOME still the real one, a temp folder instead, so a test
 * never reads, migrates or deletes the person's own data. */
export function dataHome(): string {
  if (home !== undefined) return home;
  const real = homedir();
  home = process.env.VITEST !== undefined && real === userInfo().homedir ? mkdtempSync(join(tmpdir(), "omb-test-home-")) : real;
  return home;
}

type Env = Record<string, string | undefined>;

/** What marks this process as a test or a benchmark, if anything does. */
export function testRunSignal(env: Env): string | null {
  if (env.VITEST !== undefined) return "VITEST";
  if (env.NODE_ENV === "test") return "NODE_ENV=test";
  return env.OMB_BENCH === "1" ? "OMB_BENCH=1" : null;
}

function canonical(path: string): string {
  let real = resolve(path);
  try { real = realpathSync(real); } catch {}
  // macOS and Windows file systems fold case by default.
  return process.platform === "linux" ? real : real.toLowerCase();
}

/** The account's own home whatever HOME says; null where the account has no entry (some containers). */
function accountHome(): string | null {
  try { return userInfo().homedir; } catch { return null; }
}

/**
 * The data folder: OMB_DATA_DIR, else `.openmausbot` under the home.
 * Security: a test or benchmark run (testRunSignal) with no OMB_DATA_DIR never gets the person's own data folder. It
 * throws instead, since the folder is fixed when server/config.ts is first imported and a later assignment is ignored.
 */
export function defaultDataDir(env: Env = process.env, under: () => string = dataHome, realHome: () => string | null = accountHome): string {
  if (env.OMB_DATA_DIR) return env.OMB_DATA_DIR;
  const base = under();
  const signal = testRunSignal(env);
  if (signal) {
    const real = realHome();
    if (real && canonical(base) === canonical(real)) {
      throw new Error(`${signal} marks this as a test or benchmark run, and OMB_DATA_DIR is not set: refusing to use the real data folder ${join(base, ".openmausbot")}. Set OMB_DATA_DIR to a temp folder in the environment before the process starts; setting it inside the script is too late.`);
    }
  }
  return join(base, ".openmausbot");
}
