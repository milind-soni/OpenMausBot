// GET and POST /api/updates/server: the Update server button in Settings → Updates, for the server's admins.

/**
 * `button`: this server can be updated from the app (a Docker Compose install with deploy/update-runner.sh on its host).
 * `command`: it cannot, or the server follows every release (OMB_UPDATE_CHANNEL=newest), which update.sh does not take;
 *   `command` is what to run on the server instead.
 * `held`: the host's own policy holds updates (`"updates": "hold"` in /etc/mausbot/policy.json).
 * `none`: updated for its owner (this computer's app, or a Cloud we run): no button and no command.
 */
export type ServerUpdateMode = "button" | "command" | "held" | "none";

/** How the last request went. `requested`: written, not yet taken by the host. `not-started`: the host never took it. */
export type ServerUpdateOutcome =
  | "requested"
  | "running"
  | "updated"
  | "unchanged"
  | "rolled-back"
  | "rollback-failed"
  | "not-changed"
  | "not-started";

/** Why an update changed nothing (`not-changed`), as the host's runner said it. */
export type ServerUpdateReason = "busy" | "refused" | "older" | "held" | "too-soon" | "no-updater" | "failed";

export interface ServerUpdateRun {
  outcome: ServerUpdateOutcome;
  reason?: ServerUpdateReason;
  /** The version that ran when the update was asked for, and the one that answers now. */
  from: string;
  to?: string;
  /** When it was asked for (ms since the epoch). */
  at: number;
}

export interface ServerUpdateStatus {
  mode: ServerUpdateMode;
  current: string;
  latest?: string;
  available: boolean;
  command?: string;
  /** What puts the version from before the last update back, run on the server by hand. */
  rollback?: string;
  /** What shows the server's own log on the host, when it does not come back. */
  logs?: string;
  /** Turns running now, which an update stops. */
  activeTurns: number;
  run?: ServerUpdateRun;
  /** A new request is refused until then (ms since the epoch). */
  retryAt?: number;
}
