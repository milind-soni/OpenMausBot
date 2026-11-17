import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalVmTarget } from "./container-computer.ts";

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFile: exec }));
import { rescueInstalledApps } from "./local-vm-profiles.ts";

let root: string, copied: string, durable: string, target: LocalVmTarget;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omb-app-compare-"));
  copied = join(root, "old-apps");
  const workspaceDir = join(root, "workspace");
  durable = join(workspaceDir, ".desktop-apps", "local");
  await mkdir(copied, { recursive: true });
  await mkdir(durable, { recursive: true });
  target = { key: "bot:fixture", containerName: "fixture", workspaceDir, viewerPort: null, label: "fixture" };
  exec.mockReset().mockImplementation((command, args, _options, callback) => {
    if (command !== "fixture-runtime") {
      callback(Object.assign(new Error("executable is unavailable on this host"), { code: "ENOENT" }));
    } else {
      void cp(copied, args.at(-1), { recursive: true, verbatimSymlinks: true }).then(() => callback(null, { stdout: "", stderr: "" }), callback);
    }
    return {};
  });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const both = async (name: string, content: string | Buffer) => {
  for (const dir of [copied, durable]) await writeFile(join(dir, name), content);
};

describe("installed-app comparison on hosts without Unix diff", () => {
  it("keeps identical nested applications, including files larger than a comparison buffer", async () => {
    for (const dir of [copied, durable]) await mkdir(join(dir, "empty"));
    const content = Buffer.alloc(192 * 1024 + 1, 17);
    content[content.length - 1] = 23;
    await both("application.bin", content);
    expect(await rescueInstalledApps("fixture-runtime", target)).toBe("kept");
    expect(await readFile(join(durable, "application.bin"))).toEqual(content);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(await readdir(target.workspaceDir)).toEqual([".desktop-apps"]);
  });

  it.each([0, 192 * 1024])("refuses a same-size file differing at byte %i without changing the durable copy", async (offset) => {
    const content = Buffer.alloc(192 * 1024 + 1, 17);
    await both("application.bin", content);
    const changed = Buffer.from(content);
    changed[offset] = 23;
    await writeFile(join(copied, "application.bin"), changed);
    await expect(rescueInstalledApps("fixture-runtime", target)).rejects.toThrow(/durable app area differs/);
    expect(await readFile(join(durable, "application.bin"))).toEqual(content);
    expect(await readdir(target.workspaceDir)).toEqual([".desktop-apps"]);
  });

  it("does not discard a missing empty application directory", async () => {
    await both("app", "same");
    await mkdir(join(copied, "missing-empty-directory"));
    await expect(rescueInstalledApps("fixture-runtime", target)).rejects.toThrow(/durable app area differs/);
  });

  it("refuses a directory that would replace an existing file", async () => {
    await mkdir(join(copied, "app"));
    await writeFile(join(durable, "app"), "keep");
    await expect(rescueInstalledApps("fixture-runtime", target)).rejects.toThrow(/durable app area differs/);
    expect(await readFile(join(durable, "app"), "utf8")).toBe("keep");
  });

  it.skipIf(process.platform === "win32")("compares identical symlinks by their target without following them", async () => {
    for (const dir of [copied, durable]) await symlink("missing-app-target", join(dir, "app-link"));
    expect(await rescueInstalledApps("fixture-runtime", target)).toBe("kept");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === "win32")("refuses different symlink targets even when both target files contain the same bytes", async () => {
    await both("a", "same");
    await both("b", "same");
    await symlink("a", join(copied, "app-link"));
    await symlink("b", join(durable, "app-link"));
    await expect(rescueInstalledApps("fixture-runtime", target)).rejects.toThrow(/durable app area differs/);
  });
});
