import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installedPackage, pinnedDuckdbVersion, platformPackage, stageDuckdb, targetsFor, verifyDuckdbTree } from "./prepare-duckdb.mjs";

const PIN = "9.9.9-r.9";
const temporaryDirectories = [];

function temporary(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writePackage(directory, name, version, files) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: `@duckdb/${name}`, version }));
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    if (Buffer.isBuffer(content)) fs.writeFileSync(path.join(directory, file), content);
    else fs.writeFileSync(path.join(directory, file), content);
  }
}

/** A flat node_modules (npm's layout) holding the three packages for one target. */
function flatInstall({ version = PIN, platform = "linux", arch = "x64", nativeFiles } = {}) {
  const root = temporary("omb-duckdb-root-");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@duckdb/node-api": PIN } }));
  const nodeModules = path.join(root, "node_modules");
  const scope = path.join(nodeModules, "@duckdb");
  writePackage(path.join(scope, "node-api"), "node-api", version, { "lib/index.js": "module.exports = {};" });
  writePackage(path.join(scope, "node-bindings"), "node-bindings", version, { "duckdb.js": "module.exports = require('./x');" });
  const native = platformPackage(platform, arch);
  writePackage(path.join(scope, native), native, version, nativeFiles ?? { "duckdb.node": "node", [platform === "win32" ? "duckdb.dll" : platform === "darwin" ? "libduckdb.dylib" : "libduckdb.so"]: "lib" });
  return { root, nodeModules, scope };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("the pin", () => {
  it("requires an exact x.y.z-r.n version of @duckdb/node-api", () => {
    const { root } = flatInstall();
    expect(pinnedDuckdbVersion(root)).toBe(PIN);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { "@duckdb/node-api": "^1.5.6-r.1" } }));
    expect(() => pinnedDuckdbVersion(root)).toThrow(/exact x\.y\.z-r\.n/);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    expect(() => pinnedDuckdbVersion(root)).toThrow(/found nothing/);
  });

  it("stages both mac arches and x64 elsewhere", () => {
    expect(targetsFor("darwin", {})).toEqual([{ platform: "darwin", arch: "arm64" }, { platform: "darwin", arch: "x64" }]);
    expect(targetsFor("darwin", { OPENMAUSBOT_CUA_ARCHES: "arm64", OPENMAUSBOT_CUA_ARCHES_PARTIAL: "1" })).toEqual([{ platform: "darwin", arch: "arm64" }]);
    expect(targetsFor("linux", {})).toEqual([{ platform: "linux", arch: "x64" }]);
    expect(targetsFor("win32", {})).toEqual([{ platform: "win32", arch: "x64" }]);
  });
});

describe("staging from an install", () => {
  it("copies the three packages into a per-target tree that verifies", async () => {
    const { root } = flatInstall();
    const staged = await stageDuckdb({ root, targets: [{ platform: "linux", arch: "x64" }], sign: false, log: null });
    const tree = path.join(root, "dist-native", "duckdb", "linux-x64");
    expect(staged).toEqual([tree]);
    const scope = path.join(tree, "node_modules", "@duckdb");
    expect(fs.readdirSync(scope).sort()).toEqual(["node-api", "node-bindings", "node-bindings-linux-x64"]);
    expect(fs.readFileSync(path.join(scope, "node-bindings-linux-x64", "libduckdb.so"), "utf8")).toBe("lib");
    expect(fs.lstatSync(path.join(scope, "node-api")).isSymbolicLink()).toBe(false);
    await verifyDuckdbTree(tree, "linux", "x64", PIN);
  });

  it("finds the packages through pnpm's store links", () => {
    const root = temporary("omb-duckdb-pnpm-");
    const nodeModules = path.join(root, "node_modules");
    const store = path.join(nodeModules, ".pnpm");
    const api = path.join(store, `@duckdb+node-api@${PIN}`, "node_modules", "@duckdb");
    const bindings = path.join(store, `@duckdb+node-bindings@${PIN}`, "node_modules", "@duckdb");
    const native = path.join(store, `@duckdb+node-bindings-linux-x64@${PIN}`, "node_modules", "@duckdb");
    writePackage(path.join(api, "node-api"), "node-api", PIN, {});
    writePackage(path.join(bindings, "node-bindings"), "node-bindings", PIN, {});
    writePackage(path.join(native, "node-bindings-linux-x64"), "node-bindings-linux-x64", PIN, {});
    fs.symlinkSync(path.join(bindings, "node-bindings"), path.join(api, "node-bindings"), "dir");
    fs.symlinkSync(path.join(native, "node-bindings-linux-x64"), path.join(bindings, "node-bindings-linux-x64"), "dir");
    fs.mkdirSync(path.join(nodeModules, "@duckdb"));
    fs.symlinkSync(path.join(api, "node-api"), path.join(nodeModules, "@duckdb", "node-api"), "dir");

    expect(installedPackage(nodeModules, "node-api")).toBe(fs.realpathSync(path.join(api, "node-api")));
    expect(installedPackage(nodeModules, "node-bindings")).toBe(fs.realpathSync(path.join(bindings, "node-bindings")));
    expect(installedPackage(nodeModules, "node-bindings-linux-x64")).toBe(fs.realpathSync(path.join(native, "node-bindings-linux-x64")));
    expect(installedPackage(nodeModules, "node-bindings-win32-x64")).toBeNull();
    expect(installedPackage(path.join(root, "nowhere"), "node-api")).toBeNull();
  });

  it("refuses an installed package whose version is not the pin", async () => {
    const { root } = flatInstall({ version: "9.9.8-r.1" });
    await expect(stageDuckdb({ root, targets: [{ platform: "linux", arch: "x64" }], sign: false, log: null }))
      .rejects.toThrow(/node-api at .* is 9\.9\.8-r\.1; package\.json pins 9\.9\.9-r\.9/);
  });

  it("fetches a platform package the install lacks, at the pinned version only", async () => {
    const { root } = flatInstall();
    const packed = [];
    const pack = async (name, version, cache) => {
      packed.push({ name, version, cache });
      const directory = path.join(cache, `${name}-${version}`);
      writePackage(directory, name, version, { "duckdb.node": "node", "duckdb.dll": "lib" });
      return directory;
    };
    const staged = await stageDuckdb({ root, targets: [{ platform: "win32", arch: "x64" }], pack, sign: false, log: null });
    expect(packed).toEqual([{ name: "node-bindings-win32-x64", version: PIN, cache: path.join(root, "node_modules", ".cache", "openmausbot", "duckdb") }]);
    await verifyDuckdbTree(staged[0], "win32", "x64", PIN);

    const wrong = async (name, version, cache) => {
      const directory = path.join(cache, `${name}-other`);
      writePackage(directory, name, "9.9.9-r.8", { "duckdb.node": "node", "duckdb.dll": "lib" });
      return directory;
    };
    await expect(stageDuckdb({ root, targets: [{ platform: "win32", arch: "x64" }], pack: wrong, sign: false, log: null }))
      .rejects.toThrow(/is 9\.9\.9-r\.8; package\.json pins/);
  });

  it("never fetches node-api or node-bindings: those must be installed", async () => {
    const { root, scope } = flatInstall();
    fs.rmSync(path.join(scope, "node-bindings"), { recursive: true });
    await expect(stageDuckdb({ root, targets: [{ platform: "linux", arch: "x64" }], pack: async () => { throw new Error("must not pack"); }, sign: false, log: null }))
      .rejects.toThrow(/node-bindings is not installed/);
  });
});

describe("verifying a tree", () => {
  async function stagedTree() {
    const { root } = flatInstall();
    const [tree] = await stageDuckdb({ root, targets: [{ platform: "linux", arch: "x64" }], sign: false, log: null });
    return { tree, native: path.join(tree, "node_modules", "@duckdb", "node-bindings-linux-x64") };
  }

  it("fails on a missing binding, a missing library, a link, or another version", async () => {
    const { tree, native } = await stagedTree();
    await verifyDuckdbTree(tree, "linux", "x64", PIN);
    await expect(verifyDuckdbTree(tree, "linux", "x64", "9.9.9-r.1")).rejects.toThrow(/pins 9\.9\.9-r\.1/);
    await expect(verifyDuckdbTree(tree, "linux", "arm64", PIN)).rejects.toThrow(/missing: .*node-bindings-linux-arm64/);
    fs.renameSync(path.join(native, "duckdb.node"), path.join(native, "duckdb.node.bak"));
    await expect(verifyDuckdbTree(tree, "linux", "x64", PIN)).rejects.toThrow(/duckdb\.node.*missing|missing: .*duckdb\.node/);
    fs.symlinkSync(path.join(native, "duckdb.node.bak"), path.join(native, "duckdb.node"));
    await expect(verifyDuckdbTree(tree, "linux", "x64", PIN)).rejects.toThrow(/regular file/);
    fs.unlinkSync(path.join(native, "duckdb.node"));
    fs.renameSync(path.join(native, "duckdb.node.bak"), path.join(native, "duckdb.node"));
    fs.unlinkSync(path.join(native, "libduckdb.so"));
    await expect(verifyDuckdbTree(tree, "linux", "x64", PIN)).rejects.toThrow(/libduckdb\.so/);
  });
});

// Real Mach-O fixtures: /usr/bin binaries are arm64e, not arm64, so compile.
const canBuildMachO = process.platform === "darwin" && fs.existsSync("/usr/bin/lipo") && spawnSync("cc", ["--version"]).status === 0;

describe.skipIf(!canBuildMachO)("macOS slices", () => {
  const binaries = {};
  let directory;
  const archs = (file) => execFileSync("/usr/bin/lipo", ["-archs", file], { encoding: "utf8" }).trim();

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "omb-duckdb-macho-"));
    fs.writeFileSync(path.join(directory, "main.c"), "int main(void) { return 0; }\n");
    for (const arch of ["arm64", "x86_64"]) {
      binaries[arch] = path.join(directory, arch);
      execFileSync("cc", ["-arch", arch, "-o", binaries[arch], path.join(directory, "main.c")]);
    }
    binaries.fat = path.join(directory, "fat");
    execFileSync("/usr/bin/lipo", ["-create", binaries.arm64, binaries.x86_64, "-output", binaries.fat]);
  });

  it.each([["arm64", "arm64"], ["x64", "x86_64"]])("keeps only the %s slice of the universal dylib and binding, signed", async (arch, lipoArch) => {
    const fat = fs.readFileSync(binaries.fat);
    const { root } = flatInstall({ platform: "darwin", arch, nativeFiles: { "duckdb.node": fat, "libduckdb.dylib": fat } });
    const [tree] = await stageDuckdb({ root, targets: [{ platform: "darwin", arch }], sign: true, log: null });
    const native = path.join(tree, "node_modules", "@duckdb", platformPackage("darwin", arch));
    expect(archs(path.join(native, "libduckdb.dylib"))).toBe(lipoArch);
    expect(archs(path.join(native, "duckdb.node"))).toBe(lipoArch);
    expect(spawnSync("/usr/bin/codesign", ["--verify", path.join(native, "libduckdb.dylib")]).status).toBe(0);
    await verifyDuckdbTree(tree, "darwin", arch, PIN);
  });

  it("rejects a tree whose dylib stayed universal or is not Mach-O", async () => {
    const fat = fs.readFileSync(binaries.fat);
    const { root, scope } = flatInstall({ platform: "darwin", arch: "arm64", nativeFiles: { "duckdb.node": fat, "libduckdb.dylib": fat } });
    const tree = path.join(root, "dist-native", "duckdb", "darwin-arm64");
    fs.cpSync(path.join(root, "node_modules"), path.join(tree, "node_modules"), { recursive: true });
    await expect(verifyDuckdbTree(tree, "darwin", "arm64", PIN)).rejects.toThrow(/is \[(?:arm64 x86_64|x86_64 arm64)\], must be exactly arm64/);
    fs.writeFileSync(path.join(tree, "node_modules", "@duckdb", "node-bindings-darwin-arm64", "libduckdb.dylib"), "not a binary");
    fs.copyFileSync(binaries.arm64, path.join(tree, "node_modules", "@duckdb", "node-bindings-darwin-arm64", "duckdb.node"));
    await expect(verifyDuckdbTree(tree, "darwin", "arm64", PIN)).rejects.toThrow(/not a Mach-O/);
    expect(scope).toBeTruthy();
  });

  it("fails staging when the binary lacks the app's arch", async () => {
    const only = fs.readFileSync(binaries.x86_64);
    const { root } = flatInstall({ platform: "darwin", arch: "arm64", nativeFiles: { "duckdb.node": only, "libduckdb.dylib": only } });
    await expect(stageDuckdb({ root, targets: [{ platform: "darwin", arch: "arm64" }], sign: false, log: null })).rejects.toThrow(/no arm64 slice/);
  });
});
