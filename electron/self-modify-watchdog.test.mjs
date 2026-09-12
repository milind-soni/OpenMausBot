// Tests for the detached self-modify stability watchdog. The real script is
// spawned as a child process against throwaway fixtures: a fake project root
// holding an "edited" file, a fake data dir holding its journal entry and
// byte-exact backup, and a boot marker. Timings are driven to milliseconds
// through the OMB_WATCHDOG_* env overrides the script reads, so the
// nothing-to-watch, death, wedge (stale heartbeat), lifetime, and raced-by
// another-watcher paths are all exercised in seconds.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WATCHDOG = new URL("./self-modify-watchdog.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const FAST = {
  ...process.env,
  OMB_WATCHDOG_POLL_MS: "100",
  OMB_WATCHDOG_BOOT_GRACE_MS: "200",
  OMB_WATCHDOG_STALE_MS: "300",
  OMB_WATCHDOG_MAX_LIFETIME_MS: "4000",
};

const EDITED = "export const props = { tick: 2 };\n";
const ORIGINAL = "export const props = { tick: 1 };\n";

let root;
let dataDir;
let journalFile;
let markerPath;
let filePath;

function makeFixture() {
  root = mkdtempSync(join(tmpdir(), "omb-wd-root-"));
  dataDir = mkdtempSync(join(tmpdir(), "omb-wd-data-"));
  const id = "wd-test";
  filePath = join(root, "server", "props.ts");
  mkdirSync(join(root, "server"), { recursive: true });
  writeFileSync(filePath, EDITED, "utf8");
  const backup = join(dataDir, "self-modify", "journal", `${id}.backup`, "server__props.ts");
  mkdirSync(join(dataDir, "self-modify", "journal", `${id}.backup`), { recursive: true });
  writeFileSync(backup, ORIGINAL, "utf8");
  journalFile = join(dataDir, "self-modify", "journal", `${id}.json`);
  markerPath = join(dataDir, "self-modify", "boot-marker.json");
  writeMarker(process.pid, id);
  writeEntry(id, backup, "applied");
}

function writeMarker(pid, id, at) {
  mkdirSync(join(dataDir, "self-modify"), { recursive: true });
  writeFileSync(markerPath, JSON.stringify({ id, pid, at: (at ?? new Date()).toISOString() }), "utf8");
  if (at) utimesSync(markerPath, at, at);
}

function entryBody(id, backup) {
  return {
    proposal: { id, proposedBy: "wd-test", reason: "r", files: [{ path: "server/props.ts", action: "edit", content: EDITED }] },
    status: "applied",
    appliedAt: new Date().toISOString(),
    entries: [{ path: "server/props.ts", backupPath: backup, deleted: false }],
  };
}

function writeEntry(id, backup, status) {
  mkdirSync(join(dataDir, "self-modify", "journal"), { recursive: true });
  writeFileSync(journalFile, JSON.stringify({ ...entryBody(id, backup), status }), "utf8");
}

function backupPath() {
  return join(dataDir, "self-modify", "journal", "wd-test.backup", "server__props.ts");
}

function runWatchdog(args, env = FAST) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [WATCHDOG, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`watchdog timed out; output: ${out.slice(-400)}`));
    }, 15_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ code });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

beforeEach(makeFixture);

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("self-modify watchdog", () => {
  it("exits 0 immediately when the journal entry is not applied", async () => {
    writeEntry("wd-test", backupPath(), "verified");
    const { code } = await runWatchdog([journalFile, dataDir, String(process.pid), root]);
    expect(code).toBe(0);
    expect(readFileSync(filePath, "utf8")).toBe(EDITED);
  });

  it("exits 5 on bad arguments", async () => {
    const { code } = await runWatchdog(["not-enough-args"]);
    expect(code).toBe(5);
  });

  it("reverts byte-exactly when the watched pid dies without verifying", async () => {
    // A process that dies moments after the watchdog starts watching it —
    // the "server crashed mid-trial" path boot reconciliation cannot cover.
    const doomed = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 150));        const watcher = runWatchdog([journalFile, dataDir, String(doomed.pid), root]);
      doomed.kill("SIGKILL");
      const { code } = await watcher;
      expect(code).toBe(3);
      expect(readFileSync(filePath, "utf8")).toBe(ORIGINAL);
      expect(JSON.parse(readFileSync(journalFile, "utf8")).status).toBe("reverted");
      expect(JSON.parse(readFileSync(journalFile, "utf8")).revertReason).toContain("died without verifying");
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      if (doomed.exitCode === null && !doomed.killed) doomed.kill("SIGKILL");
    }
  });

  it("reverts when the heartbeat goes stale while the pid still exists", async () => {
    // A wedged server: the process lives but the event loop is gone, so the
    // marker mtime never moves. The watchdog must not wait for the lifetime.
    const wedged = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      writeMarker(wedged.pid, "wd-test", new Date(Date.now() - 10 * 60_000));
      const { code } = await runWatchdog([journalFile, dataDir, String(wedged.pid), root]);
      expect(code).toBe(3);
      expect(readFileSync(filePath, "utf8")).toBe(ORIGINAL);
      expect(JSON.parse(readFileSync(journalFile, "utf8")).status).toBe("reverted");
    } finally {
      if (wedged.exitCode === null) wedged.kill("SIGKILL");
    }
  });

  it("leaves everything alone while the pid lives and the heartbeat is fresh", async () => {
    // Play the server's heartbeat role: touch the marker faster than the
    // stale window so the watchdog never sees it freeze.
    const beat = setInterval(() => utimesSync(markerPath, new Date(), new Date()), 50);
    try {
      const { code } = await runWatchdog([journalFile, dataDir, String(process.pid), root]);
      expect(code).toBe(0); // lifetime elapsed, nothing wrong
      expect(readFileSync(filePath, "utf8")).toBe(EDITED);
      expect(JSON.parse(readFileSync(journalFile, "utf8")).status).toBe("applied");
    } finally {
      clearInterval(beat);
    }
  });

  it("stands down (exit 4) when another watcher settles the journal first", async () => {
    // The re-read inside the watch loop is what makes concurrent watchers
    // safe; drive it by settling the entry after the first poll.
    const settle = setTimeout(() => writeEntry("wd-test", backupPath(), "verified"), 250);
    const { code } = await runWatchdog([journalFile, dataDir, String(process.pid), root], {
      ...FAST,
      OMB_WATCHDOG_MAX_LIFETIME_MS: "8000",
    });
    clearTimeout(settle);
    expect(code).toBe(4);
    expect(readFileSync(filePath, "utf8")).toBe(EDITED);
  });
});
