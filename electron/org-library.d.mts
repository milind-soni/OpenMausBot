// The organization library channel in Electron main (contract 60 §5).
export const LIBRARY_CATALOG_MAX_BYTES: number;
export const LIBRARY_BLOB_MAX_BYTES: number;
export const LIBRARY_REPORT_MAX_BYTES: number;
export const LIBRARY_FORMAT_SUPPORTED: number;
export const LIBRARY_STATE_MESSAGE: "openmausbot:managed-library-state";

export interface OrgLibraryRelease { version: string; sha256: string; sizeBytes: number; formatVersion: number; publishedAt: number; notes: string }
export interface OrgLibraryEntry {
  packageId: string; ref: string; name: string; tagline: string; kind: "team" | "library";
  publisher: { organizationId: string; name: string; self: boolean };
  mode: "required" | "available" | "off"; offAction: "keep" | "remove";
  release: OrgLibraryRelease | null;
  withdrawnReleases: Array<{ version: string; sha256: string }>;
  contents: { bots: number; skills: number; presets: number; rooms: number; routines: number; connections: number; botNames: string[] };
  scanFindings: number;
}
export interface OrgLibraryCatalog {
  format: "openmaus.org-library"; version: 1; libraryVersion: number;
  organization: { id: string; name: string };
  truncated?: true;
  packages: OrgLibraryEntry[];
}
/** What main relays as { type: "openmausbot:managed-library", requestId, library }; null hides the shelf. */
export interface OrgLibraryRelay { adminOrigin: string; organizationId: string; organizationName: string; digest: string; catalog: OrgLibraryCatalog }
export interface OrgLibraryReportEntry {
  packageId: string; release: string; sha256: string; state: "installed" | "failed" | "removed" | "withdrawn"; edited?: boolean;
  reason?: "blob_unavailable" | "invalid_package" | "import_failed" | "newer_app_required" | "connection_refused_by_policy" | "removed_locally" | "withdrawn_by_publisher";
}
export interface OrgLibraryIdentity { portalOrigin: string; organizationId: string; deviceId: string; expiresAt: number }

export function sha256Hex(bytes: Uint8Array | string): string;
export function libraryCapability(config: unknown): boolean;
export function parseLibraryPointer(value: unknown): { version: number; digest: string } | null;
export function libraryRouteLimits(route: string): { method: "GET" | "POST"; maxBytes: number; timeoutMs: number; bodyMaxBytes?: number } | null;
/** null: a malformed envelope or another organization's catalog; keep the last good one. */
export function parseOrgLibraryCatalog(input: unknown, options?: { organizationId?: string }): OrgLibraryCatalog | null;
export function parseLibraryReportEntries(value: unknown): OrgLibraryReportEntry[] | null;
/** undefined: another message type; null: this channel's, but unusable. */
export function parseLibraryStateMessage(raw: unknown): { digest: string; packages: OrgLibraryReportEntry[] } | null | undefined;
export function createOrgLibrary(options: {
  dataDir: string;
  store: { read(): Promise<unknown>; write(value: unknown): Promise<void> };
  fetchBytes(route: string, maxBytes: number, options: { generation?: number; body?: unknown }): Promise<Uint8Array>;
  relay(library: OrgLibraryRelay | null): Promise<void>;
  appVersion?: string;
  now?(): number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  log?(message: string): void;
}): {
  restore(identity: OrgLibraryIdentity): Promise<void>;
  synchronized(input: { identity: OrgLibraryIdentity; capable: boolean | null; pointer: unknown; generation: number }): Promise<void>;
  clear(): Promise<void>;
  runtimeReady(): Promise<void>;
  receive(message: unknown): boolean;
  idle(): Promise<void>;
  close(): void;
};
