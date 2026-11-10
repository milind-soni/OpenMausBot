// Training data (docs/training-data.md): while the person turns it on, each step a chat engine takes is kept as the
// request its model saw (system prompt, tool schemas, messages) and what the model answered, one JSON line per step in
// <data>/training/<day>.jsonl, and each turn's outcome after its steps. Off by default; nothing is kept while off, and
// a failure here never touches the turn. Images are left out, and every row is redacted before it is written.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { scrubHeldSecrets } from "../shared/redact.ts";
import { redactSecrets } from "./redact.ts";

export type TrainingDataMode = "off" | "local" | "share";

export const TRAINING_LIMITS = {
  dayBytes: 50 * 1024 * 1024,
  totalBytes: 500 * 1024 * 1024,
  rowBytes: 4 * 1024 * 1024,
  retentionDays: 30,
  /** Turns waiting for their outcome line; a turn that never settles stops being remembered. */
  openTurns: 500,
} as const;

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DAY_MS = 24 * 60 * 60_000;

/** The request as it was about to be sent: the runtime keeps changing its own list afterwards. */
export interface TrainingRequest {
  messages: unknown[];
  tools: unknown[];
}

export interface TrainingStepInfo {
  threadId: string;
  botId?: string;
  turnId: string;
  round: number;
  model: string;
  driverKind: string;
  /** The model runs on this computer or its network (openai-compat's localModel). */
  local: boolean;
  /** The runtime's own masking of its API key and the integrations' secrets. */
  safeText: (text: string) => string;
}

export interface TrainingCompletion {
  text: string;
  toolCalls: ReadonlyArray<{ id: string; type?: string; function: { name: string; arguments: string } }>;
  finishReason?: string | null;
  usage?: unknown;
}

export interface TrainingStepRow {
  v: 1;
  kind: "step";
  at: string;
  threadId: string;
  botId?: string;
  turnId: string;
  round: number;
  model: string;
  driverKind: string;
  local: boolean;
  tools: unknown[];
  messages: unknown[];
  completion: { role: "assistant"; content: string; tool_calls?: unknown[] };
  finishReason?: string | null;
  usage?: unknown;
}

export interface TrainingOutcomeRow {
  v: 1;
  kind: "outcome";
  at: string;
  threadId: string;
  turnId: string;
  ok: boolean;
  stopReason: string | null;
}

export type TrainingRow = TrainingStepRow | TrainingOutcomeRow;

export interface TrainingSummary {
  mode: TrainingDataMode;
  steps: number;
  turns: number;
  bytes: number;
  days: number;
  oldest: string | null;
  newest: string | null;
}

/** A message's text: image parts become a marker, the provider's reasoning echo is dropped. */
function cleanMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") return message;
  const { reasoning_content: _reasoning, reasoning: _alsoReasoning, ...rest } = message as Record<string, unknown>;
  const content = rest.content;
  if (Array.isArray(content)) {
    rest.content = content.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text"
      ? String((part as { text?: unknown }).text ?? "") : "[image]")).join("\n");
  }
  return rest;
}

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

export class TrainingLog {
  private dir: string | null = null;
  private mode: () => TrainingDataMode = () => "off";
  private now: () => number = Date.now;
  /** turnId → its thread, for turns that have steps on disk and no outcome yet. */
  private readonly open = new Map<string, string>();

  configure(options: { dir: string; mode: () => TrainingDataMode; now?: () => number }): void {
    this.dir = options.dir;
    this.mode = options.mode;
    if (options.now) this.now = options.now;
  }

  get enabled(): boolean {
    return this.dir !== null && this.mode() !== "off";
  }

  currentMode(): TrainingDataMode {
    return this.dir === null ? "off" : this.mode();
  }

  /** A copy of the request while recording, else null at no cost. */
  capture(messages: readonly unknown[], tools: readonly unknown[]): TrainingRequest | null {
    if (!this.enabled) return null;
    try {
      return { messages: messages.map((message) => JSON.parse(JSON.stringify(cleanMessage(message)))), tools: JSON.parse(JSON.stringify(tools)) };
    } catch {
      return null;
    }
  }

  step(request: TrainingRequest | null, info: TrainingStepInfo, completion: TrainingCompletion): void {
    if (!request || !this.enabled) return;
    try {
      const row: TrainingStepRow = {
        v: 1, kind: "step", at: new Date(this.now()).toISOString(), threadId: info.threadId, ...(info.botId ? { botId: info.botId } : {}),
        turnId: info.turnId, round: info.round, model: info.model, driverKind: info.driverKind, local: info.local,
        tools: request.tools, messages: request.messages,
        completion: {
          role: "assistant", content: completion.text ?? "",
          ...(completion.toolCalls.length ? { tool_calls: completion.toolCalls.map((call) => ({ id: call.id, type: "function", function: call.function })) } : {}),
        },
        ...(completion.finishReason !== undefined ? { finishReason: completion.finishReason } : {}),
        ...(completion.usage !== undefined ? { usage: completion.usage } : {}),
      };
      if (this.write(row, info.safeText)) {
        this.open.set(info.turnId, info.threadId);
        if (this.open.size > TRAINING_LIMITS.openTurns) this.open.delete(this.open.keys().next().value!);
      }
    } catch {
      // Training data is a by-product: a turn never fails because of it.
    }
  }

  /** The turn's end, after its steps: only for a turn this wrote steps for. */
  outcome(event: { threadId: string; turnId?: string; ok: boolean; stopReason?: string | null }): void {
    if (!event.turnId || !this.open.has(event.turnId) || !this.enabled) return;
    this.open.delete(event.turnId);
    try {
      this.write({ v: 1, kind: "outcome", at: new Date(this.now()).toISOString(), threadId: event.threadId, turnId: event.turnId, ok: event.ok, stopReason: event.stopReason ?? null });
    } catch { /* as above */ }
  }

  private write(row: TrainingRow, safeText: (text: string) => string = (text) => text): boolean {
    const dir = this.dir!;
    const line = `${safeText(scrubHeldSecrets(JSON.stringify(redactSecrets(row))))}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > TRAINING_LIMITS.rowBytes) return false;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${dayOf(this.now())}.jsonl`);
    let size = 0;
    try { size = statSync(file).size; } catch { /* a new day */ }
    if (size + bytes > TRAINING_LIMITS.dayBytes) return false;
    appendFileSync(file, line, { mode: 0o600 });
    return true;
  }

  /** The day files, oldest first. */
  days(): string[] {
    if (!this.dir) return [];
    try { return readdirSync(this.dir).filter((name) => DAY_FILE.test(name)).sort(); } catch { return []; }
  }

  file(day: string): string | null {
    return this.dir && DAY_FILE.test(day) ? join(this.dir, day) : null;
  }

  /** Every row of one day file; a torn last line (a write cut short) is skipped. */
  rows(day: string): TrainingRow[] {
    const file = this.file(day);
    if (!file) return [];
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { return []; }
    const rows: TrainingRow[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line) as TrainingRow); } catch { /* torn */ }
    }
    return rows;
  }

  summary(): TrainingSummary {
    const days = this.days();
    let steps = 0, bytes = 0;
    const turns = new Set<string>();
    for (const day of days) {
      try { bytes += statSync(this.file(day)!).size; } catch { /* gone */ }
      for (const row of this.rows(day)) {
        if (row.kind === "step") {
          steps++;
          turns.add(row.turnId);
        }
      }
    }
    return { mode: this.currentMode(), steps, turns: turns.size, bytes, days: days.length,
      oldest: days[0]?.slice(0, 10) ?? null, newest: days.at(-1)?.slice(0, 10) ?? null };
  }

  /** Days past retention go; then the oldest, until the folder is under its cap. */
  sweep(): void {
    const cutoff = dayOf(this.now() - TRAINING_LIMITS.retentionDays * DAY_MS);
    let days = this.days();
    for (const day of days.filter((name) => name.slice(0, 10) < cutoff)) rmSync(this.file(day)!, { force: true });
    days = this.days();
    const sizes = days.map((day) => { try { return statSync(this.file(day)!).size; } catch { return 0; } });
    let total = sizes.reduce((sum, size) => sum + size, 0);
    for (let index = 0; index < days.length - 1 && total > TRAINING_LIMITS.totalBytes; index++) {
      rmSync(this.file(days[index]!)!, { force: true });
      total -= sizes[index]!;
    }
  }

  /** Deletes every recorded row on this computer. */
  clear(): void {
    for (const day of this.days()) rmSync(this.file(day)!, { force: true });
    this.open.clear();
  }
}

export const trainingLog = new TrainingLog();
