import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MAIN_COMPILE_CACHE, mainCompileCacheDir, settleCompileCache } from "./main-compile-cache.mjs";

test("the packaged main process keeps its compile cache in the app's own folder, never where the path changes each launch", () => {
  const userData = path.join(tmpdir(), "omb-user-data");
  assert.equal(mainCompileCacheDir({ packaged: true, userData, resourcesPath: "/Applications/OpenMausBot.app/Contents/Resources", env: {} }), path.join(userData, MAIN_COMPILE_CACHE));
  assert.equal(mainCompileCacheDir({ packaged: false, userData, resourcesPath: "/x", env: {} }), null);
  assert.equal(mainCompileCacheDir({ packaged: true, userData, resourcesPath: "/tmp/.mount_x/resources", env: { APPIMAGE: "/home/a/OpenMausBot.AppImage" } }), null);
  assert.equal(mainCompileCacheDir({ packaged: true, userData, resourcesPath: "/private/var/folders/x/AppTranslocation/y/d/OpenMausBot.app/Contents/Resources", env: {} }), null);
});

test("settling writes this launch's entries and removes only other Node versions' directories a day unused", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "omb-main-cc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const current = path.join(root, "v24.21.0-arm64-aaaa-501");
  const old = path.join(root, "v24.11.0-arm64-bbbb-501");
  const recent = path.join(root, "v24.12.0-arm64-cccc-501");
  const other = path.join(root, "not-a-cache");
  for (const dir of [current, old, recent, other]) mkdirSync(dir);
  const dayAgo = new Date(now - 25 * 60 * 60 * 1000);
  for (const dir of [old, other, current]) utimesSync(dir, dayAgo, dayAgo);
  let flushed = 0;
  settleCompileCache({ module: { flushCompileCache: () => { flushed += 1; }, getCompileCacheDir: () => current }, root, now });
  assert.equal(flushed, 1);
  const left = (dir) => { try { statSync(dir); return true; } catch { return false; } };
  assert.deepEqual([current, old, recent, other].map(left), [true, false, true, true]);
  assert.ok(Math.abs(statSync(current).mtimeMs - now) < 2000);
});

test("a cache directory Node placed elsewhere (NODE_COMPILE_CACHE from the shell) is flushed but nothing is removed", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "omb-main-cc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, "v24.11.0-arm64-bbbb-501");
  mkdirSync(old);
  const dayAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  utimesSync(old, dayAgo, dayAgo);
  settleCompileCache({ module: { flushCompileCache() {}, getCompileCacheDir: () => path.join(tmpdir(), "elsewhere", "v24.21.0-x") }, root });
  assert.ok(statSync(old).isDirectory());
});

test("the app's entry turns the cache on before it loads main.mjs, and package.json starts there", () => {
  const boot = readFileSync(new URL("./boot.mjs", import.meta.url), "utf8");
  assert.ok(boot.indexOf("enableCompileCache(") < boot.indexOf('await import("./main.mjs")'));
  assert.doesNotMatch(boot.slice(0, boot.indexOf('await import("./main.mjs")')), /from "\.\/main\.mjs"/);
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.main, "electron/boot.mjs");
});
