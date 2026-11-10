import { chmodSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { augmentedPath, findCliCandidates, registerPathDir, resetPathCacheForTests } from "../env-path.ts";
import { execCli, spawnCli } from "../procs.ts";
import { BoxRunner } from "./box.ts";
import { distrustHomePrograms, serverMayRunFrom, serverPath } from "./program-trust.ts";

const posix = process.platform !== "win32";

function plant(dir: string, name: string, marker: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "$0" >> "${marker}"\necho 9.9.9\n`);
  chmodSync(file, 0o755);
  return file;
}

function run(cli: string, env: NodeJS.ProcessEnv): Promise<{ error: (Error & { code?: unknown }) | null; stdout: string }> {
  return new Promise((resolve) => execCli(cli, ["--version"], { env, timeout: 10_000 }, (error, stdout) => resolve({ error, stdout })));
}

afterEach(() => {
  distrustHomePrograms(null);
  resetPathCacheForTests();
});

describe("programs a boxed bot could have written", () => {
  it("are trusted everywhere while the box is off", () => {
    expect(serverMayRunFrom("/data/.local/bin")).toBe(true);
    expect(serverPath("/usr/bin:/data/.local/bin")).toBe("/usr/bin:/data/.local/bin");
  });

  it("while the box is on: nothing under HOME but the data folder, and no relative folder", () => {
    distrustHomePrograms("/data", ["/data/.openmausbot"], ["/data/.openmausbot/workspaces", "/srv/omb/task-workspaces"]);
    expect(serverMayRunFrom("/data/.openmausbot/workspaces/b1/tool")).toBe(false);
    expect(serverMayRunFrom("/srv/omb/task-workspaces/b1/t1/tool")).toBe(false);
    expect(serverMayRunFrom("/data/.local/bin")).toBe(false);
    expect(serverMayRunFrom("/data/.local/bin/pi")).toBe(false);
    expect(serverMayRunFrom("/data")).toBe(false);
    expect(serverMayRunFrom("/data/.openmausbot/tools/npm/bin")).toBe(true);
    expect(serverMayRunFrom("/database/bin")).toBe(true);
    expect(serverMayRunFrom("/usr/local/bin")).toBe(true);
    expect(serverMayRunFrom("bin")).toBe(false);
    expect(serverPath(["/data/.openmausbot/tools/npm/bin", "/usr/local/bin", "/data/.local/bin", "", ".", "/usr/bin", "/data/bin"].join(delimiter)))
      .toBe(["/data/.openmausbot/tools/npm/bin", "/usr/local/bin", "/usr/bin"].join(delimiter));
  });

  it.skipIf(!posix)("the server's PATH keeps the app's own engines and the system's, never HOME's program folders", () => {
    const home = homedir();
    const dataDir = join(home, ".openmausbot");
    const marker = join(home, "ran");
    plant(join(home, ".local", "bin"), "omb-planted-engine", marker);
    plant(join(home, ".opencode", "bin"), "omb-planted-engine-2", marker);
    const appBin = join(dataDir, "tools", "npm", "bin");
    plant(appBin, "omb-app-engine", marker);
    registerPathDir(appBin);
    expect(findCliCandidates("omb-planted-engine")).toHaveLength(1);

    distrustHomePrograms(home, [dataDir]);
    resetPathCacheForTests();
    registerPathDir(appBin);
    const parts = augmentedPath().split(delimiter);
    expect(parts).toContain(appBin);
    expect(parts.some((dir) => dir === join(home, ".local", "bin") || dir === join(home, ".opencode", "bin"))).toBe(false);
    expect(findCliCandidates("omb-planted-engine")).toEqual([]);
    expect(findCliCandidates("omb-planted-engine-2")).toEqual([]);
    expect(findCliCandidates("omb-app-engine")).toEqual([join(appBin, "omb-app-engine")]);
  });

  it.skipIf(!posix)("an unboxed spawn neither finds a program in HOME on the PATH it is given nor starts one by its path", async () => {
    const home = homedir();
    const dataDir = join(home, ".openmausbot");
    const marker = join(home, "ran-spawn");
    rmSync(marker, { force: true });
    const planted = plant(join(home, ".local", "bin"), "omb-planted-cli", marker);
    const appCli = plant(join(dataDir, "tools", "npm", "bin"), "omb-app-cli", marker);
    const linked = join(dataDir, "tools", "npm", "bin", "omb-linked-cli");
    rmSync(linked, { force: true });
    (await import("node:fs")).symlinkSync(planted, linked);
    const env = { ...process.env, PATH: [join(home, ".local", "bin"), join(dataDir, "tools", "npm", "bin"), "/usr/bin", "/bin"].join(delimiter) };
    distrustHomePrograms(home, [dataDir]);

    const byName = await run("omb-planted-cli", env);
    expect((byName.error as NodeJS.ErrnoException | null)?.code).toBe("ENOENT");
    const byPath = await run(planted, env);
    expect((byPath.error as NodeJS.ErrnoException | null)?.code).toBe("EACCES");
    const byLink = await run(linked, env);
    expect((byLink.error as NodeJS.ErrnoException | null)?.code).toBe("EACCES");
    expect(() => spawnCli(planted, ["--version"], { env, stdio: ["pipe", "pipe", "pipe"] })).toThrow(/bots can write/);
    expect(existsSync(marker)).toBe(false);

    const app = await run("omb-app-cli", env);
    expect(app.error).toBeNull();
    expect(app.stdout.trim()).toBe("9.9.9");
    expect(readFileSync(marker, "utf8").trim()).toBe(appCli);

    distrustHomePrograms(null);
    const before = await run("omb-planted-cli", env);
    expect(before.error).toBeNull();
  });

  it.skipIf(!posix)("a boxed process keeps HOME's program folders on its own PATH, after the server's", () => {
    const home = homedir();
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const runner = new BoxRunner({
      bwrap: "/usr/bin/bwrap", bridge: { socat: null, bridgeScript: "/x/bridge.js", node: "/usr/bin/node" },
      setup: { dataDir: join(home, ".openmausbot"), home, codeRoots: [], engineRoots: [], bridges: [] }, denyEnv: new Set(),
    });
    distrustHomePrograms(home, [join(home, ".openmausbot")]);
    const wrapped = runner.wrap({ command: "/usr/bin/true", args: [], env: { PATH: "/usr/bin:/bin", HOME: home }, net: "shared" });
    const path = wrapped.env.PATH!.split(delimiter);
    expect(path.slice(0, 2)).toEqual(["/usr/bin", "/bin"]);
    expect(path).toContain(join(home, ".local", "bin"));
  });
});
