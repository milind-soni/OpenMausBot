import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { redactSecrets, redactSecretsInText } from "./redact.ts";
import type { ProviderInstance } from "./contracts.ts";
import type { PromptCapture, PromptUsage } from "../shared/prompt-inspector.ts";

const MAX_BYTES = 4 * 1024 * 1024;
const valid = (id: string) => /^[\w-]{1,128}$/.test(id);
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export function promptUsage(value: unknown): PromptUsage | undefined {
  if (!value || typeof value !== "object") return;
  const u = value as Record<string, any>;
  const input = finite(u.input_tokens ?? u.prompt_tokens ?? u.inputTokens ?? u.input);
  const cached = finite(u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cachedInputTokens ?? u.cachedInput);
  return { input, cached, uncached: input !== null && cached !== null ? Math.max(0, input - cached) : null,
    output: finite(u.output_tokens ?? u.completion_tokens ?? u.outputTokens ?? u.output) };
}
// Only explicitly diagnostic headers are retained, never cookies, arbitrary
// provider headers or request authentication. Values still receive redaction.
export function diagnosticHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["x-request-id", "request-id", "x-trace-id", "cf-ray", "x-cache", "x-cache-status", "x-served-by", "x-region", "retry-after", "server", "via"]) {
    const value = headers.get(name);
    if (value) out[name] = redactSecretsInText(value).slice(0, 500);
  }
  return out;
}
function shallowEnough(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[nested content omitted]";
  if (Array.isArray(value)) return value.map(item => shallowEnough(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shallowEnough(v, depth + 1)]));
  return value;
}
export function safePrompt(value: unknown): unknown { return redactSecrets(shallowEnough(value)); }
type Meta = Pick<PromptCapture, "threadId" | "botId" | "turnId" | "provider"> & { epoch?: number };
export class PromptInspector {
  private epochs = new Map<string, number>();
  private active = new Set<string>();
  private rows = new Map<string, PromptCapture[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private writes = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private deletions = new Set<string>();
  private retry?: ReturnType<typeof setTimeout>;
  private folder: string;
  constructor(folder: string) {
    this.folder = folder;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    try {
      const ids: unknown = JSON.parse(readFileSync(this.journal(), "utf8"));
      if (!Array.isArray(ids) || !ids.every(id => typeof id === "string" && valid(id))) throw new Error("Invalid prompt cleanup journal");
      this.deletions = new Set(ids);
    } catch (error) { if (!this.missing(error)) throw error; }
    this.retryCleanup();
  }
  epoch(id: string) { return this.epochs.get(id) ?? 0; }
  private missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
  private file(id: string) { if (!valid(id)) throw new Error("Invalid thread"); return join(this.folder, id + ".json"); }
  private journal() { return join(this.folder, ".pending-deletions.json"); }
  private persistDeletions(next: Set<string>) {
    // This small durable journal is written before the owning conversation is
    // removed. Pending async writes can never outlive their cleanup receipt.
    const temp = this.journal() + ".tmp";
    writeFileSync(temp, JSON.stringify([...next]), { mode: 0o600 });
    renameSync(temp, this.journal());
    this.deletions = next;
  }
  private cleanup(id: string) {
    for (const suffix of ["", ".tmp"]) {
      try { unlinkSync(this.file(id) + suffix); }
      catch (error) { if (!this.missing(error)) throw error; }
    }
    if (!this.writes.has(id)) {
      const next = new Set(this.deletions); next.delete(id); this.persistDeletions(next);
    }
  }
  private retryCleanup() {
    for (const id of this.deletions) {
      if (this.writes.has(id)) continue;
      try { this.cleanup(id); } catch { /* Durable receipt remains for retry. */ }
    }
    if (this.deletions.size && !this.retry) {
      this.retry = setTimeout(() => { this.retry = undefined; this.retryCleanup(); }, 1000);
      this.retry.unref?.();
    }
  }
  read(id: string): PromptCapture[] {
    this.file(id);
    if (this.deletions.has(id)) return [];
    let rows = this.rows.get(id);
    if (!rows) {
      try { rows = JSON.parse(readFileSync(this.file(id), "utf8")); }
      catch (error) { if (!this.missing(error)) throw error; rows = []; }
      if (!Array.isArray(rows)) throw new Error("Invalid prompt capture record");
      this.rows.set(id, rows);
    }
    return rows.map(row => row.status === "sending" && !this.active.has(row.id) ? { ...row, status: "interrupted" as const } : row);
  }
  private trimCache() {
    // Finished idle threads are cheap to reload when the inspector is opened.
    // Avoid retaining an unbounded history of large request bodies in memory.
    for (const [id, rows] of this.rows) {
      if (this.rows.size <= 4) break;
      if (!this.writes.has(id) && !this.timers.has(id) && !rows.some(row => this.active.has(row.id))) this.rows.delete(id);
    }
  }
  private schedule(id: string, immediate = false) {
    this.dirty.add(id);
    if (this.writes.has(id)) return;
    const timer = this.timers.get(id);
    if (timer && !immediate) return;
    if (timer) clearTimeout(timer);
    if (immediate) { this.timers.delete(id); this.write(id); }
    else {
      const next = setTimeout(() => { this.timers.delete(id); this.write(id); }, 250);
      next.unref?.(); this.timers.set(id, next);
    }
  }
  private write(id: string) {
    if (this.writes.has(id) || this.deletions.has(id) || !this.dirty.delete(id)) return;
    const epoch = this.epoch(id);
    // Defer serialization too, so capture/header/usage/completion patches in
    // one event-loop pass coalesce. File I/O never blocks model streaming.
    const job = Promise.resolve().then(async () => {
      if (this.epoch(id) !== epoch || this.deletions.has(id)) return;
      const serialized = JSON.stringify(this.rows.get(id) ?? []);
      await writeFile(this.file(id) + ".tmp", serialized, { mode: 0o600 });
      if (this.epoch(id) === epoch && !this.deletions.has(id)) await rename(this.file(id) + ".tmp", this.file(id));
    }).catch(() => { /* Diagnostics must not change the provider outcome. */ }).finally(() => {
      this.writes.delete(id);
      if (this.deletions.has(id)) this.retryCleanup();
      else if (this.dirty.has(id)) this.write(id);
      this.trimCache();
    });
    this.writes.set(id, job);
  }
  async flush() {
    for (const [id, timer] of this.timers) { clearTimeout(timer); this.timers.delete(id); this.write(id); }
    while (this.writes.size) await Promise.all(this.writes.values());
    this.retryCleanup();
  }
  forget(threadId: string) {
    this.file(threadId);
    const ids = new Set([threadId, ...this.rows.keys(), ...readdirSync(this.folder).filter(file => /^[\w-]+\.json$/.test(file)).map(file => file.slice(0, -5))]);
    const affected = new Set([threadId]);
    for (const id of ids) if (!this.deletions.has(id) && JSON.stringify(this.read(id)).includes(threadId)) affected.add(id);
    this.persistDeletions(new Set([...this.deletions, ...affected]));
    for (const id of affected) {
      this.epochs.set(id, this.epoch(id) + 1);
      this.rows.delete(id); this.dirty.delete(id);
      clearTimeout(this.timers.get(id)); this.timers.delete(id);
    }
    // Non-ENOENT errors are visible to the deletion caller. In-flight writes
    // retain their journal entry until they settle and any late file is gone.
    try { for (const id of affected) this.cleanup(id); }
    finally { this.retryCleanup(); }
  }
  capture(meta: Meta, kind: PromptCapture["kind"], body: unknown, endpoint?: string) {
    this.file(meta.threadId);
    const epoch = this.epoch(meta.threadId);
    if (this.deletions.has(meta.threadId) || meta.epoch !== undefined && meta.epoch !== epoch) throw new Error("Conversation capture invalidated");
    const safe = safePrompt(body), serialized = JSON.stringify(safe);
    const { epoch: _epoch, ...identity } = meta;
    const row: PromptCapture = { ...identity, id: randomUUID(), kind, sentAt: new Date().toISOString(), status: "sending",
      body: Buffer.byteLength(serialized) <= MAX_BYTES ? safe : null, ...(Buffer.byteLength(serialized) > MAX_BYTES ? { omitted: true } : {}) };
    if (endpoint) { const url = new URL(endpoint); row.endpoint = url.origin + url.pathname; }
    const previous = this.read(meta.threadId);
    this.active.add(row.id);
    this.rows.set(meta.threadId, [row, ...previous].slice(0, 6));
    this.schedule(meta.threadId);
    const began = performance.now(); let done = false;
    const patch = (next: Partial<PromptCapture>) => {
      if (done || this.epoch(meta.threadId) !== epoch || this.deletions.has(meta.threadId)) return;
      const rows = this.rows.get(meta.threadId);
      if (!rows?.some(item => item.id === row.id)) return;
      Object.assign(row, next); this.schedule(meta.threadId);
    };
    return {
      patch,
      finish: (status: PromptCapture["status"], error?: string) => {
        try { patch({ status, durationMs: Math.round(performance.now() - began), ...(error ? { error: redactSecretsInText(error).slice(0, 1000) } : {}) }); }
        finally {
          done = true; this.active.delete(row.id);
          if (this.dirty.has(meta.threadId)) this.schedule(meta.threadId, true);
        }
      },
    };
  }
}

type Handle = ReturnType<PromptInspector["capture"]>;
let configured: PromptInspector | undefined;
export function configurePromptInspector(folder: string) { configured = new PromptInspector(folder); return configured; }
export function forgetPromptCaptures(threadId: string) { configured?.forget(threadId); }
const context = new AsyncLocalStorage<Meta>();
export function captureApiRequest(body: unknown, endpoint: string): Handle | undefined {
  try { const meta = context.getStore(); const handle = meta && configured?.capture(meta, "api-request", body, endpoint);
    return handle && {
      patch: (...args) => { try { handle.patch(...args); } catch {} },
      finish: (...args) => { try { handle.finish(...args); } catch {} },
    }; } catch { return; }
}
const wrapped = new WeakSet<ProviderInstance>();
export function inspectProvider(instance: ProviderInstance): ProviderInstance {
  if (wrapped.has(instance)) return instance;
  wrapped.add(instance);
  const send = instance.adapter.sendTurn.bind(instance.adapter), dispose = instance.dispose.bind(instance);
  const pending = new Map<string, () => void>();
  instance.adapter.sendTurn = async turn => {
    if (!configured || pending.has(turn.threadId)) return send(turn);
    const meta: Meta = { provider: instance.driverKind, threadId: turn.threadId, botId: turn.botId, epoch: configured.epoch(turn.threadId) };
    let capture: Handle;
    try { capture = configured.capture(meta, "agent-input", turn); } catch { return send(turn); }
    let off = () => {}, closed = false;
    const close = () => { if (closed) return; closed = true; off(); pending.delete(turn.threadId); };
    pending.set(turn.threadId, () => { try { capture.finish("interrupted"); } finally { close(); } });
    off = instance.adapter.onEvent(event => {
      if (event.threadId !== turn.threadId || meta.turnId && event.turnId !== meta.turnId) return;
      try {
        if (event.type === "turn.started") { meta.turnId = event.turnId; capture.patch({ turnId: event.turnId }); }
        if (event.type === "turn.completed") {
          if (event.usage) capture.patch({ usage: promptUsage(event.usage) });
          try { capture.finish(event.ok ? "completed" : /cancel|interrupt/.test(event.stopReason ?? "") ? "interrupted" : "failed"); } finally { close(); }
        }
      } catch { /* Diagnostics must not affect the provider. */ }
    });
    try {
      const result = await context.run(meta, () => send(turn));
      if (!closed && !meta.turnId) { meta.turnId = result.turnId; try { capture.patch({ turnId: result.turnId }); } catch {} }
      return result;
    }
    catch (error) { try { capture.finish("failed", error instanceof Error ? error.message : String(error)); } catch {} close(); throw error; }
  };
  instance.dispose = async () => { for (const cancel of pending.values()) { try { cancel(); } catch {} } await configured?.flush(); return dispose(); };
  return instance;
}
