import type { Readable } from "node:stream";
import type { WorkspaceBackupClientState, WorkspaceBackupSummary } from "../shared/workspace-backup.ts";

export interface CompanyBackupProgress {
  phase: "exporting" | "reading" | "uploading" | "completing" | "downloading" | "validating" | "preparing" | "ready";
  bytesTransferred: number;
  /** Zero while the local exporter has not returned its archive size. */
  totalBytes: number;
}
export interface CompanyBackupMetadata {
  passwordRequired: boolean;
  id: string; status: "ready"; sizeBytes: number; sha256: string;
  appVersion?: string; createdAt?: number; completedAt?: number;
}
export interface CompanyBackupRequestInit extends Omit<RequestInit, "body"> {
  body?: BodyInit | Readable;
  duplex?: "half";
}
export interface CompanyBackupTransferOptions {
  /** Root attaches trusted desktop credentials; these must never be reused for R2. */
  localRequest: (path: string, init: CompanyBackupRequestInit) => Promise<Response>;
  portalRequest: (path: string, init: { method: string; body?: unknown; signal?: AbortSignal }) => Promise<unknown>;
  tempRoot: string;
  fetchImpl?: (url: string, init: CompanyBackupRequestInit) => Promise<Response>;
  /** Disposable loopback test servers only; never enable for packaged clients. */
  allowLoopbackForTests?: boolean;
  /** Defaults to statfs on the transfer volume. Can check workspace volume too. */
  availableBytes?: (path: string) => Promise<number>;
}
export class CompanyBackupError extends Error { code: string; constructor(code: string, message: string); }
export function createCompanyBackups(options: CompanyBackupTransferOptions): {
  backup(input: { clientState?: WorkspaceBackupClientState; appVersion?: string }, signal?: AbortSignal, onProgress?: (progress: CompanyBackupProgress) => void): Promise<CompanyBackupMetadata>;
  /** Verifies and previews only. Explicit replacement remains a separate local operation. */
  prepareRestore(input: { id: string; password?: string }, signal?: AbortSignal, onProgress?: (progress: CompanyBackupProgress) => void): Promise<{ id: string; summary: WorkspaceBackupSummary }>;
};
