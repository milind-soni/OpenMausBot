// One entry point for reading a named worker's readiness, so callers never
// branch on platform themselves.
import type { ResolvedWorker } from "./computer-workers.ts";
import { macWorkerStatus } from "./mac-worker.ts";
import type { RemoteWorkerLease, RemoteWorkerSshRunner, RemoteWorkerStatus } from "./remote-worker.ts";
import { windowsWorkerStatus } from "./windows-worker.ts";

export interface WorkerStatusOptions {
  runner?: RemoteWorkerSshRunner;
  lease?: RemoteWorkerLease;
  isBotBusy?: (botId: string) => boolean;
}

export function workerStatus(worker: ResolvedWorker, options: WorkerStatusOptions = {}): Promise<RemoteWorkerStatus> {
  return worker.platform === "windows" ? windowsWorkerStatus(worker, options) : macWorkerStatus(worker, options);
}

/** Reads every configured worker concurrently. One unreachable worker must
 * never delay or fail the others: #508 requires a dead worker to degrade to
 * unavailable while healthy desktops keep serving. */
export async function allWorkerStatuses(
  workers: ResolvedWorker[],
  options: WorkerStatusOptions = {},
): Promise<RemoteWorkerStatus[]> {
  return Promise.all(workers.map((worker) => workerStatus(worker, options)));
}
