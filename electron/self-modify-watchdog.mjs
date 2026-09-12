#!/usr/bin/env node
// Detached stability watchdog for the self-modify subsystem.
//
// Spawned detached by the server the moment a runtime apply lands (the
// journal entry then carries a boot marker with the server's pid), it
// watches that pid: if the process dies — or wedges, missing its
// heartbeat — before the journal entry is promoted to `verified`, the
// proposal did not survive, and the originals are restored byte-for-byte
// from the journal's backups.
//
// This is the path that catches a server that cannot even parse its own
// code, where boot reconciliation cannot run. It never starts a server
// and never touches anything but the journal backups and marker.
//
// Exit codes: 0 nothing to watch / lifetime elapsed · 3 reverted · 4 the
// journal was already settled (another watcher got there first).
//
// Standalone on purpose: plain Node, no imports from server/, so it works
// even when server/ is the thing that is broken.
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WATCHDOG_DIR = dirname(fileURLToPath(import.meta.url));
// electron/ -> project root. The data dir is passed explicitly so a moved
// OMB_DATA_DIR cannot strand the watchdog.

const args = process.argv.slice(2);
const journalFile = args[0];
const dataDir = args[1];
const pid = Number(args[2]);
if (!journalFile || !dataDir || !Number.isInteger(pid) || pid <= 0) {
  console.error("usage: self-modify-watchdog.mjs <journal-entry.json> <DATA_DIR> <pid> [projectRoot]");
  process.exit(5);
}

const journalPath = resolve(journalFile);
const markerPath = join(dataDir, "self-modify", "boot-marker.json");
// Restore target: the server's project root, passed explicitly by the
// spawner so a moved install or a relocated data dir cannot strand the
// backups in the wrong tree.
const ROOT = args[3] ? resolve(args[3]) : resolve(WATCHDOG_DIR, "..");

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Byte-exact restore from the journal's own backup records. Mirrors
 * server/self-modify.ts revertProposal() without importing it. */
function revertEntry(entry, reason) {
  let touched = 0;
  for (const item of entry.entries ?? []) {
    const absolute = resolve(ROOT, item.path);
    try {
      if (item.deleted) {
        if (existsSync(absolute)) {
          rmSync(absolute);
          touched++;
        }
        continue;
      }
      if (item.backupPath && existsSync(item.backupPath)) {
        mkdirSync(dirname(absolute), { recursive: true });
        cpSync(item.backupPath, absolute);
        touched++;
      }
    } catch {
      // per-file best effort; the journal stays `applied` so a later
      // reconciliation can retry any file that failed here
    }
  }
  // Persist the revert by rewriting the same journal file the server reads.
  const reverted = {
    ...entry,
    status: "reverted",
    revertedAt: new Date().toISOString(),
    revertReason: reason,
  };
  try {
    writeFileSync(journalPath, JSON.stringify(reverted, null, 2), { mode: 0o600 });
  } catch {
    // The files are restored; the journal status is best-effort here. Boot
    // reconciliation treats a still-`applied` entry for a dead pid as
    // abandoned and reverts (idempotently) on the next boot.
  }
  // A reverted proposal is no longer this boot's live proposal.
  try {
    rmSync(markerPath, { force: true });
  } catch {
    // marker cleanup is best-effort
  }
  return touched;
}

const entry = readJson(journalPath);
if (!entry || entry.status !== "applied") process.exit(0);

function alive(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else — still alive.
    return error?.code === "EPERM";
  }
}

// Timings are env-overridable so the safety tests can drive this loop in
// milliseconds instead of waiting out real boot windows.
const envMs = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
};
const BOOT_GRACE_MS = envMs("OMB_WATCHDOG_BOOT_GRACE_MS", 20_000);
const STALE_AFTER_MS = envMs("OMB_WATCHDOG_STALE_MS", 60_000);
const POLL_MS = envMs("OMB_WATCHDOG_POLL_MS", 2_000);
const MAX_LIFETIME_MS = envMs("OMB_WATCHDOG_MAX_LIFETIME_MS", 10 * 60_000);

const start = Date.now();
const readMarkerMtime = () => {
  try {
    return statSync(markerPath).mtimeMs;
  } catch {
    return 0;
  }
};
let lastMarkerMtime = readMarkerMtime();

for (;;) {
  // Re-read before acting: the server may have verified or reverted on its
  // way down, or another watcher may have raced us.
  const latest = readJson(journalPath);
  if (!latest || latest.status !== "applied") process.exit(4);

  if (!alive(pid)) {
    revertEntry(latest, `watchdog: server pid ${pid} died without verifying "${latest.proposal?.id ?? "?"}"`);
    process.exit(3);
  }

  const now = Date.now();
  const mtime = readMarkerMtime();
  if (mtime !== lastMarkerMtime) {
    lastMarkerMtime = mtime;
  } else if (now - start > BOOT_GRACE_MS && mtime > 0 && now - mtime > STALE_AFTER_MS) {
    // Heartbeat stalled while the process still exists: wedged or hung so
    // hard the event loop cannot tick. Treat as dead.
    revertEntry(latest, `watchdog: boot marker stale ${Math.round((now - mtime) / 1000)}s for pid ${pid} ("${latest.proposal?.id ?? "?"}")`);
    process.exit(3);
  }

  if (now - start > MAX_LIFETIME_MS) process.exit(0);
  await new Promise((r) => setTimeout(r, POLL_MS));
}
