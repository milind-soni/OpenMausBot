import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  evictStartupCacheOnce,
  readLastRunVersion,
  rememberLastRunVersion,
  startupCacheEvictionDecision,
} from "./startup-cache-eviction.mjs";

test("the cache is evicted when the persisted version is not this build's, and only then", () => {
  assert.deepEqual(startupCacheEvictionDecision({ currentVersion: "1.2.3", persistedVersion: "1.2.3" }), { evict: false, reason: "same-version" });
  assert.deepEqual(startupCacheEvictionDecision({ currentVersion: "1.2.3", persistedVersion: "1.2.2" }), { evict: true, reason: "version-change" });
  assert.deepEqual(startupCacheEvictionDecision({ currentVersion: "1.2.3", persistedVersion: null }), { evict: true, reason: "no-persisted-version" });
  assert.deepEqual(startupCacheEvictionDecision({ currentVersion: "", persistedVersion: null }), { evict: false, reason: "unknown-version" });
});

test("the last-run version survives a reread, and unknown files read as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-startup-cache-"));
  try {
    assert.equal(readLastRunVersion(dir), null);
    assert.equal(rememberLastRunVersion(dir, "0.1.85"), true);
    assert.equal(readLastRunVersion(dir), "0.1.85");
    writeFileSync(join(dir, "last-run-version.json"), "{not json");
    assert.equal(readLastRunVersion(dir), null);
    writeFileSync(join(dir, "last-run-version.json"), JSON.stringify({ version: 42 }));
    assert.equal(readLastRunVersion(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the eviction runs once per version: first launch clears, relaunch does not, an upgrade clears again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-startup-cache-"));
  const clears = [];
  const deps = (currentVersion) => ({
    userData: dir,
    currentVersion,
    clearCache: async () => { clears.push(currentVersion); },
    readVersion: readLastRunVersion,
    rememberVersion: rememberLastRunVersion,
    log() {},
  });
  try {
    assert.deepEqual(await evictStartupCacheOnce(deps("0.2.0")), { evict: true, reason: "no-persisted-version", cleared: true, remembered: true });
    assert.deepEqual(await evictStartupCacheOnce(deps("0.2.0")), { evict: false, reason: "same-version", cleared: false, remembered: true });
    assert.deepEqual(await evictStartupCacheOnce(deps("0.2.1")), { evict: true, reason: "version-change", cleared: true, remembered: true });
    assert.deepEqual(await evictStartupCacheOnce(deps("0.2.1")), { evict: false, reason: "same-version", cleared: false, remembered: true });
    assert.deepEqual(clears, ["0.2.0", "0.2.1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the production wiring shape works without injected persistence (regression)", async () => {
  // main.mjs passes only userData, currentVersion, clearCache and log, so this shape must boot on the file-backed defaults.
  const dir = mkdtempSync(join(tmpdir(), "omb-startup-cache-"));
  const clears = [];
  const productionShape = (currentVersion) => ({
    userData: dir,
    currentVersion,
    clearCache: async () => { clears.push(currentVersion); },
    log() {},
  });
  try {
    assert.deepEqual(await evictStartupCacheOnce(productionShape("0.2.0")), { evict: true, reason: "no-persisted-version", cleared: true, remembered: true });
    assert.equal(readLastRunVersion(dir), "0.2.0");
    assert.deepEqual(await evictStartupCacheOnce(productionShape("0.2.0")), { evict: false, reason: "same-version", cleared: false, remembered: true });
    assert.deepEqual(clears, ["0.2.0"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed clear is retried on the next launch, not recorded as done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-startup-cache-"));
  const logs = [];
  let fail = true;
  try {
    const first = await evictStartupCacheOnce({
      userData: dir,
      currentVersion: "0.2.0",
      clearCache: async () => { if (fail) throw new Error("disk hiccup"); },
      readVersion: readLastRunVersion,
      rememberVersion: rememberLastRunVersion,
      log: (line) => logs.push(line),
    });
    assert.equal(first.cleared, false);
    assert.equal(readLastRunVersion(dir), null);
    fail = false;
    const second = await evictStartupCacheOnce({
      userData: dir,
      currentVersion: "0.2.0",
      clearCache: async () => {},
      readVersion: readLastRunVersion,
      rememberVersion: rememberLastRunVersion,
      log: (line) => logs.push(line),
    });
    assert.deepEqual(second, { evict: true, reason: "no-persisted-version", cleared: true, remembered: true });
    assert.equal(readLastRunVersion(dir), "0.2.0");
    assert.match(logs.join("\n"), /failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
