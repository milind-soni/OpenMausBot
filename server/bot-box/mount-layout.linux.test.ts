import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { detectBox } from "./detect.ts";

const detection = detectBox({ env: { ...process.env, OMB_BOT_BOX: "1" } });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function layout(scenario: string): unknown {
  const root = mkdtempSync(join(tmpdir(), "omb-mount-layout-"));
  roots.push(root);
  for (const path of ["var-lib", "srv", "home/fixture"]) mkdirSync(join(root, path), { recursive: true });
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const fixture = fileURLToPath(new URL("../testing/bot-box-mount-fixture.ts", import.meta.url));
  const result = spawnSync(detection.tools!.bwrap, [
    "--unshare-user", "--unshare-pid", "--unshare-net", "--die-with-parent",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64", "--ro-bind", "/etc", "/etc", "--proc", "/proc", "--dev", "/dev",
    "--tmpfs", "/tmp", "--tmpfs", "/run", "--bind", join(root, "var-lib"), "/var/lib",
    "--bind", join(root, "srv"), "/srv", "--bind", join(root, "home"), "/home",
    "--ro-bind", repo, repo, "--ro-bind", dirname(dirname(process.execPath)), dirname(dirname(process.execPath)),
    "--setenv", "HOME", "/home/fixture", "--setenv", "OMB_DATA_DIR", "/var/lib/openmausbot",
    "--chdir", repo, "--", process.execPath, "--experimental-strip-types", fixture, scenario,
  ], { encoding: "utf8", timeout: 20_000 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim());
}

describe.skipIf(detection.box !== "bwrap")("synthetic filesystem layouts inside real bubblewrap", () => {
  it("keeps browser data hidden below /var/lib while restoring only its uploads", () => {
    expect(layout("browser")).toEqual(["hidden", "hidden", "upload fixture"]);
  });

  it("hides data through its symlink and real path while preserving the turn's workspace", () => {
    expect(layout("symlink")).toEqual({ botId: "bot-a", files: ["hidden", "hidden", "task fixture", "memory fixture"] });
    expect(layout("symlink-home")).toEqual({ botId: "bot-a", files: ["hidden", "hidden", "task fixture", "memory fixture"] });
  });

  it("restores explicitly read-only paths below a data mask for engines and browsers", () => {
    expect(layout("read-only")).toEqual(["skill fixture", "read-only", "hidden"]);
    expect(layout("browser-read-only")).toEqual(["hidden", "hidden", "upload fixture"]);
  });

  it.each(["symlink-read-only", "symlink-home-read-only"])("restores read-only skills at both their alias and canonical paths (%s)", (scenario) => {
    const files = ["skill fixture", "read-only", "skill fixture", "read-only", "hidden", "hidden"];
    expect(layout(scenario)).toEqual([files, files, files, files]);
  });

  it.each(["hostile-env-data", "hostile-env-bot", "hostile-rw-data", "hostile-rw-bot"])("keeps writable aliases from exposing masked data (%s)", (scenario) => {
    expect(layout(scenario)).toEqual({
      files: ["hidden", "hidden", "hidden"],
      hostFiles: ["private fixture", "other bot fixture"],
      created: [false, false],
    });
  });

  it.each(["home", "outside", "task"].flatMap((location) => ["data", "bot", "thread", "ancestor"].map((target) => `hostile-cwd-${location}-${target}`)))("refuses a cwd alias into protected data (%s)", (scenario) => {
    expect(layout(scenario)).toEqual({ error: "The bot box refuses a working folder that aliases protected bot box data." });
  });

  it.each(["env", "rw", "ro", "argv"])("keeps a ..x child of the data directory hidden through an external %s alias", (grant) => {
    expect(layout(`dotdot-alias-${grant}`)).toEqual({ files: ["hidden", "hidden"], hostFile: "private fixture" });
  });

  it("allows HOME as cwd while keeping its data directory masked", () => {
    expect(layout("home-cwd")).toEqual(["hidden", "writable"]);
  });

  it.each(["env", "rw"].flatMap((grant) => ["data", "bot", "ancestor"].map((target) => `hostile-outside-${grant}-${target}`)))("refuses writable aliases outside HOME into masked data (%s)", (scenario) => {
    expect(layout(scenario)).toEqual({
      files: ["hidden", "hidden", "hidden"],
      hostFiles: ["private fixture", "other bot fixture"],
      created: [false, false],
    });
  });

  it.each(["ro", "argv"].flatMap((grant) => ["data", "bot"].map((target) => `readonly-alias-${grant}-${target}`)))("refuses a read-only HOME alias that widens the approved subtree (%s)", (scenario) => {
    expect(layout(scenario)).toEqual(["hidden", "hidden", "hidden"]);
  });

  it("keeps private temporary files hidden when an environment path aliases /tmp", () => {
    expect(layout("symlink-private-env")).toEqual(["hidden"]);
  });

  it("restores HOME below the data directory and refuses HOME equal to all data", () => {
    expect(layout("home")).toEqual([
      { files: ["settings fixture", "writable", "hidden"] },
      { error: expect.stringMatching(/HOME.*data directory/) },
      { error: expect.stringMatching(/HOME.*data directory/) },
      ["hidden"],
    ]);
  });
});
