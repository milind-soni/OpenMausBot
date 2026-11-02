import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { detectBox } from "./detect.ts";

const detection = detectBox({ env: { ...process.env, OMB_BOT_BOX: "1" } });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture(engine: string, location: string, fallback = false, tempInHome = false, aliasedHome = false): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "omb-driver-paths-"));
  roots.push(root);
  for (const path of ["home", "var-lib"]) mkdirSync(join(root, path));
  const home = aliasedHome ? "/alias-home" : "/home/fixture", data = location === "home" ? `${home}/data` : "/var/lib/data";
  if (aliasedHome) {
    mkdirSync(join(root, "home", "scratch"));
    symlinkSync("scratch", join(root, "home", "tmp"));
  }
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const child = spawn(detection.tools!.bwrap, [
    "--unshare-user", "--unshare-pid", "--unshare-net", "--die-with-parent",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64", "--ro-bind", "/etc", "/etc", "--proc", "/proc", "--dev", "/dev",
    "--tmpfs", "/tmp", "--tmpfs", "/run", "--bind", join(root, "var-lib"), "/var/lib", "--bind", join(root, "home"), aliasedHome ? "/real-home" : home,
    ...(aliasedHome ? ["--symlink", "/real-home", home] : []),
    "--ro-bind", repo, repo, "--ro-bind", dirname(dirname(process.execPath)), dirname(dirname(process.execPath)),
    "--chdir", repo, "--", process.execPath, "--experimental-strip-types", fileURLToPath(new URL("../testing/boxed-turn-fixture.ts", import.meta.url)), engine, String(fallback),
  ], {
    env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: tempInHome ? `${home}/tmp` : "/tmp", OMB_DATA_DIR: data, OMB_BOT_BOX: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    expect(status, stderr).toBe(0);
    return JSON.parse(stdout.trim());
  } finally { clearTimeout(timer); }
}

describe.skipIf(detection.box !== "bwrap")("boxed driver paths in real bubblewrap", () => {
  it.each(["home", "outside"])("keeps Claude's fallback socket read-only through relative TMPDIR below an aliased HOME (%s)", async (location) => {
    const result = await fixture("claude", location, true, true, true);
    expect(result.asks, JSON.stringify(result)).toBe(2);
    expect(result.socket).toContain("/alias-home/tmp/omb-perm-");
    expect(result.probes).toMatchObject([
      { permission: "allow", socketChmodError: "EROFS" },
      { permission: "allow", socketChmodError: "EROFS" },
    ]);
  }, 25_000);

  it.each(["home", "outside"].flatMap((location) => [false, true].map((fallback) => ({ location, fallback }))))(
    "routes Claude permissions through the selected socket (%j)", async ({ location, fallback }) => {
      const result = await fixture("claude", location, fallback);
      expect(result.asks, JSON.stringify(result)).toBe(2);
      expect(result.probes).toMatchObject([
        { permission: "allow", token: "hook-fixture", tokenWritable: false, socketChmodError: "EROFS", hidden: true, otherTokenHidden: true },
        { permission: "allow", token: "hook-fixture-next", tokenWritable: false, socketChmodError: "EROFS", hidden: true, otherTokenHidden: true },
      ]);
      expect(result.probes[0].pid).toBe(result.probes[1].pid);
      expect(result.socket).toContain(fallback ? "/omb-perm-" : "/data/perm-");
    }, 25_000,
  );

  it.each(["home", "outside"])("keeps Claude's fallback socket read-only under a writable HOME temp dir (%s)", async (location) => {
    const result = await fixture("claude", location, true, true);
    expect(result.asks, JSON.stringify(result)).toBe(2);
    expect(result.socket).toContain("/home/fixture/tmp/omb-perm-");
    expect(result.probes).toMatchObject([
      { permission: "allow", socketChmodError: "EROFS" },
      { permission: "allow", socketChmodError: "EROFS" },
    ]);
  }, 25_000);

  it.each(["home", "outside"])("keeps Pi's explicit MCP config read-only under a writable HOME temp dir (%s)", async (location) => {
    const result = await fixture("pi", location, false, true);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.probes).toMatchObject([{ config: true, configWriteError: "EROFS", configUnchanged: true }]);
  }, 25_000);

  it.each(["home", "outside"])("reads Pi's MCP config and returns its scope receipt (%s)", async (location) => {
    const result = await fixture("pi", location);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.probe).toMatchObject({ config: true, hidden: true });
  }, 25_000);
});
