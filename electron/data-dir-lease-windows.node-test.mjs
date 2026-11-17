// Windows liveness of a data-directory lease owner: kill(pid, 0), the process list, and when the pid's process started.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireDataDirLease, tasklistListsPid, windowsCreationFitsLease } from "./data-dir-lease.mjs";

const LEASE_NAME = "openmausbot-server.lease";
const roots = [];

function temporaryDirectory(name = "data") {
  const root = mkdtempSync(path.join(tmpdir(), "omb-electron-lease-"));
  roots.push(root);
  const dataDir = path.join(root, name);
  mkdirSync(dataDir, { recursive: true });
  return { root, dataDir };
}

async function exitedPid() {
  const child = spawn(process.execPath, ["--eval", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  assert.ok(pid);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return pid;
}

test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a live but unrelated Windows pid reused within the same boot is treated as stale", async (t) => {
  // With or without wmic: Windows 11 no longer installs it, and the check must still tell a reused pid apart.
  if (process.platform !== "win32") return t.skip("Windows-only: process-identity check");
  const { dataDir } = temporaryDirectory();
  const sibling = spawn(process.execPath, ["--eval", "setInterval(()=>{}, 1_000);"], { stdio: "ignore" });
  const siblingPid = sibling.pid;
  assert.ok(siblingPid);
  t.after(() => sibling.kill());
  // Long enough that the sibling's CreationDate is unambiguously later than the synthetic lease's createdAt.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const leasePath = path.join(dataDir, LEASE_NAME);
  const stale = {
    version: 1,
    pid: siblingPid,
    host: hostname(),
    token: randomUUID(),
    createdAt: Date.now() - 60_000,
    boot: null,
    uptime: 0,
  };
  writeFileSync(leasePath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });

  const lease = acquireDataDirLease(dataDir);
  try {
    assert.equal(lease.ownerPid, process.pid);
  } finally {
    lease.release();
  }
});

/**
 * The Windows liveness probes faked on any host: kill answers EPERM for the given pids (the OS answer
 * for a pid this account cannot signal — live processes of another user, and exited processes that a
 * handle still keeps referenced), tasklist answers from a PATH shim, and powershell.exe under a faked
 * SystemRoot. On Windows 11 wmic is absent, so the PATH shim intentionally carries no wmic. On Windows
 * itself the shims cannot execute, so only the platform and kill fakes apply and the real tasklist and
 * powershell answer for themselves.
 */
function fakeWindowsHost(t, { epermPids = [], tasklist, powershell = null, created = null } = {}) {
  const realWindows = process.platform === "win32";
  const priorPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...priorPlatform, value: "win32" });
  const eperm = new Set(epermPids);
  const priorKill = process.kill;
  process.kill = (pid, signal) => {
    if (eperm.has(pid)) throw Object.assign(new Error(`kill EPERM: ${pid}`), { code: "EPERM" });
    return priorKill.call(process, pid, signal);
  };
  const priorEnv = {};
  for (const name of ["PATH", "SystemRoot"]) priorEnv[name] = process.env[name];
  t.after(() => {
    Object.defineProperty(process, "platform", priorPlatform);
    process.kill = priorKill;
    for (const name of Object.keys(priorEnv)) {
      if (priorEnv[name] === undefined) delete process.env[name];
      else process.env[name] = priorEnv[name];
    }
  });

  if (realWindows) return;

  const { root } = temporaryDirectory("windows-tools");
  const binDir = path.join(root, "bin");
  mkdirSync(binDir);
  const script = (name, source) => writeFileSync(name, `#!/bin/sh\n${source}\n`, { mode: 0o755 });
  if (Array.isArray(tasklist)) {
    const rows = tasklist.map((pid) => `  *"PID eq ${pid}"*) echo '"openmausbot-server.exe","${pid}","Console","1","64,000 K"' ;;`).join("\n");
    script(path.join(binDir, "tasklist"), `case "$*" in\n${rows}\n  *) echo "INFO: No tasks are running which match the specified criteria." ;;\nesac`);
  } else if (tasklist === "error") {
    script(path.join(binDir, "tasklist"), "exit 1");
  }
  const systemRoot = path.join(root, "windows");
  if (Array.isArray(powershell) || created) {
    const bin = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
    mkdirSync(bin, { recursive: true });
    // The creation-time query (ToUnixTimeMilliseconds) answers from `created`; the process-list query from `powershell`.
    const times = Object.entries(created ?? {}).map(([pid, ms]) => `  *"ProcessId=${pid}'"*ToUnixTime*) echo ${ms} ;;`).join("\n");
    const rows = (powershell ?? []).map((pid) => `  *"ProcessId=${pid}'"*) echo 1 ;;`).join("\n");
    script(path.join(bin, "powershell.exe"), `case "$*" in\n${times}\n${rows}\n  *) : ;;\nesac`);
  }
  process.env.PATH = binDir;
  process.env.SystemRoot = systemRoot;
}

/** The record a Windows build leaves on disk: no boot id, no pid namespace, no start ticks. */
function windowsLeaseRecord(pid, createdAt = Date.now() - 60_000) {
  return {
    version: 1,
    pid,
    host: hostname(),
    token: randomUUID(),
    createdAt,
    boot: null,
    uptime: 1,
    ns: null,
    start: null,
  };
}

function plantWindowsChildLease(dataDir, pid, createdAt) {
  const childPath = path.join(dataDir, ".openmausbot-server-child", LEASE_NAME);
  mkdirSync(path.dirname(childPath));
  writeFileSync(childPath, `${JSON.stringify(windowsLeaseRecord(pid, createdAt))}\n`, { mode: 0o600 });
  return childPath;
}

/** A pid the real process list shows as running, for the Windows-host runs where no shim can fake one. */
function runningPid(t) {
  const child = spawn(process.execPath, ["--eval", "setInterval(()=>{}, 1_000);"], { stdio: "ignore" });
  assert.ok(child.pid);
  t.after(() => child.kill());
  return child.pid;
}

test("an exited Windows server child that still answers EPERM no longer blocks startup", async (t) => {
  const zombiePid = await exitedPid();
  fakeWindowsHost(t, { epermPids: [zombiePid], tasklist: [] });
  const { dataDir } = temporaryDirectory();
  plantWindowsChildLease(dataDir, zombiePid);

  const lease = acquireDataDirLease(dataDir);
  assert.equal(lease.ownerPid, process.pid);
  assert.equal(lease.release(), true);
});

test("an exited Windows lease owner that still answers EPERM is retired, not served forever", async (t) => {
  const zombiePid = await exitedPid();
  fakeWindowsHost(t, { epermPids: [zombiePid], tasklist: [] });
  const { dataDir } = temporaryDirectory();
  writeFileSync(path.join(dataDir, LEASE_NAME), `${JSON.stringify(windowsLeaseRecord(zombiePid))}\n`, { mode: 0o600 });

  const lease = acquireDataDirLease(dataDir);
  assert.equal(lease.ownerPid, process.pid);
  assert.equal(lease.release(), true);
});

test("a Windows zombie is still dead when tasklist cannot answer and the process list does", async (t) => {
  if (process.platform === "win32") return t.skip("the tool-failure fixtures are POSIX shims; real Windows probes cannot be made to fail");
  const zombiePid = await exitedPid();
  fakeWindowsHost(t, { epermPids: [zombiePid], tasklist: "error", powershell: [process.pid] });
  const { dataDir } = temporaryDirectory();
  writeFileSync(path.join(dataDir, LEASE_NAME), `${JSON.stringify(windowsLeaseRecord(zombiePid))}\n`, { mode: 0o600 });

  const lease = acquireDataDirLease(dataDir);
  assert.equal(lease.ownerPid, process.pid);
  assert.equal(lease.release(), true);
});

test("a Windows owner this account cannot signal but that still runs keeps blocking startup", async (t) => {
  const realWindows = process.platform === "win32";
  const liveForeignPid = realWindows ? runningPid(t) : await exitedPid();
  fakeWindowsHost(t, { epermPids: [liveForeignPid], tasklist: [liveForeignPid] });
  const { dataDir } = temporaryDirectory();
  // On Windows the record must postdate the live pid's real creation time, or it reads as a reused pid.
  plantWindowsChildLease(dataDir, liveForeignPid, realWindows ? Date.now() : undefined);

  assert.throws(() => acquireDataDirLease(dataDir), /still shutting down/i);
});

test("a Windows owner stays alive when the fallback process list still shows it running", async (t) => {
  if (process.platform === "win32") return t.skip("the tool-failure fixtures are POSIX shims; real Windows probes cannot be made to fail");
  const liveForeignPid = await exitedPid();
  fakeWindowsHost(t, { epermPids: [liveForeignPid], tasklist: "error", powershell: [liveForeignPid] });
  const { dataDir } = temporaryDirectory();
  plantWindowsChildLease(dataDir, liveForeignPid);

  assert.throws(() => acquireDataDirLease(dataDir), /still shutting down/i);
});

test("a Windows owner that can be neither signalled nor listed still fails closed", async (t) => {
  if (process.platform === "win32") return t.skip("the tool-failure fixtures are POSIX shims; real Windows probes cannot be made to fail");
  const foreignPid = await exitedPid();
  fakeWindowsHost(t, { epermPids: [foreignPid], tasklist: "error" });
  const { dataDir } = temporaryDirectory();
  plantWindowsChildLease(dataDir, foreignPid);

  assert.throws(() => acquireDataDirLease(dataDir), /still shutting down/i);
});

test("tasklist's answer: a CSV row is a running pid, an INFO line is none, no output proves nothing", () => {
  assert.equal(tasklistListsPid('"node.exe","4120","Services","0","41,236 K"\r\n'), true);
  assert.equal(tasklistListsPid('﻿"openmausbot-server.exe","4120","Console","1","64,000 K"\r\n'), true);
  assert.equal(tasklistListsPid("\r\nINFO: No tasks are running which match the specified criteria.\r\n"), false);
  assert.equal(tasklistListsPid("INFORMATION : aucune tâche en service ne correspond aux critères spécifiés.\r\n"), false);
  assert.equal(tasklistListsPid(""), null);
  assert.equal(tasklistListsPid("\r\n \r\n"), null);
});

test("a Windows creation time within the clocks' slack of the lease is still its owner; minutes later is a reused pid", () => {
  const leaseAt = 1_763_300_000_000;
  assert.equal(windowsCreationFitsLease(leaseAt - 60_000, leaseAt), true);
  // The kernel's creation stamp and the process' own Date.now() disagree by a timer tick or an NTP step.
  assert.equal(windowsCreationFitsLease(leaseAt, leaseAt), true);
  assert.equal(windowsCreationFitsLease(leaseAt + 16, leaseAt), true);
  assert.equal(windowsCreationFitsLease(leaseAt + 4_999, leaseAt), true);
  assert.equal(windowsCreationFitsLease(leaseAt + 5_000, leaseAt), false);
  assert.equal(windowsCreationFitsLease(leaseAt + 10 * 60_000, leaseAt), false);
  assert.equal(windowsCreationFitsLease(null, leaseAt), true);
});

test("a live Windows owner Windows says started a moment after its lease's clock still blocks startup", async (t) => {
  if (process.platform === "win32") return t.skip("the probe fixtures are POSIX shims; the real-Windows run is the test above");
  const liveForeignPid = await exitedPid();
  const createdAt = Date.now();
  fakeWindowsHost(t, { epermPids: [liveForeignPid], tasklist: [liveForeignPid], created: { [liveForeignPid]: createdAt + 12 } });
  const { dataDir } = temporaryDirectory();
  plantWindowsChildLease(dataDir, liveForeignPid, createdAt);

  assert.throws(() => acquireDataDirLease(dataDir), /still shutting down/i);
});

test("a listed Windows pid whose process started long after the lease is a reused pid, and the lease is recovered", async (t) => {
  if (process.platform === "win32") return t.skip("the probe fixtures are POSIX shims");
  const reusedPid = await exitedPid();
  const createdAt = Date.now() - 60_000;
  fakeWindowsHost(t, { epermPids: [reusedPid], tasklist: [reusedPid], created: { [reusedPid]: createdAt + 30_000 } });
  const { dataDir } = temporaryDirectory();
  plantWindowsChildLease(dataDir, reusedPid, createdAt);

  const lease = acquireDataDirLease(dataDir);
  assert.equal(lease.ownerPid, process.pid);
  assert.equal(lease.release(), true);
});
