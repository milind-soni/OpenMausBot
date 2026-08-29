// Client view of the named remote workers.
//
// The server never sends the SSH alias: it names a host in the operator's own
// SSH config and nothing in the renderer needs it. What arrives is the
// worker's identity plus the readiness the control plane just probed.

export type WorkerPlatform = "windows" | "macos";

export interface WorkerStatus {
  workerId: string;
  platform: WorkerPlatform;
  displayName: string;
  configured: boolean;
  state:
    | "unconfigured"
    | "offline"
    | "wrong_driver_version"
    | "no_interactive_session"
    | "locked"
    | "policy_mismatch"
    | "ready"
    | "busy"
    | "paused";
  ready: boolean;
  paused: boolean;
  lease: { botId: string; threadId: string; expiresAt: number } | null;
  errorCode: string | null;
  problem: string | null;
}

export interface WorkerSummary {
  id: string;
  platform: WorkerPlatform;
  displayName: string;
  configured: boolean;
  paused: boolean;
  status: WorkerStatus;
}

export function workerPlatformLabel(platform: WorkerPlatform): string {
  return platform === "windows" ? "Windows" : "macOS";
}

/** What to show under a worker's name in the picker. `problem` already names
 * the first thing that is actually wrong, so prefer it over a state word. */
export function workerStatusLine(worker: WorkerSummary): string {
  if (worker.status.ready) return "Ready";
  if (worker.status.lease) return "In use by another turn";
  return worker.status.problem ?? "Not ready";
}
