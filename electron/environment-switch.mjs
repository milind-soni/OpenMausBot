// Orchestrates one local-environment switch: stop the server child, hand the
// data-directory lease from the current environment to the target, restart the
// child, and only then persist the new active environment. Every side effect
// arrives through `deps` so the whole flow unit-tests with hand-rolled fakes;
// the only direct IO is validateTargetDir's default fs, per the plan.
import * as fs from "node:fs";
import { dirname } from "node:path";
import { DataDirLeaseError } from "./data-dir-lease.mjs";

export const DEFAULT_SERVER_PORT = 8799;

/**
 * Whether `dataDir` can host an environment switch right now.
 * A missing parent means the containing volume is absent (unmounted drive):
 * the switch must abort and stay put, never mkdir through the void.
 */
export function validateTargetDir(dataDir, fsImpl = fs) {
  if (!fsImpl.existsSync(dirname(dataDir))) return { ok: false, error: "unavailable" };
  return { ok: true, needsCreate: !fsImpl.existsSync(dataDir) };
}

export async function switchLocalEnvironment({ targetDir, targetId, port = DEFAULT_SERVER_PORT, deps }) {
  const { stopChild, releaseLease, acquireLease, createDir, startChild, probeReady, rollback, persistActive, log } = deps;

  const fail = async (error) => {
    // rollback(port) kills the failed child (if any), re-acquires the old
    // lease and restarts the old environment. It owns the restart: this
    // module never calls startChild on a failure path, so a failed switch
    // cannot double-start the server. A rollback that itself fails is not a
    // successful rollback.
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
    // A held lease (live owner elsewhere or under recovery) is the expected
    // failure; anything else from the lease layer still means "not ours".
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

  // The registry write is the last step: only after it lands is the target
  // "the" environment. If it fails, the target child and lease are already
  // live, so roll them back the same way any earlier failure does.
  try {
    await persistActive(targetId);
  } catch (error) {
    log(`switch to ${targetDir} aborted: active-ID persistence failed (${error?.message ?? error})`);
    return await fail("persist-failed");
  }
  return { ok: true };
}
