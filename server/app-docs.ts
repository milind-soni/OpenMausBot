// Content-addressed app documents under DATA_DIR/app-docs/: html/<sha256>.html, data/<sha256>.json, file/<sha256>.bin
// (a folder page's other files), and doc/<sha256>.json, the manifest an AppPayload.doc names. A file written in the last ten minutes is never
// swept, so a document stored a moment before its row is appended cannot be lost to a sweep in between.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AppNetwork, AppSource, AppToolDefinition, AppToolResult } from "../shared/app.ts";

export const APP_DOCS_MAX_BYTES = 512 * 1024 * 1024;
export const APP_DOCS_SWEEP_GRACE_MS = 10 * 60_000;

const ID = /^[0-9a-f]{64}$/;
const KINDS = { html: ".html", data: ".json", doc: ".json", file: ".bin" } as const;
type Kind = keyof typeof KINDS;

export interface AppDocData {
  /** The stored text is a React component file (show_html `jsx`), not HTML. */
  format?: "jsx";
  /** A folder page: the file or folder it was read from, canonical, and the content id of each file beside
   * index.html by its path in the folder. */
  folder?: string;
  files?: Record<string, string>;
  tool?: AppToolDefinition;
  toolInput?: Record<string, unknown>;
  toolResult?: AppToolResult;
  network?: AppNetwork;
}

interface Manifest {
  v: 1;
  source: AppSource;
  html: string;
  data: string | null;
}

export interface StoredAppDoc {
  doc: string;
  source: AppSource;
  html: string;
  data?: AppDocData;
}

export type AppDocPut = { ok: true; doc: string; bytes: number } | { ok: false; reason: "too-large" };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export class AppDocs {
  private readonly dir: string;
  private readonly maxBytes: number;
  private used: number | null = null;

  constructor(dir: string, options: { maxBytes?: number } = {}) {
    this.dir = dir;
    this.maxBytes = options.maxBytes ?? APP_DOCS_MAX_BYTES;
  }

  private path(kind: Kind, id: string): string {
    return join(this.dir, kind, `${id}${KINDS[kind]}`);
  }

  usage(): number {
    if (this.used === null) {
      let total = 0;
      for (const kind of Object.keys(KINDS) as Kind[]) {
        for (const name of this.list(kind)) {
          try { total += statSync(join(this.dir, kind, name)).size; } catch { /* gone meanwhile */ }
        }
      }
      this.used = total;
    }
    return this.used;
  }

  private list(kind: Kind): string[] {
    try { return readdirSync(join(this.dir, kind)); } catch { return []; }
  }

  /** An existing blob's time is refreshed, so the sweep's grace covers the row about to name it. */
  private write(kind: Kind, id: string, text: string | Buffer): void {
    const target = this.path(kind, id);
    try {
      const now = new Date();
      utimesSync(target, now, now);
      return;
    } catch { /* not there yet */ }
    const before = this.usage();
    mkdirSync(join(this.dir, kind), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, target);
    this.used = before + (typeof text === "string" ? Buffer.byteLength(text) : text.byteLength);
  }

  /** A file beside a folder page's index.html, by its path in the folder; null when the document has none by that path. */
  readFile(doc: string, path: string): Buffer | null {
    const id = this.read(doc)?.data?.files?.[path];
    if (!id || !ID.test(id)) return null;
    try { return readFileSync(this.path("file", id)); } catch { return null; }
  }

  put(input: { source: AppSource; html: string; data?: AppDocData; files?: ReadonlyArray<{ path: string; data: Buffer }> }): AppDocPut {
    const html = input.html;
    const blobs = (input.files ?? []).map((file) => ({ path: file.path, data: file.data, id: createHash("sha256").update(file.data).digest("hex") }));
    const withFiles = blobs.length ? { ...input.data, files: Object.fromEntries(blobs.map((blob) => [blob.path, blob.id])) } : input.data;
    const data = withFiles ? JSON.stringify(withFiles) : null;
    const htmlId = sha256(html);
    const dataId = data === null ? null : sha256(data);
    const manifest: Manifest = { v: 1, source: input.source, html: htmlId, data: dataId };
    const manifestText = JSON.stringify(manifest);
    const doc = sha256(JSON.stringify({ html: htmlId, data: dataId }));
    const exists = (kind: Kind, id: string | null) => {
      if (id === null) return true;
      try { statSync(this.path(kind, id)); return true; } catch { return false; }
    };
    const unique = [...new Map(blobs.map((blob) => [blob.id, blob])).values()];
    const adding = unique.reduce((sum, blob) => sum + (exists("file", blob.id) ? 0 : blob.data.byteLength), 0) +
      (exists("html", htmlId) ? 0 : Buffer.byteLength(html)) +
      (exists("data", dataId) ? 0 : Buffer.byteLength(data ?? "")) +
      (exists("doc", doc) ? 0 : Buffer.byteLength(manifestText));
    if (adding > 0 && this.usage() + adding > this.maxBytes) return { ok: false, reason: "too-large" };
    for (const blob of unique) this.write("file", blob.id, blob.data);
    this.write("html", htmlId, html);
    if (data !== null && dataId !== null) this.write("data", dataId, data);
    this.write("doc", doc, manifestText);
    return { ok: true, doc, bytes: Buffer.byteLength(html) };
  }

  read(doc: string): StoredAppDoc | null {
    if (!ID.test(doc)) return null;
    try {
      const manifest = JSON.parse(readFileSync(this.path("doc", doc), "utf8")) as Manifest;
      if (manifest.v !== 1 || !ID.test(manifest.html) || (manifest.data !== null && !ID.test(manifest.data))) return null;
      if (manifest.source !== "html" && manifest.source !== "mcp") return null;
      const html = readFileSync(this.path("html", manifest.html), "utf8");
      const data = manifest.data ? JSON.parse(readFileSync(this.path("data", manifest.data), "utf8")) as AppDocData : undefined;
      return { doc, source: manifest.source, html, ...(data ? { data } : {}) };
    } catch {
      return null;
    }
  }

  sweep(referenced: Iterable<string>, now = Date.now()): number {
    const wanted = new Set([...referenced].filter((id) => ID.test(id)));
    const old = (kind: Kind, name: string) => {
      try { return now - statSync(join(this.dir, kind, name)).mtimeMs >= APP_DOCS_SWEEP_GRACE_MS; } catch { return false; }
    };
    let removed = 0;
    const remove = (kind: Kind, name: string) => {
      const file = join(this.dir, kind, name);
      try {
        const size = statSync(file).size;
        unlinkSync(file);
        removed += 1;
        if (this.used !== null) this.used = Math.max(0, this.used - size);
      } catch { /* gone meanwhile */ }
    };
    const keepHtml = new Set<string>();
    const keepData = new Set<string>();
    const keepFiles = new Set<string>();
    for (const name of this.list("doc")) {
      const id = name.slice(0, -KINDS.doc.length);
      if (name.endsWith(".tmp") || !ID.test(id) || !wanted.has(id)) {
        if (old("doc", name)) remove("doc", name);
        else if (ID.test(id)) this.keepBlobsOf(id, keepHtml, keepData, keepFiles);
        continue;
      }
      this.keepBlobsOf(id, keepHtml, keepData, keepFiles);
    }
    for (const [kind, keep] of [["html", keepHtml], ["data", keepData], ["file", keepFiles]] as const) {
      for (const name of this.list(kind)) {
        const id = name.slice(0, -KINDS[kind].length);
        if ((name.endsWith(".tmp") || !keep.has(id)) && old(kind, name)) remove(kind, name);
      }
    }
    return removed;
  }

  private keepBlobsOf(doc: string, html: Set<string>, data: Set<string>, files: Set<string>): void {
    try {
      const manifest = JSON.parse(readFileSync(this.path("doc", doc), "utf8")) as Manifest;
      if (typeof manifest.html === "string") html.add(manifest.html);
      if (typeof manifest.data === "string") {
        data.add(manifest.data);
        const named = (JSON.parse(readFileSync(this.path("data", manifest.data), "utf8")) as AppDocData).files ?? {};
        for (const id of Object.values(named)) if (typeof id === "string") files.add(id);
      }
    } catch { /* an unreadable manifest keeps nothing */ }
  }
}
