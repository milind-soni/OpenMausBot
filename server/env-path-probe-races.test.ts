import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";

const { probes } = vi.hoisted(() => ({ probes: [] as Array<(error: Error | null, stdout: string) => void> }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn((...args: unknown[]) => {
    probes.push(args.at(-1) as (error: Error | null, stdout: string) => void);
    return {};
  }),
}));

import { augmentedPath, findCliCandidates, registerPathDir, resetPathCache, resetPathCacheForTests } from "./env-path.ts";

const suite = describe.skipIf(process.platform === "win32");
suite("login-shell probe generations", () => {
  beforeEach(() => {
    resetPathCacheForTests();
    probes.length = 0;
    vi.stubEnv("VITEST", "");
    vi.stubEnv("OMB_TEST_SEALED_PATH", "0");
  });
  afterEach(() => { vi.unstubAllEnvs(); resetPathCacheForTests(); });
  const complete = (index: number, path: string) => probes[index]!(null, `rc noise\n__OMB_PATH__${path}\n`);

  it("keeps the latest rescan when an earlier shell finishes last", () => {
    const older = join(homedir(), "older-runtime");
    const newer = join(homedir(), "newer-runtime");
    for (const dir of [older, newer]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "fixture-runtime"), "fixture"); }
    augmentedPath();
    resetPathCache();
    augmentedPath();
    expect(probes).toHaveLength(2);
    complete(1, newer);
    complete(0, older);
    expect(augmentedPath().split(delimiter)).toContain(newer);
    expect(augmentedPath().split(delimiter)).not.toContain(older);
    expect(findCliCandidates("fixture-runtime")).toEqual([join(newer, "fixture-runtime")]);
  });

  it("keeps the last completed PATH when the newest probe fails and an obsolete one succeeds", () => {
    augmentedPath();
    complete(0, "/fixture/stable");
    resetPathCache();
    augmentedPath();
    resetPathCache();
    augmentedPath();
    probes[2]!(new Error("shell timed out"), "");
    complete(1, "/fixture/obsolete");
    expect(augmentedPath().split(delimiter)).toContain("/fixture/stable");
    expect(augmentedPath().split(delimiter)).not.toContain("/fixture/obsolete");
  });

  it("does not restore a shell PATH after an explicit cache reset before the next lookup", () => {
    augmentedPath();
    resetPathCache();
    complete(0, "/fixture/obsolete");
    expect(augmentedPath().split(delimiter)).not.toContain("/fixture/obsolete");
    expect(probes).toHaveLength(2);
  });

  it("accepts the current probe and keeps the prior value while rescanning", () => {
    augmentedPath();
    complete(0, "/fixture/stable");
    resetPathCache();
    expect(augmentedPath().split(delimiter)).toContain("/fixture/stable");
    complete(1, "/fixture/current");
    expect(augmentedPath().split(delimiter)).toContain("/fixture/current");
    expect(augmentedPath().split(delimiter)).not.toContain("/fixture/stable");
  });

  it("does not launch additional probes for ordinary cached reads", () => {
    augmentedPath(); augmentedPath(); augmentedPath();
    expect(probes).toHaveLength(1);
    complete(0, "/fixture/current");
    augmentedPath();
    expect(probes).toHaveLength(1);
  });

  it("invalidates a pending probe when registering an installed runtime", () => {
    augmentedPath();
    const dir = join(homedir(), "managed-runtime");
    mkdirSync(dir, { recursive: true });
    registerPathDir(dir);
    complete(0, "/fixture/obsolete");
    expect(augmentedPath().split(delimiter)[0]).toBe(dir);
    expect(augmentedPath().split(delimiter)).not.toContain("/fixture/obsolete");
  });
});
