import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";

import { z } from "zod";

import { CaptureMemory, type CaptureMemorySensitivity } from "./capture-memory.ts";
import type { JsonValue } from "./schema.ts";

const corpusRootSchema = z.object({
  value: z.object({ entries: z.array(z.unknown()) }),
});

const corpusEntrySchema = z.object({
  id: z.string().optional(),
  kind: z.string().optional(),
  role: z.string().optional(),
  content: z.string().optional(),
  timestampMs: z.number().finite().optional(),
  message: z.object({ content: z.string().optional() }).passthrough().optional(),
  event: z.object({ type: z.string().optional() }).passthrough().optional(),
  fromAgent: z.object({ name: z.string().optional() }).passthrough().optional(),
  toAgent: z.object({ name: z.string().optional() }).passthrough().optional(),
}).passthrough();

export interface GrokCorpusRecord {
  sourceId: "grok-corpus" | "grok-bot-os";
  externalId: string;
  kind: string;
  title: string;
  body: string;
  occurredAt: number;
  capturedAt: number;
  sensitivity: CaptureMemorySensitivity;
  evidenceRef: string;
  metadata: JsonValue;
}

export interface GrokCorpusImportResult {
  filesRead: number;
  recordsSeen: number;
  inserted: number;
  updated: number;
  deduplicated: number;
  ignoredTombstone: number;
  skippedFiles: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cleanText(value: string, max: number): string {
  return value.replaceAll("\u0000", "").replaceAll("\r\n", "\n").trim().slice(0, max);
}

function firstLine(value: string): string {
  return cleanText(value.split("\n").find((line) => line.trim()) ?? "", 240);
}

function titleFor(kind: string, role: string | undefined, body: string): string {
  const speaker = role?.trim() || kind || "entry";
  const summary = firstLine(body) || "Grok event";
  return cleanText(`${speaker}: ${summary}`, 400);
}

function entryBody(entry: z.infer<typeof corpusEntrySchema>): string | null {
  const content = entry.content ?? entry.message?.content;
  if (typeof content === "string" && content.trim()) return cleanText(content, 100_000);
  if (entry.event?.type === "automation-changed") {
    return cleanText(JSON.stringify(entry.event), 100_000);
  }
  return null;
}

function entryMetadata(
  entry: z.infer<typeof corpusEntrySchema>,
  sourceFile: string,
  relativeFile: string,
): JsonValue {
  return {
    import: "grok-desktop-corpus",
    sourceFile,
    relativeFile,
    entryId: entry.id ?? null,
    entryKind: entry.kind ?? null,
    role: entry.role ?? null,
    fromAgent: entry.fromAgent?.name ?? null,
    toAgent: entry.toAgent?.name ?? null,
  };
}

export function recordsFromGrokBlob(file: string, root: string, capturedAt = Date.now()): GrokCorpusRecord[] {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const parsedRoot = corpusRootSchema.safeParse(parsedJson);
  if (!parsedRoot.success) return [];
  const relativeFile = relative(root, file).replaceAll("\\", "/");
  const fallbackTime = statSync(file).mtimeMs;
  const records: GrokCorpusRecord[] = [];
  for (let index = 0; index < parsedRoot.data.value.entries.length; index += 1) {
    const parsedEntry = corpusEntrySchema.safeParse(parsedRoot.data.value.entries[index]);
    if (!parsedEntry.success) continue;
    const body = entryBody(parsedEntry.data);
    if (!body) continue;
    const kind = cleanText(parsedEntry.data.kind ?? "message", 64) || "message";
    const stableEntry = parsedEntry.data.id ?? `${index}:${sha256(body).slice(0, 20)}`;
    records.push({
      sourceId: "grok-corpus",
      externalId: `blob:${sha256(relativeFile).slice(0, 24)}:${sha256(stableEntry).slice(0, 24)}`,
      kind,
      title: titleFor(kind, parsedEntry.data.role, body),
      body,
      occurredAt: parsedEntry.data.timestampMs ?? fallbackTime,
      capturedAt,
      sensitivity: "sensitive",
      evidenceRef: file,
      metadata: entryMetadata(parsedEntry.data, file, relativeFile),
    });
  }
  return records;
}

export function recordFromMarkdown(file: string, root: string, capturedAt = Date.now()): GrokCorpusRecord | null {
  const body = cleanText(readFileSync(file, "utf8"), 100_000);
  if (!body) return null;
  const relativeFile = relative(root, file).replaceAll("\\", "/");
  const heading = body.match(/^#\s+(.+)$/m)?.[1];
  const title = cleanText(heading ?? basename(file, extname(file)), 400);
  const sensitivity: CaptureMemorySensitivity = /living-brief|practice\/current|capture\//i.test(relativeFile)
    ? "sensitive"
    : "internal";
  return {
    sourceId: "grok-bot-os",
    externalId: `markdown:${sha256(relativeFile).slice(0, 40)}`,
    kind: "source-document",
    title,
    body,
    occurredAt: statSync(file).mtimeMs,
    capturedAt,
    sensitivity,
    evidenceRef: file,
    metadata: {
      import: "grok-bot-os",
      sourceFile: file,
      relativeFile,
      datedSource: true,
    },
  };
}

function corpusFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && [".blob", ".md"].includes(extname(entry.name).toLowerCase())) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

export function importGrokCorpus(options: {
  memory: CaptureMemory;
  roots: readonly string[];
  botId: string;
  sectionId: string;
  capturedAt?: number;
  dryRun?: boolean;
}): GrokCorpusImportResult {
  const capturedAt = options.capturedAt ?? Date.now();
  const result: GrokCorpusImportResult = {
    filesRead: 0,
    recordsSeen: 0,
    inserted: 0,
    updated: 0,
    deduplicated: 0,
    ignoredTombstone: 0,
    skippedFiles: 0,
  };
  for (const root of options.roots) {
    let files: string[];
    try {
      files = corpusFiles(root);
    } catch {
      result.skippedFiles += 1;
      continue;
    }
    for (const file of files) {
      result.filesRead += 1;
      const extension = extname(file).toLowerCase();
      const records = extension === ".blob"
        ? recordsFromGrokBlob(file, root, capturedAt)
        : [recordFromMarkdown(file, root, capturedAt)].filter((record): record is GrokCorpusRecord => record !== null);
      if (records.length === 0) {
        result.skippedFiles += 1;
        continue;
      }
      for (const record of records) {
        result.recordsSeen += 1;
        if (options.dryRun) continue;
        const saved = options.memory.upsert({
          botId: options.botId,
          sectionId: options.sectionId,
          sourceId: record.sourceId,
          accountId: "local-grok",
          externalId: record.externalId,
          kind: record.kind,
          title: record.title,
          body: record.body,
          occurredAt: record.occurredAt,
          capturedAt: record.capturedAt,
          sensitivity: record.sensitivity,
          evidenceRef: record.evidenceRef,
          metadata: record.metadata,
        });
        if (saved.status === "inserted") result.inserted += 1;
        else if (saved.status === "updated") result.updated += 1;
        else if (saved.status === "deduplicated") result.deduplicated += 1;
        else result.ignoredTombstone += 1;
      }
    }
  }
  return result;
}
