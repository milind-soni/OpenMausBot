import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  FILES,
  LEGACY_STAGE_GRACE_MS,
  cleanupAppImageCuaBundle,
  reapStaleAppImageCuaBundles,
  stageAppImageCuaBundle,
} = require("./cua-linux-bundle.cjs");

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-appimage-bundle-test-"));
  temporaryDirectories.push(root);
  const resourcesPath = path.join(root, "resources");
  const source = path.join(resourcesPath, "cua-linux-x64");
  fs.mkdirSync(source, { recursive: true, mode: 0o775 });
  return { root, resourcesPath, source };
}

describe.skipIf(process.platform === "win32")("AppImage CUA private staging", () => {
  it("copies exact bytes to a private executable stage and removes only that stage", () => {
    const { root, resourcesPath, source } = fixture();
    const files = {};
    for (const [name, bytes] of [
      ["cua-driver", Buffer.from("driver")],
      ["cua-cursor-theme", Buffer.from("theme")],
    ]) {
      fs.writeFileSync(path.join(source, name), bytes);
      files[name] = createHash("sha256").update(bytes).digest("hex");
    }
    const stage = stageAppImageCuaBundle({
      resourcesPath,
      temporaryRoot: root,
      files,
      processId: 4242,
    });
    expect(path.basename(stage.directory)).toMatch(/^openmausbot-cua-linux-x64-4242-/);
    expect(fs.lstatSync(stage.directory).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(stage.driverPath).mode & 0o777).toBe(0o755);
    cleanupAppImageCuaBundle(stage, { temporaryRoot: root });
    expect(fs.existsSync(stage.directory)).toBe(false);
    expect(fs.existsSync(resourcesPath)).toBe(true);
  });

  it("rejects bytes that do not match the pinned runtime", () => {
    const { root, resourcesPath, source } = fixture();
    for (const name of Object.keys(FILES)) fs.writeFileSync(path.join(source, name), "wrong");
    expect(() => stageAppImageCuaBundle({ resourcesPath, temporaryRoot: root })).toThrow(
      "failed integrity validation",
    );
    expect(fs.readdirSync(root).filter((name) => name.startsWith("openmausbot-cua"))).toEqual([]);
  });

  it("refuses cleanup outside its exact private stage namespace", () => {
    const { root } = fixture();
    expect(() =>
      cleanupAppImageCuaBundle({ directory: root }, { temporaryRoot: path.dirname(root) }),
    ).toThrow("unexpected AppImage CUA stage");
  });

  it("reaps only dead process-owned stages with exact private contents", () => {
    const { root, resourcesPath, source } = fixture();
    const files = {};
    for (const [name, bytes] of [
      ["cua-driver", Buffer.from("driver")],
      ["cua-cursor-theme", Buffer.from("theme")],
    ]) {
      fs.writeFileSync(path.join(source, name), bytes);
      files[name] = createHash("sha256").update(bytes).digest("hex");
    }
    const dead = stageAppImageCuaBundle({
      resourcesPath,
      temporaryRoot: root,
      files,
      processId: 1111,
    });
    const live = stageAppImageCuaBundle({
      resourcesPath,
      temporaryRoot: root,
      files,
      processId: 2222,
    });
    const tampered = stageAppImageCuaBundle({
      resourcesPath,
      temporaryRoot: root,
      files,
      processId: 3333,
    });
    fs.writeFileSync(path.join(tampered.directory, "unexpected"), "keep me");

    const removed = reapStaleAppImageCuaBundles({
      temporaryRoot: root,
      files,
      isDirectoryActive: () => false,
      isProcessAlive: (processId) => processId === 2222,
    });

    expect(removed).toEqual([dead.directory]);
    expect(fs.existsSync(dead.directory)).toBe(false);
    expect(fs.existsSync(live.directory)).toBe(true);
    expect(fs.existsSync(tampered.directory)).toBe(true);
  });

  it("gives legacy stages a race-safe grace period and retains active ones", () => {
    const { root, source } = fixture();
    const files = {};
    for (const [name, bytes] of [
      ["cua-driver", Buffer.from("driver")],
      ["cua-cursor-theme", Buffer.from("theme")],
    ]) {
      fs.writeFileSync(path.join(source, name), bytes);
      files[name] = createHash("sha256").update(bytes).digest("hex");
    }
    const createLegacy = (suffix) => {
      const directory = path.join(root, `openmausbot-cua-linux-x64-${suffix}`);
      fs.mkdirSync(directory, { mode: 0o700 });
      for (const name of Object.keys(files)) {
        fs.copyFileSync(path.join(source, name), path.join(directory, name));
        fs.chmodSync(path.join(directory, name), 0o755);
      }
      return directory;
    };
    const recent = createLegacy("ABC123");
    const active = createLegacy("DEF456");
    const stale = createLegacy("GHI789");
    const now = Date.now();
    const old = new Date(now - LEGACY_STAGE_GRACE_MS - 1);
    fs.utimesSync(active, old, old);
    fs.utimesSync(stale, old, old);

    const removed = reapStaleAppImageCuaBundles({
      temporaryRoot: root,
      files,
      now,
      isDirectoryActive: (directory) => directory === active,
      isProcessAlive: () => false,
    });

    expect(removed).toEqual([stale]);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(active)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
  });
});
