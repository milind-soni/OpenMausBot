export type LentFolder = { id: string; path: string; name: string; write: boolean };
export type LentPlan = Map<string, { copy: true } | { copy: false; live: "too-big" | "refused" }>;
export declare function folderKey(value: string, platform: string): string;
export declare function sameFolderOn(platform: string): (a: string, b: string) => boolean;
export declare const COPY_MAX_BYTES: number;
export declare const RECHECK_MS: number;
export declare function planLentCopies(input: {
  folders: LentFolder[];
  checks: Map<string, { refusal: string | null; partial: boolean; bytes: number }>;
  copied: Set<string>;
  disk: { totalBytes: number; freeBytes: number } | null;
  planDisk?: { maxBytes: number } | null;
}): LentPlan;
export declare function copiedLent(shared: Array<{ lentId?: string; pcPath: string }>, folders: LentFolder[], sameFolder: (a: string, b: string) => boolean): Set<string>;
export declare function reconcileLent<Entry extends { lentId?: string; pcPath: string }>(input: {
  shared: Entry[]; folders: LentFolder[]; plan: LentPlan; sameFolder: (a: string, b: string) => boolean; now: number; newKey?: () => string;
}): { shared: Entry[]; dropped: Entry[] };
export declare function lentReport(input: {
  computerId: string; lendingId: string; name: string; platform: string; folders: LentFolder[]; plan: LentPlan; shared: Array<{ lentId?: string; id: string | null }>;
  git?: Map<string, { repo: string; branch: string | null; head: string | null }>;
}): { computerId: string; lendingId: string; name: string; platform?: string; folders: Array<{ id: string; name: string; write: boolean; syncId: string | null; live?: string; git?: { repo: string; branch: string | null; head: string | null } }> };
/** Lending to My Cloud as Files sees it: main's environment, its computer-sharing controller and its folder check. */
export declare function lendingForFiles(parts: {
  environment: () => unknown;
  sharing: () => unknown;
  validate: (folders: unknown[], options?: { homeEdits?: boolean }) => Promise<Array<{ id: string; path: string; name: string; write: boolean }>>;
}): {
  /** `paused`: lending is paused on this computer, so bots' changes made on My Cloud wait there. */
  now(): { lendingId: string; folders: LentFolder[]; protectedPaths: string[]; paused?: true } | { off: true } | null;
  lend(pcPath: string): Promise<LentFolder | null>;
  unlend(folderId: string): Promise<void>;
};
