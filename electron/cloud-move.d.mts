export interface MoveContents { bots: number; rooms: number; chats: number }
export interface MoveEstimate extends MoveContents { bytes: number; files: number; /** Switched on here; they arrive paused. */ routines?: number }
export interface CloudMoveStatus {
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
  progress?: { bytesTransferred: number; totalBytes: number };
  /** The Cloud had work of its own, which is backed up before it is replaced. */
  replacing?: boolean;
  /** `maxBytes`: the most the plan's disk holds, when the Admin says
   * (`largest`: the top plan); otherwise `volumeBytes`, the Cloud's disk now. */
  error?: { code: string; message: string; freeBytes?: number; neededBytes?: number; maxBytes?: number; largest?: true; volumeBytes?: number };
  /** A stopped upload keeps its archive; moving again continues it. */
  resumable?: boolean;
  moved?: MoveContents;
  previous?: boolean;
  /** Routines that were on here and arrived paused on the Cloud. */
  routines?: number;
}
export interface MoveFit { fit: "now" | "grow" | "never"; neededBytes: number; freeBytes: number; maxBytes?: number; largest?: true; volumeBytes?: number; sizeGb?: number }
/** What Settings and the Cloud's suggestion card read (main adds the parts it knows). */
export interface CloudMoveOverview extends CloudMoveState {
  local: MoveEstimate | null;
  /** Null when this app has no session on the Cloud to ask with yet. */
  cloud: Pick<CloudMoveStatus, "contents" | "empty" | "freeBytes" | "previous" | "heldBytes"> | null;
  /** Whether this computer's work fits on the Cloud (null until both are known). */
  fit?: MoveFit | null;
  /** Only on the Cloud's own page: offer to bring this computer's work. */
  suggest: boolean;
}
export interface CloudMoveBridge {
  state(): Promise<CloudMoveOverview>;
  start(): Promise<CloudMoveState>;
  cancel(): Promise<CloudMoveState>;
  restorePrevious(): Promise<CloudMoveState>;
  dismiss(): Promise<CloudMoveOverview>;
  onState(callback: (state: CloudMoveState) => void): () => void;
}

export declare const CLOUD_MOVE_MAX_BYTES: number;
export declare class CloudMoveError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>);
}
export declare function cloudPageSenderAllowed(event: unknown, context: { contents: unknown; homeOrigin: string | null | undefined; activeOrigin: string | null | undefined }): boolean;
export declare function parseMoveEstimate(value: unknown): MoveEstimate | null;
export declare function moveFit(input: { localBytes: number; freeBytes: number; uploadReceived?: number; volumeBytes?: number | null; disk?: import("./cloud-home.mjs").CloudPlanDisk | null }): MoveFit;
export declare function parseCloudMoveStatus(value: unknown): CloudMoveStatus | null;
export interface CloudMove {
  state(): CloudMoveState;
  estimate(signal?: AbortSignal): Promise<MoveEstimate>;
  move(): Promise<CloudMoveState>;
  restorePrevious(): Promise<CloudMoveState>;
  cancel(): CloudMoveState;
  reset(): CloudMoveState;
  running(): boolean;
  close(): Promise<void>;
}
export declare function createCloudMove(options: {
  localRequest(route: string, init: RequestInit): Promise<Response>;
  pairHome(): Promise<{ origin: string; code: string; expiresAt: number }>;
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
  /** The disk the person's plan has and may grow to (cloud-home.mjs cloudPlanDisk). */
  cloudDisk?: () => import("./cloud-home.mjs").CloudPlanDisk | null;
  /** Ask OMB Cloud to grow the disk now (cloud-account.mjs growDisk). */
  growCloud?: (sizeGb: number) => Promise<{ supported: boolean; refused?: boolean }>;
  growTimeoutMs?: number;
}): CloudMove;
