import type { ServerUpdateStatus } from "../shared/server-update";

export declare const UPDATE_ALL: Readonly<{ pollMs: number; timeoutMs: number; giveUpMs: number }>;

/** Why a saved server is left out of Update all. */
export type ServerSkipWhy = "unreachable" | "signed-out" | "up-to-date" | "admin-only" | "by-hand" | "held" | "updating" | "too-soon";
/** Why a server is left out, or why its update (or this app's) failed. */
export type UpdateAllWhy =
  | ServerSkipWhy
  /** The run ended badly as the server reports it: `status.run` says how (rolled back, not changed, not started). */
  | "run"
  /** It finished on another version than the `latest` it named. */
  | "mismatch"
  /** It stayed unreachable past the server's own cut-off for a run. */
  | "not-back"
  /** This app's download, or its install, did not finish. */
  | "download" | "install"
  | "failed";

export interface ServerSurvey {
  reach: "ok" | "unreachable" | "signed-out" | "insecure";
  check?: { current: string; latest?: string; available: boolean; command?: string; install?: string } | null;
  status?: ServerUpdateStatus | null;
  adminOnly?: boolean;
}

export type ServerPlan =
  | { updates: true; current: string; latest: string; activeTurns: number }
  | { updates: false; why: ServerSkipWhy; current?: string; latest?: string; command?: string };

export interface AppPlan { version: string | null; handoff: boolean }

export interface UpdateAllFailure { why: UpdateAllWhy; version?: string | null; command?: string; status?: ServerUpdateStatus }

export interface UpdateAllRow {
  phase: "waiting" | "updating" | "restarting" | "done" | "handed-off" | "failed";
  /** When this phase began (ms). */
  since: number;
  latest?: string;
  /** The version read back from the machine once it is done. */
  version?: string;
  failure?: UpdateAllFailure;
}

/** Rows by saved server id, and `app` for this app. */
export interface UpdateAllView { running: boolean; rows: Record<string, UpdateAllRow> }

/** What Devices learns before Update all: each saved server's plan and this app's. */
export interface UpdateAllSurvey { servers: Array<{ id: string; plan: ServerPlan }>; app: AppPlan | null; view: UpdateAllView }

export declare function surveyServer(origin: string, fetchImpl: typeof fetch, options?: { fresh?: boolean; timeoutMs?: number }): Promise<ServerSurvey>;
export declare function serverPlan(survey: ServerSurvey, now?: number): ServerPlan;
export declare function appPlan(state: { status: string; version?: string; installMode?: string } | null | undefined): AppPlan | null;
