import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { redactProtectedEnvironmentValues, redactSecrets } from "./redact.ts";
import type { TelemetryTraceEnvelope } from "./telemetry-protocol.ts";

export const SOURCE_CHUNK_LIMIT = 6;
export const PRIOR_TURN_CHUNK_LIMIT = 4;
export const RETRIEVAL_CONTEXT_CHAR_LIMIT = 16_000;
export const JOURNAL_TAIL_BYTES = 1024 * 1024;

export interface RetrievalChunk {
  kind: "source" | "prior-turn";
  text: string;
  path?: string;
  repositoryId?: string;
  sourceSha?: string;
  traceId?: string;
  threadId?: string;
  score?: number;
}

export interface RetrievalResult {
  schema: "openmaus.retrieval-context.v1";
  application: "openmausbot";
  queryHash: string;
  sourceSha: string;
  chunks: RetrievalChunk[];
  sourceCount: number;
  priorTurnCount: number;
  charCount: number;
  degraded: boolean;
  warnings: string[];
}

export interface RetrieverOptions {
  dataDir: string;
  sourceSha: string;
  sourceRetrieve?: (query: string, cwd?: string, turnToken?: string) => Promise<unknown>;
  sourceTimeoutMs?: number;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function words(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []).slice(0, 500));
}

function lexicalScore(query: string, value: string): number {
  const wanted = words(query);
  if (!wanted.size) return 0;
  const present = words(value);
  let overlap = 0;
  for (const word of wanted) if (present.has(word)) overlap += 1;
  return overlap / wanted.size;
}

function tail(path: string, bytes = JOURNAL_TAIL_BYTES): string {
  if (!existsSync(path)) return "";
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const value = buffer.toString("utf8");
    return start > 0 ? value.slice(Math.max(0, value.indexOf("\n") + 1)) : value;
  } finally {
    closeSync(fd);
  }
}

function maybeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function sourceCandidates(input: unknown): RetrievalChunk[] {
  const found: RetrievalChunk[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 10 || value === null || value === undefined) return;
    if (typeof value === "string") {
      const parsed = maybeJson(value);
      if (parsed !== value) visit(parsed, depth + 1);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (row.type === "text" && typeof row.text === "string") {
      const parsed = maybeJson(row.text);
      if (parsed !== row.text) {
        visit(parsed, depth + 1);
        return;
      }
    }
    const rawText = [row.content, row.text, row.snippet, row.chunk, row.document, row.page_content]
      .find((item) => typeof item === "string" && item.trim()) as string | undefined;
    if (rawText) {
      const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : {};
      const first = (...keys: string[]): string | undefined => {
        for (const key of keys) {
          const item = row[key] ?? metadata[key];
          if (typeof item === "string" && item.trim()) return item.trim();
        }
        return undefined;
      };
      found.push({
        kind: "source",
        text: rawText,
        path: first("repository_relative_path", "relative_path", "path", "file"),
        repositoryId: first("repository_id", "repositoryId", "repo_id"),
        sourceSha: first("source_sha", "sourceSha", "repository_sha", "git_sha", "snapshot_sha"),
        score: typeof row.score === "number" ? row.score : undefined,
      });
    }
    for (const [key, child] of Object.entries(row)) {
      if (["content", "text", "snippet", "chunk", "document", "page_content", "metadata"].includes(key)) continue;
      visit(child, depth + 1);
    }
  };
  visit(input);
  return found;
}

export class OpenMausRetriever {
  private readonly options: RetrieverOptions;
  private readonly journalPath: string;

  constructor(options: RetrieverOptions) {
    this.options = options;
    this.journalPath = join(options.dataDir, "telemetry", "turns.ndjson");
  }

  private sanitize(value: string): string {
    return normalized(String(redactProtectedEnvironmentValues(redactSecrets(value))));
  }

  private priorTurns(query: string): RetrievalChunk[] {
    const rows: Array<{
      rawText: string;
      trace: TelemetryTraceEnvelope;
      score: number;
      recency: number;
    }> = [];
    for (const [index, line] of tail(this.journalPath).split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let trace: TelemetryTraceEnvelope;
      try { trace = JSON.parse(line) as TelemetryTraceEnvelope; } catch { continue; }
      if (trace.kind !== "trace" || trace.application !== "openmausbot") continue;
      const rawText = `User: ${trace.promptSummary}\nAssistant: ${trace.responseSummary}`;
      rows.push({
        recency: index,
        rawText,
        trace,
        score: lexicalScore(query, rawText),
      });
    }
    return rows
      .sort((a, b) => b.score - a.score || b.recency - a.recency)
      .slice(0, PRIOR_TURN_CHUNK_LIMIT)
      .flatMap((row): RetrievalChunk[] => {
        const text = this.sanitize(row.rawText);
        return text ? [{
          kind: "prior-turn",
          text,
          sourceSha: row.trace.sourceSha,
          traceId: row.trace.traceId,
          threadId: row.trace.threadId,
          score: row.score,
        }] : [];
      });
  }

  private async source(query: string, cwd?: string, turnToken?: string): Promise<{ chunks: RetrievalChunk[]; warnings: string[] }> {
    if (!this.options.sourceRetrieve) return { chunks: [], warnings: ["project-source retriever is not configured"] };
    const timeoutMs = this.options.sourceTimeoutMs ?? 8_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.options.sourceRetrieve(query, cwd, turnToken),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("project-source retrieval timed out")), timeoutMs);
          timer.unref?.();
        }),
      ]);
      const candidates = sourceCandidates(result);
      const exact = candidates.filter((chunk) => chunk.sourceSha === this.options.sourceSha);
      const mismatched = candidates.filter((chunk) => chunk.sourceSha && chunk.sourceSha !== this.options.sourceSha).length;
      const unidentified = candidates.filter((chunk) => !chunk.sourceSha).length;
      const warnings: string[] = [];
      if (mismatched) warnings.push(`discarded ${mismatched} project-source chunk(s) from a different source snapshot`);
      if (unidentified) warnings.push(`discarded ${unidentified} project-source chunk(s) without an exact source SHA`);
      const unique: RetrievalChunk[] = [];
      const seen = new Set<string>();
      for (const chunk of exact) {
        const key = hash(normalized(chunk.text).toLowerCase());
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(chunk);
        if (unique.length === SOURCE_CHUNK_LIMIT) break;
      }
      return { chunks: unique, warnings };
    } catch (error) {
      return { chunks: [], warnings: [error instanceof Error ? error.message : "project-source retrieval failed"] };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async retrieve(query: string, cwd?: string, turnToken?: string): Promise<RetrievalResult> {
    const cleanQuery = this.sanitize(query).slice(0, 8_000);
    const source = await this.source(cleanQuery, cwd, turnToken);
    const candidates = [...source.chunks, ...this.priorTurns(cleanQuery)];
    const deduped: RetrievalChunk[] = [];
    const seen = new Set<string>();
    let chars = 0;
    for (const candidate of candidates) {
      const text = candidate.kind === "prior-turn" ? normalized(candidate.text) : this.sanitize(candidate.text);
      const key = hash(text.toLowerCase());
      if (!text || seen.has(key)) continue;
      seen.add(key);
      const remaining = RETRIEVAL_CONTEXT_CHAR_LIMIT - chars;
      if (remaining <= 0) break;
      const clipped = text.slice(0, remaining);
      deduped.push({ ...candidate, text: clipped });
      chars += clipped.length;
    }
    const sourceCount = deduped.filter((chunk) => chunk.kind === "source").length;
    const priorTurnCount = deduped.filter((chunk) => chunk.kind === "prior-turn").length;
    return {
      schema: "openmaus.retrieval-context.v1",
      application: "openmausbot",
      queryHash: hash(cleanQuery),
      sourceSha: this.options.sourceSha,
      chunks: deduped,
      sourceCount,
      priorTurnCount,
      charCount: chars,
      degraded: source.warnings.length > 0,
      warnings: source.warnings.map((warning) => this.sanitize(warning).slice(0, 300)),
    };
  }

  format(result: RetrievalResult): string {
    if (!result.chunks.length) return "";
    const fenced = (text: string) => text.replace(/<\/?untrusted-retrieval/gi, "<\u200buntrusted-retrieval");
    const body = result.chunks.map((chunk, index) => {
      let identity = "";
      const appendIdentity = (metadata: string | undefined): void => {
        if (!metadata) return;
        identity += `${identity ? " | " : ""}${fenced(metadata)}`;
      };
      appendIdentity(chunk.repositoryId);
      appendIdentity(chunk.path);
      appendIdentity(chunk.sourceSha);
      appendIdentity(chunk.traceId);
      return `[${index + 1}] ${chunk.kind}${identity ? ` (${identity})` : ""}\n${fenced(chunk.text)}`;
    }).join("\n\n");
    return `\n\n<untrusted-retrieval schema="${result.schema}" source-sha="${result.sourceSha}">\n${body}\n</untrusted-retrieval>`;
  }
}
