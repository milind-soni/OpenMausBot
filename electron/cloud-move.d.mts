export interface MoveContents { bots: number; rooms: number; chats: number }
/** Which server answered: null from a server from before it said. */
export interface ServerIdentity { appVersion: string | null; environmentId: string | null }
export interface MoveEstimate extends MoveContents, Partial<ServerIdentity> { bytes: number; files: number; /** Switched on here; they arrive paused. */ routines?: number }
/** Where a copy goes: a server saved in this app, or the person's Cloud. */
export interface MoveDestination { id: string | null; name: string; origin: string | null; kind: "cloud" | "server" }
/** main's destination: how it proves the owner there, and (the Cloud only) its plan's disk. */
export interface MoveTarget extends MoveDestination {
  grant(): Promise<{ origin: string; code: string; expiresAt?: number }>;
  /** The disk the person's plan has and may grow to (cloud-home.mjs cloudPlanDisk). */
  disk?: () => import("./cloud-home.mjs").CloudPlanDisk | null;
  /** Ask OMB Cloud to grow the disk now (cloud-account.mjs growDisk). */
  grow?: (sizeGb: number) => Promise<{ supported: boolean; refused?: boolean }>;
}
/** Why a copy to a destination cannot start now (cloud-move.mjs moveBlocked). */
export type MoveBlocked = "owner_needed" | "shared_workspace" | "same_computer" | "outdated" | "unreachable" | "busy_elsewhere";
export interface CloudMoveStatus extends ServerIdentity {
  contents: MoveContents;
  empty: boolean;
  freeBytes: number;
  /** The whole volume, from a Cloud that says. */
  volumeBytes: number | null;
  previous: (MoveContents & { createdAt: string; bytes?: number }) | null;
  /** A stored part of an earlier upload, freed when the next one begins. */
  uploadReceived: number;
  /** What backups and the previous Cloud hold on the volume. */
  heldBytes: number | null;
  pendingRestore: boolean;
  busy: boolean;
  job: Record<string, unknown> | null;
  lastRestoreId: string | null;
  rolledBackId: string | null;
  partBytes: number;
}
export type CloudMovePhase = "idle" | "preparing" | "growing" | "exporting" | "uploading" | "checking" | "replacing" | "restarting" | "done" | "failed";
export interface CloudMoveState {
  phase: CloudMovePhase;
  action?: "move" | "restore";
  /** Where the current (or last) copy goes; an overview's null: this
   * computer's own page asked without naming a server. */
  destination?: MoveDestination | null;
  progress?: { bytesTransferred: number; totalBytes: number };
  /** The Cloud had work of its own, which is backed up before it is replaced. */
  replacing?: boolean;
  /** `maxBytes`: the most the plan's disk holds, when the Admin says
   * (`largest`: the top plan); otherwise `volumeBytes`, the Cloud's disk now. */
  error?: { code: string; message: string; freeBytes?: number; neededBytes?: number; maxBytes?: number; largest?: true; volumeBytes?: number; destVersion?: string; localVersion?: string;
    /** busy_elsewhere: the server a copy is running to. */ other?: string;
    /** proxy_limit: the smallest part a proxy on the way refused. */ partBytes?: number };
  /** A stopped upload keeps its archive; moving again continues it. */
  resumable?: boolean;
  moved?: MoveContents;
  previous?: boolean;
  /** Routines that were on here and arrived paused on the Cloud. */
  routines?: number;
}
export interface MoveFit { fit: "now" | "grow" | "never"; neededBytes: number; freeBytes: number; maxBytes?: number; largest?: true; volumeBytes?: number; sizeGb?: number }
/** What Settings and a server's card read (main adds the parts it knows). */
export interface CloudMoveOverview extends CloudMoveState {
  local: MoveEstimate | null;
  /** What the destination holds; null when this app has no session there to ask with yet. */
  cloud: (Pick<CloudMoveStatus, "contents" | "empty" | "freeBytes" | "previous" | "heldBytes"> & Partial<Pick<CloudMoveStatus, "appVersion">>) | null;
  /** Whether this computer's work fits there (null until both are known). */
  fit?: MoveFit | null;
  /** Only on an empty server's own page: offer to bring this computer's work. */
  suggest: boolean;
  /** Where this overview is about; null on this computer's own page without one named. */
  destination?: MoveDestination | null;
  /** Why a copy there cannot start now. */
  blocked?: MoveBlocked | null;
  /** busy_elsewhere: the server a copy is running to. */
  busyWith?: string;
}
/** `id`: a saved server's id, or "cloud"; only this computer's own page may
 * name one (a server's page is answered about itself). */
export interface CloudMoveBridge {
  state(id?: string): Promise<CloudMoveOverview>;
  start(id?: string): Promise<CloudMoveState>;
  cancel(): Promise<CloudMoveState>;
  restorePrevious(id?: string): Promise<CloudMoveState>;
  dismiss(id?: string): Promise<CloudMoveOverview>;
  onState(callback: (state: CloudMoveState) => void): () => void;
}

export declare const CLOUD_MOVE_MAX_BYTES: number;
export declare class CloudMoveError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>);
}
export declare function cloudPageSenderAllowed(event: unknown, context: { contents: unknown; homeOrigin: string | null | undefined; activeOrigin: string | null | undefined }): boolean;
export declare function moveSenderDestination(event: unknown, context: {
  contents: unknown; environments: { environments: Array<{ id: string; name: string; origin: string }>; activeId: string };
  localOrigin: string | null | undefined; cloudHomeOrigin?: string | null; id?: unknown;
}): { entry: { id: string; name: string; origin: string | null; cloud?: true } | null; remote: boolean } | null;
export declare function moveRefusal(status: number, body: unknown): MoveBlocked;
export declare function olderVersion(a: unknown, b: unknown): boolean;
export declare function moveBlocked(input: { kind: "cloud" | "server"; refusal?: MoveBlocked | null; local?: Partial<ServerIdentity> | null; cloud?: Partial<ServerIdentity> | null; busyElsewhere?: boolean }): MoveBlocked | null;
export declare function mintOwnerCode(fetchImpl: typeof fetch, origin: string, options?: { label?: string; timeoutMs?: number }): Promise<{ origin: string; code: string; expiresAt: number }>;
export declare function parseMoveEstimate(value: unknown): MoveEstimate | null;
export declare function moveFit(input: { localBytes: number; freeBytes: number; uploadReceived?: number; volumeBytes?: number | null; disk?: import("./cloud-home.mjs").CloudPlanDisk | null }): MoveFit;
export declare function parseCloudMoveStatus(value: unknown): CloudMoveStatus | null;
export interface CloudMove {
  state(): CloudMoveState;
  estimate(signal?: AbortSignal): Promise<MoveEstimate>;
  move(dest: MoveTarget, options?: { requireEmpty?: boolean }): Promise<CloudMoveState>;
  restorePrevious(dest: MoveTarget): Promise<CloudMoveState>;
  cancel(): CloudMoveState;
  reset(): CloudMoveState;
  running(): boolean;
  close(): Promise<void>;
}
export declare function createCloudMove(options: {
  localRequest(route: string, init: RequestInit): Promise<Response>;
  fetchImpl?: typeof fetch;
  tempRoot: string;
  availableBytes(path: string): Promise<number>;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onState?: (state: CloudMoveState) => void;
  retryDelaysMs?: number[];
  pollMs?: number;
  restartTimeoutMs?: number;
  jobTimeoutMs?: number;
  growTimeoutMs?: number;
}): CloudMove;
