import { readFileSync } from "node:fs";

import { z } from "zod";

import { CaptureMemory, type CaptureMemoryItemInput } from "./capture-memory.ts";
import { redactSecretsInText } from "./redact.ts";

/**
 * A deliberately boring interchange format for historical connected-source
 * exports. The export is produced by the connector/read-only client; this
 * module never calls a provider or accepts a credential. Keeping this format
 * explicit makes a backfill auditable and deterministic in offline installs.
 */
const recordSchema = z.object({
  sourceId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/),
  accountId: z.string().trim().max(240).optional(),
  externalId: z.string().trim().max(500).optional(),
  eventId: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,240}$/).optional(),
  kind: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(400),
  body: z.string().max(100_000).optional(),
  occurredAt: z.number().finite(),
  capturedAt: z.number().finite().optional(),
  sensitivity: z.enum(["public", "internal", "sensitive", "restricted"]).optional(),
  evidenceRef: z.string().trim().max(2_000).optional(),
  payloadRef: z.string().trim().max(2_000).optional(),
  metadata: z.json().optional(),
}).strict();

const exportSchema = z.union([
  z.array(recordSchema),
  z.object({ schemaVersion: z.literal(1).optional(), records: z.array(recordSchema).max(50_000) }).strict(),
]);
const metadataSchema = z.record(z.string(), z.json());

export type ConnectedBackfillRecord = z.infer<typeof recordSchema>;

export interface ConnectedBackfillResult {
  filesRead: number;
  recordsSeen: number;
  inserted: number;
  updated: number;
  deduplicated: number;
  ignoredTombstone: number;
  skippedFiles: number;
  skippedRecords: number;
}

function sourceAllowed(sourceId: string): boolean {
  // Grok's local corpus has its own importer. Rejecting it here prevents an
  // accidental source downgrade and keeps provenance unambiguous.
  return !sourceId.startsWith("grok-") && ![
    "anvil-bi", "chrome-history", "hevy", "local-inbox", "mercury",
    "telegram-relay", "whoop",
  ].includes(sourceId);
}

function parseExport(file: string): ConnectedBackfillRecord[] {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return []; }
  try {
    const parsed = exportSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data instanceof Array ? parsed.data : parsed.data.records;
  } catch {
    // Some connector CLIs emit one JSON object per line. Parse only complete
    // lines; malformed lines are counted as skipped records by the caller.
  }
  return raw.split(/\r?\n/).map((line) => {
    if (!line.trim()) return null;
    try {
      const parsed = recordSchema.safeParse(JSON.parse(line));
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }).filter((record): record is ConnectedBackfillRecord => record !== null);
}

function safeText(value: string | undefined, max: number): string | undefined {
  return value === undefined ? undefined : redactSecretsInText(value).slice(0, max);
}

/** Import explicit connector exports into the same deduplicating memory used
 * by live Capture. The caller owns the file selection and can run dry-run. */
export function importConnectedSourceExports(options: {
  memory: CaptureMemory;
  files: readonly string[];
  botId: string;
  sectionId: string;
  capturedAt?: number;
  dryRun?: boolean;
}): ConnectedBackfillResult {
  const result: ConnectedBackfillResult = {
    filesRead: 0, recordsSeen: 0, inserted: 0, updated: 0,
    deduplicated: 0, ignoredTombstone: 0, skippedFiles: 0, skippedRecords: 0,
  };
  const capturedAt = options.capturedAt ?? Date.now();
  for (const file of options.files) {
    result.filesRead += 1;
    const records = parseExport(file);
    if (records.length === 0) { result.skippedFiles += 1; continue; }
    for (const record of records) {
      result.recordsSeen += 1;
      if (!sourceAllowed(record.sourceId)) { result.skippedRecords += 1; continue; }
      const externalId = record.externalId ?? record.eventId;
      const evidenceRef = record.evidenceRef ?? `connected://${encodeURIComponent(record.sourceId)}/${encodeURIComponent(externalId ?? record.kind)}`;
      if (options.dryRun) continue;
      const parsedMetadata = metadataSchema.safeParse(record.metadata);
      const metadata = {
        import: "connected-source-backfill",
        sourceFile: file,
      };
      if (parsedMetadata.success) Object.assign(metadata, parsedMetadata.data);
      const item: CaptureMemoryItemInput = {
        botId: options.botId,
        sectionId: options.sectionId,
        sourceId: record.sourceId,
        kind: record.kind,
        title: safeText(record.title, 400) ?? record.title,
        occurredAt: record.occurredAt,
        capturedAt: record.capturedAt ?? capturedAt,
        sensitivity: record.sensitivity ?? "internal",
        evidenceRef,
        metadata,
      };
      const body = safeText(record.body, 100_000);
      if (record.accountId) item.accountId = record.accountId;
      if (externalId) item.externalId = externalId;
      if (record.eventId) item.eventId = record.eventId;
      if (body) item.body = body;
      if (record.payloadRef) item.payloadRef = record.payloadRef;
      const saved = options.memory.upsert(item);
      if (saved.status === "inserted") result.inserted += 1;
      else if (saved.status === "updated") result.updated += 1;
      else if (saved.status === "deduplicated") result.deduplicated += 1;
      else result.ignoredTombstone += 1;
    }
  }
  return result;
}
