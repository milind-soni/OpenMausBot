import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import afterPack from "./after-pack.mjs";
import { LICENSE_FILES } from "./cua-linux-release.mjs";

const temporaryDirectories = [];

function fixture() {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-after-pack-"));
  temporaryDirectories.push(appOutDir);
  const resources = path.join(appOutDir, "resources");
  const cua = path.join(resources, "cua-linux-x64");
  const licenses = path.join(cua, "licenses");
  fs.mkdirSync(licenses, { recursive: true, mode: 0o775 });
  for (const directory of [appOutDir, resources, cua, licenses]) fs.chmodSync(directory, 0o775);
  for (const name of ["cua-driver", "cua-cursor-theme", "release.json"]) {
    fs.writeFileSync(path.join(cua, name), "fixture", { mode: 0o664 });
    fs.chmodSync(path.join(cua, name), 0o664);
  }
  for (const name of LICENSE_FILES) {
    fs.writeFileSync(path.join(licenses, name), "fixture", { mode: 0o664 });
    fs.chmodSync(path.join(licenses, name), 0o664);
  }
  return { appOutDir, resources, cua, licenses };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("Linux afterPack permissions", () => {
  it("repairs every packaged CUA ancestor and resource mode", async () => {
    const { appOutDir, resources, cua, licenses } = fixture();

    await afterPack({ electronPlatformName: "linux", appOutDir });

    for (const directory of [appOutDir, resources, cua, licenses]) {
      expect(fs.lstatSync(directory).mode & 0o777).toBe(0o755);
    }
    for (const name of ["cua-driver", "cua-cursor-theme"]) {
      expect(fs.lstatSync(path.join(cua, name)).mode & 0o777).toBe(0o755);
    }
    expect(fs.lstatSync(path.join(cua, "release.json")).mode & 0o777).toBe(0o644);
    for (const name of fs.readdirSync(licenses)) {
      expect(fs.lstatSync(path.join(licenses, name)).mode & 0o777).toBe(0o644);
    }
  });

  it("fails closed when the runtime root is replaced by a symlink", async () => {
    const { appOutDir, cua } = fixture();
    const replacement = path.join(appOutDir, "replacement");
    fs.mkdirSync(replacement);
    fs.rmSync(cua, { recursive: true });
    fs.symlinkSync(replacement, cua, "dir");
    await expect(afterPack({ electronPlatformName: "linux", appOutDir })).rejects.toThrow(
      "must be a real directory",
    );
  });

  it("fails closed when the release manifest is missing", async () => {
    const { appOutDir, cua } = fixture();
    fs.unlinkSync(path.join(cua, "release.json"));
    await expect(afterPack({ electronPlatformName: "linux", appOutDir })).rejects.toThrow();
  });

  it("leaves non-Linux package modes unchanged", async () => {
    const { appOutDir, cua } = fixture();
    await afterPack({ electronPlatformName: "darwin", appOutDir });
    expect(fs.lstatSync(cua).mode & 0o777).toBe(0o775);
    expect(fs.lstatSync(path.join(cua, "cua-driver")).mode & 0o777).toBe(0o664);
  });
});

describe("desktop browser package gate", () => {
  it("rejects a missing browser manifest instead of accepting partial resources", async () => {
    const { appOutDir, resources } = fixture();
    fs.mkdirSync(path.join(resources, "browser-engine"));
    await expect(afterPack({ electronPlatformName: "win32", arch: 1, appOutDir }))
      .rejects.toThrow(/manifest\.json/);
  });

  it("rejects an unsupported package architecture before accepting the browser", async () => {
    const { appOutDir, resources } = fixture();
    fs.mkdirSync(path.join(resources, "browser-engine"));
    await expect(afterPack({ electronPlatformName: "win32", arch: 0, appOutDir }))
      .rejects.toThrow(/Unsupported desktop browser package architecture/);
  });
});

// Real Mach-O fixtures: /usr/bin binaries are arm64e, not arm64, so compile.
const canBuildMachO = process.platform === "darwin" && fs.existsSync("/usr/bin/lipo") &&
  spawnSync("cc", ["--version"]).status === 0;

describe.skipIf(!canBuildMachO)("macOS afterPack platform-tools slices", () => {
  const binaries = {};
  let directory;
  const archs = (file) => execFileSync("/usr/bin/lipo", ["-archs", file], { encoding: "utf8" }).trim();

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "omb-macho-"));
    fs.writeFileSync(path.join(directory, "main.c"), "int main(void) { return 0; }\n");
    for (const arch of ["arm64", "x86_64"]) {
      binaries[arch] = path.join(directory, arch);
      execFileSync("cc", ["-arch", arch, "-o", binaries[arch], path.join(directory, "main.c")]);
    }
    binaries.fat = path.join(directory, "fat");
    execFileSync("/usr/bin/lipo", ["-create", binaries.arm64, binaries.x86_64, "-output", binaries.fat]);
  });
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  function macApp() {
    const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-after-pack-mac-"));
    temporaryDirectories.push(appOutDir);
    const tools = path.join(appOutDir, "OpenMausBot.app", "Contents", "Resources", "android-platform-tools", "darwin");
    fs.mkdirSync(path.join(tools, "lib64"), { recursive: true });
    fs.copyFileSync(binaries.fat, path.join(tools, "adb"));
    fs.copyFileSync(binaries.fat, path.join(tools, "lib64", "libc++.dylib"));
    fs.chmodSync(path.join(tools, "adb"), 0o755);
    fs.writeFileSync(path.join(tools, "NOTICE.txt"), "notice");
    return { appOutDir, tools };
  }

  it.each([["arm64", 3], ["x86_64", 1]])("keeps only the %s slice of every Mach-O", async (expected, arch) => {
    const { appOutDir, tools } = macApp();
    await afterPack({ electronPlatformName: "darwin", arch, appOutDir });
    expect(archs(path.join(tools, "adb"))).toBe(expected);
    expect(archs(path.join(tools, "lib64", "libc++.dylib"))).toBe(expected);
    expect(fs.statSync(path.join(tools, "adb")).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(tools, "NOTICE.txt"), "utf8")).toBe("notice");
    expect(fs.readdirSync(tools).sort()).toEqual(["NOTICE.txt", "adb", "lib64"]);
  });

  it("never rewrites a hard-linked staging source", async () => {
    const { appOutDir, tools } = macApp();
    const staged = path.join(appOutDir, "staged-adb");
    fs.copyFileSync(binaries.fat, staged);
    fs.rmSync(path.join(tools, "adb"));
    fs.linkSync(staged, path.join(tools, "adb"));
    await afterPack({ electronPlatformName: "darwin", arch: 3, appOutDir });
    expect(archs(path.join(tools, "adb"))).toBe("arm64");
    expect(fs.readFileSync(staged).equals(fs.readFileSync(binaries.fat))).toBe(true);
  });

  it("fails packaging when a binary lacks the app's arch", async () => {
    const { appOutDir, tools } = macApp();
    fs.copyFileSync(binaries.x86_64, path.join(tools, "adb"));
    await expect(afterPack({ electronPlatformName: "darwin", arch: 3, appOutDir })).rejects.toThrow(/no arm64 slice/);
  });

  it("rejects a universal package instead of guessing a slice", async () => {
    const { appOutDir } = macApp();
    await expect(afterPack({ electronPlatformName: "darwin", arch: 4, appOutDir }))
      .rejects.toThrow(/Unsupported macOS package architecture/);
  });
});
