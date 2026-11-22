import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseArgs } from "./cli.ts";
import { parseConfigArgs } from "./config-cli.ts";
import type { DataHomes } from "./data-dir.ts";
import { parseSentinelArgs } from "./sentinel/cli.ts";
import { serverCommand } from "./server-launcher.ts";
import { handoffDir } from "./turn-continuation.ts";

const REAL = join("/fake-account", "person");
const ELSEWHERE = join("/fake-temp", "omb-test-home-1");
const PROFILE = join(REAL, ".openmausbot-profiles", "work");
const homes = (under: string): DataHomes => ({ under: () => under, realHome: () => REAL });
type Env = Record<string, string | undefined>;

const dataDirOf = (result: { dataDir: string } | { error: string }): string => {
  if ("error" in result) throw new Error(result.error);
  return result.dataDir;
};

const ENTRY_POINTS: Array<[string, (env: Env, home: string) => string, ((env: Env, home: string, given: string) => string) | null]> = [
  ["openmausbot", (env, home) => dataDirOf(parseArgs(["status"], env, homes(home))), (env, home, given) => dataDirOf(parseArgs(["status", "--data-dir", given], env, homes(home)))],
  ["openmausbot config", (env, home) => dataDirOf(parseConfigArgs(["backups"], env, homes(home))), (env, home, given) => dataDirOf(parseConfigArgs(["backups", "--data-dir", given], env, homes(home)))],
  ["openmausbot sentinel", (env, home) => dataDirOf(parseSentinelArgs(["--out", ELSEWHERE], env, homes(home))),
    (env, home, given) => dataDirOf(parseSentinelArgs(["--out", ELSEWHERE, "--data-dir", given], env, homes(home)))],
  ["the container launcher", (env, home) => dirOfCache(serverCommand("/app", env, { exists: () => true, box: { bytes: 4 * 1024 ** 3, cgroupLimit: null }, homes: homes(home) }).env), null],
  ["turn handoffs", (env, home) => resolve(handoffDir(env, homes(home)), ".."), null],
];
const dirOfCache = (env: Env) => resolve(env.OMB_SERVER_COMPILE_CACHE!, "..", "..");

describe.each(ENTRY_POINTS)("%s's data folder", (_name, resolvedAs, flagged) => {
  const resolved = (env: Env, home: string) => resolve(resolvedAs(env, home));
  it("is .openmausbot under the home in a normal run, and OMB_DATA_DIR (a desktop profile's folder) as given", () => {
    expect(resolved({}, REAL)).toBe(resolve(REAL, ".openmausbot"));
    expect(resolved({ NODE_ENV: "production" }, REAL)).toBe(resolve(REAL, ".openmausbot"));
    expect(resolved({ OMB_DATA_DIR: PROFILE }, REAL)).toBe(resolve(PROFILE));
  });

  it.each([{ VITEST: "true" }, { NODE_ENV: "test" }, { OMB_BENCH: "1" }])("refuses the real home's folder in a test or benchmark run: %o", (env) => {
    expect(() => resolved(env, REAL)).toThrow(/OMB_DATA_DIR is not set.*refusing to use the real data folder/);
    expect(resolved({ ...env, OMB_DATA_DIR: PROFILE }, REAL)).toBe(resolve(PROFILE));
    expect(resolved(env, ELSEWHERE)).toBe(resolve(ELSEWHERE, ".openmausbot"));
  });

  it.skipIf(!flagged)("takes --data-dir in a test run without looking at the home", () => {
    const given = join(ELSEWHERE, "data");
    expect(flagged!({ NODE_ENV: "test" }, REAL, given)).toBe(resolve(given));
  });
});
