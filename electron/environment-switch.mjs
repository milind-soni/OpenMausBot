import * as fs from "node:fs";
import { dirname } from "node:path";
import { DataDirLeaseError } from "./data-dir-lease.mjs";

export const DEFAULT_SERVER_PORT = 8799;

/** A missing parent means an absent volume: abort and stay put, never mkdir through it. */
export function validateTargetDir(dataDir, fsImpl = fs) {
  if (!fsImpl.existsSync(dirname(dataDir))) return { ok: false, error: "unavailable" };
  return { ok: true, needsCreate: !fsImpl.existsSync(dataDir) };
}

export async function switchLocalEnvironment({ targetDir, targetId, port = DEFAULT_SERVER_PORT, deps }) {
  const { stopChild, releaseLease, acquireLease, createDir, startChild, probeReady, rollback, persistActive, log } = deps;

  const fail = async (error) => {
    // rollback owns the restart: this module never calls startChild on a failure path, so a failed switch cannot double-start.
    try {
      await rollback(port);
    } catch (error2) {
      log(`switch rollback failed: ${error2?.message ?? error2}`);
      return { ok: false, error, rolledBack: false };
    }
    return { ok: false, error, rolledBack: true };
  };

  await stopChild();
  await releaseLease();

  const target = validateTargetDir(targetDir);
  if (!target.ok) {
    log(`switch to ${targetDir} aborted: target unavailable`);
    return await fail("unavailable");
  }
  if (target.needsCreate) {
    try {
      await createDir(targetDir);
    } catch (error) {
      log(`switch to ${targetDir} aborted: cannot create directory (${error?.message ?? error})`);
      return await fail("unavailable");
    }
  }

  try {
    await acquireLease(targetDir);
  } catch (error) {
    const leaseError = error instanceof DataDirLeaseError;
    log(`switch to ${targetDir} aborted: lease ${leaseError ? "held" : "acquisition failed"} (${error?.message ?? error})`);
    return await fail("locked");
  }

  let started;
  try {
    started = await startChild(port);
  } catch (error) {
    log(`switch to ${targetDir} aborted: child start threw (${error?.message ?? error})`);
    return await fail("start-failed");
  }
  if (!started || !Number.isInteger(started.pid)) {
    log(`switch to ${targetDir} aborted: child did not start`);
    return await fail("start-failed");
  }

  let outcome;
  try {
    outcome = await probeReady(port, started.pid);
  } catch (error) {
    log(`switch to ${targetDir} aborted: health probe threw (${error?.message ?? error})`);
    outcome = "probe-failed";
  }
  if (outcome !== "ready") {
    log(`switch to ${targetDir} aborted: health probe returned ${outcome}`);
    return await fail(outcome || "unhealthy");
  }

  // The registry write is last: on failure the target child and lease are already live, so roll them back too.
  try {
    await persistActive(targetId);
  } catch (error) {
    log(`switch to ${targetDir} aborted: active-ID persistence failed (${error?.message ?? error})`);
    return await fail("persist-failed");
  }
  return { ok: true };
}

/** After a failed switch left no server child: take the previous folder's lease back when none is held (a rollback
 * can fail between releasing one lease and taking the other), then start the server there. A lease that stays held
 * elsewhere is never forced: after the retries the server stays stopped and the reason is logged. */
export async function reviveAfterFailedSwitch({ previousDir, hasLease, acquireLease, startChild, log, delays = [1_000, 2_000, 4_000], sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (!hasLease()) await acquireLease(previousDir);
      if (await startChild(previousDir)) return true;
      log(`could not restart the server on ${previousDir} after the failed environment switch`);
      return false;
    } catch (error) {
      if (attempt >= delays.length) {
        log(`gave up restarting the server on ${previousDir} after the failed environment switch (${error?.message ?? error})`);
        return false;
      }
      log(`restart on ${previousDir} after the failed environment switch failed (${error?.message ?? error}); retrying`);
      await sleep(delays[attempt]);
    }
  }
}
