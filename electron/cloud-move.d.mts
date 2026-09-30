export interface MoveContents { bots: number; rooms: number; chats: number }
export interface MoveEstimate extends MoveContents { bytes: number; files: number }
export interface CloudMoveStatus {
  contents: MoveContents;
  empty: boolean;
  freeBytes: number;
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
export type CloudMovePhase = "idle" | "preparing" | "exporting" | "uploading" | "checking" | "replacing" | "restarting" | "done" | "failed";
export interface CloudMoveState {
  phase: CloudMovePhase;
  action?: "move" | "restore";
  progress?: { bytesTransferred: number; totalBytes: number };
  /** The Cloud had work of its own, which is backed up before it is replaced. */
  replacing?: boolean;
  error?: { code: string; message: string; freeBytes?: number; neededBytes?: number };
  /** A stopped upload keeps its archive; moving again continues it. */
  resumable?: boolean;
  moved?: MoveContents;
  previous?: boolean;
}
/** What Settings and the Cloud's suggestion card read (main adds the parts it knows). */
export interface CloudMoveOverview extends CloudMoveState {
  local: MoveEstimate | null;
  /** Null when this app has no session on the Cloud to ask with yet. */
  cloud: Pick<CloudMoveStatus, "contents" | "empty" | "freeBytes" | "previous" | "heldBytes"> | null;
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
}): CloudMove;
