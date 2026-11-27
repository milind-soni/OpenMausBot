/** My Cloud's disk as Files shows it: what the Cloud holds and what is free there. */
export interface CloudFilesDisk { totalBytes: number; freeBytes: number; usedBytes: number; sharedBytes: number; warn: boolean }
/**
 * One folder this computer shares with My Cloud. "copying": files are on their way (`done` of `files`); "synced": the
 * Cloud's copy matches; "waiting": My Cloud is full, `waitingBytes` wait for room; "confirm-deletes": `pendingDeletes`
 * files went from this computer at once and wait for the person's answer; "missing": the folder is not on this computer
 * (moved or renamed); "problem": `problem` says what went wrong.
 */
export type SharedFolderStatus = "copying" | "synced" | "waiting" | "confirm-deletes" | "missing" | "problem";
export interface SharedFolder {
  id: string; name: string; pcPath: string; status: SharedFolderStatus;
  files: number; done: number; waitingBytes: number; pendingDeletes: number; problem: string | null;
  /** A folder lent to My Cloud: bots use it live while this computer is on, and this copy while it is away. */
  lent?: boolean;
  /** Bots' changes from while this computer was away that met a change of the person's: theirs kept, the bot's beside it. */
  kept?: Array<{ path: string; beside: string; at: number }>;
}
export interface CloudFilesState {
  /** "unavailable": no Ready My Cloud for this app; "signed-out": sign in again; "offline": My Cloud can't be reached;
   * "asleep": My Cloud sleeps (its plan sleeps when idle), and Files carry on when it wakes. */
  phase: "unavailable" | "signed-out" | "offline" | "asleep" | "idle" | "syncing";
  lastSyncedAt: number | null;
  disk: CloudFilesDisk | null;
  shared: SharedFolder[];
  /** What Cloud bots make, kept in `dir` (Documents/MausBot): one folder per bot, one inside it per conversation. */
  outputs: { enabled: boolean; dir: string; folders: number; problem: string | null };
}
/** A folder the person picked, checked on this computer before anything is shared. `token` stands for its path in `share`. */
export interface FolderCheck {
  token: string; name: string; pcPath: string; files: number; bytes: number; partial: boolean;
  /** "private": a folder of keys or settings (.ssh, .aws, Library, AppData…), never shared. */
  refusal: null | "not-a-folder" | "too-broad" | "app-data" | "already-shared" | "private";
}
export interface CloudFilesBridge {
  state(): Promise<CloudFilesState>;
  onState(callback: (state: CloudFilesState) => void): () => void;
  /** The native folder picker, then the check. Null when the person cancels. */
  pickFolder(): Promise<FolderCheck | null>;
  /** The check for folders the app suggests (the ones that stayed on this PC after a move to My Cloud). */
  checkFolders(paths: string[]): Promise<FolderCheck[]>;
  share(token: string): Promise<CloudFilesState>;
  /** Stops sharing; My Cloud's copy goes to its trash (kept 30 days). Nothing on this computer changes. */
  stopSharing(folderId: string): Promise<CloudFilesState>;
  /** The person's answer for "confirm-deletes": remove those files from My Cloud too, or keep them there. */
  answerDeletes(folderId: string, remove: boolean): Promise<CloudFilesState>;
  /** A "missing" folder: the person shows where it is now (native picker). */
  locate(folderId: string): Promise<CloudFilesState>;
  setOutputs(enabled: boolean): Promise<CloudFilesState>;
  open(target: { folderId: string } | { outputs: true }): Promise<void>;
  /** Opens where the person gets more space for My Cloud. */
  moreSpace(): Promise<void>;
}
export declare function createCloudFilesService(options: Record<string, unknown>): {
  start(): void;
  pass(only?: Set<string> | null): Promise<void>;
  running(): boolean;
  state(): CloudFilesState;
  check(pcPath: string): Promise<Omit<FolderCheck, "token">>;
  share(pcPath: string): Promise<CloudFilesState>;
  adopt(folder: { id: string; path: string; name: string; write: boolean }): Promise<CloudFilesState>;
  lentOf(folderId: string): string | null;
  stopSharing(folderId: string): Promise<CloudFilesState>;
  answerDeletes(folderId: string, remove: boolean): Promise<CloudFilesState>;
  relocate(folderId: string, pcPath: string): Promise<CloudFilesState>;
  setOutputs(enabled: boolean): Promise<CloudFilesState>;
  localFolder(target: { folderId: string } | { outputs: true }): string | null;
  wake(): void;
  close(): void;
};
