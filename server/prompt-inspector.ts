import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
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
  private folder: string;
  constructor(folder: string) { this.folder = folder; mkdirSync(folder, { recursive: true, mode: 0o700 }); }
  epoch(id: string) { return this.epochs.get(id) ?? 0; }
  private file(id: string) { if (!valid(id)) throw new Error("Invalid thread"); return join(this.folder, id + ".json"); }
  read(id: string): PromptCapture[] {
    try { const rows: PromptCapture[] = JSON.parse(readFileSync(this.file(id), "utf8")); return Array.isArray(rows) ? rows.map(row => row.status === "sending" && !this.active.has(row.id) ? { ...row, status: "interrupted" as const } : row) : []; } catch { return []; }
  }
  private save(id: string, rows: PromptCapture[]) {
    const file = this.file(id), temp = file + ".tmp";
    writeFileSync(temp, JSON.stringify(rows.slice(0, 6)), { mode: 0o600 }); renameSync(temp, file);
  }
  remove(id: string) {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    for (const suffix of ["", ".tmp"]) { try { unlinkSync(this.file(id) + suffix); } catch {} }
  }
  forget(threadId: string) {
    this.remove(threadId);
    for (const file of readdirSync(this.folder)) {
      if (!/^[\w-]+\.json$/.test(file)) continue;
      const id = file.slice(0, -5);
      if (JSON.stringify(this.read(id)).includes(threadId)) this.remove(id);
    }
  }
  capture(meta: Meta, kind: PromptCapture["kind"], body: unknown, endpoint?: string) {
    const epoch = this.epoch(meta.threadId);
    if (meta.epoch !== undefined && meta.epoch !== epoch) throw new Error("Conversation capture invalidated");
    const safe = safePrompt(body), serialized = JSON.stringify(safe);
    const { epoch: _epoch, ...identity } = meta;
    const row: PromptCapture = { ...identity, id: randomUUID(), kind, sentAt: new Date().toISOString(), status: "sending",
      body: Buffer.byteLength(serialized) <= MAX_BYTES ? safe : null, ...(Buffer.byteLength(serialized) > MAX_BYTES ? { omitted: true } : {}) };
    if (endpoint) { const url = new URL(endpoint); row.endpoint = url.origin + url.pathname; }
    this.active.add(row.id);
    try { this.save(meta.threadId, [row, ...this.read(meta.threadId)]); }
    catch (error) { this.active.delete(row.id); throw error; }
    const began = performance.now(); let done = false;
    const patch = (next: Partial<PromptCapture>) => {
      if (done || (this.epochs.get(meta.threadId) ?? 0) !== epoch) return;
      Object.assign(row, next);
      const rows = this.read(meta.threadId), index = rows.findIndex(item => item.id === row.id);
      if (index < 0) return;
      rows[index] = row; this.save(meta.threadId, rows);
    };
    return {
      patch,
      finish: (status: PromptCapture["status"], error?: string) => {
        try { patch({ status, durationMs: Math.round(performance.now() - began), ...(error ? { error: redactSecretsInText(error).slice(0, 1000) } : {}) }); }
        finally { done = true; this.active.delete(row.id); }
      },
    };
  }
}
type Handle = ReturnType<PromptInspector["capture"]>;
let configured: PromptInspector | undefined;
export function configurePromptInspector(folder: string) { configured = new PromptInspector(folder); return configured; }
export function forgetPromptCaptures(threadId: string) { try { configured?.forget(threadId); } catch {} }
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
  instance.dispose = async () => { for (const cancel of pending.values()) { try { cancel(); } catch {} } return dispose(); };
  return instance;
}
