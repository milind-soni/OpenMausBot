// The status line's words for each running tool call, whatever the engine: what the call works on (its step), how a
// long one is doing (its last output, or what its processes show), and a running command's last lines of output.
import { stripVTControlCharacters } from "node:util";

import { classifyQuiet, quietNoticeMs, quietTickMs, sampleProcessTree, type ProcessSample } from "../drivers/acp/quiet-status.ts";
import { redactSecretsInText } from "../redact.ts";
import { toolStep } from "../step-summary.ts";
import { newId, type RuntimeEvent } from "../contracts.ts";
import type { StepQuiet } from "../../shared/turn-progress.ts";
import type { ProgressEvent } from "./progress-gate.ts";

type OutputEvent = Extract<RuntimeEvent, { type: "item.output" }>;

/** The least time between two frames that change only a call's output. */
export const TAIL_FRAME_MS = 1_000;
const TAIL_LINES = 2;
const TAIL_LINE_MAX = 160;
const OUTPUT_KEPT = 8 * 1024;

interface Call {
  frame: ProgressEvent;
  startedAt: number;
  output: string;
  outputAt: number | null;
  quiet?: StepQuiet;
  tail?: string[];
  sample: ProcessSample | null;
  sampledAt: number;
  sampling: boolean;
  tailSentAt: number;
  tailTimer: ReturnType<typeof setTimeout> | null;
}

export interface LiveStepsOptions {
  offer(event: ProgressEvent): void;
  /** The local process running the engine of this event's turn, when the engine has one. */
  enginePid(event: Pick<RuntimeEvent, "threadId" | "providerInstanceId">): number | undefined;
  sample?: (pid: number, since: number) => Promise<ProcessSample>;
  now?: () => number;
  noticeMs?: () => number;
  tickMs?: () => number;
}

// Security: a line that sets an environment variable (`env`, `export -p`, a printed .env) keeps the name, never the value.
const ENV_LINE = /^((?:export |declare -x |set )?[A-Za-z_][A-Za-z0-9_]*=).+$/;

/** The last lines a command printed, as a person would read them: no escape codes, a progress bar at its latest state. */
export function outputTail(output: string): string[] {
  return stripVTControlCharacters(output).split(/\r?\n/)
    .map((line) => (line.split("\r").filter((part) => part.trim()).pop() ?? "").replace(/\p{Cc}/gu, "").trim())
    .filter(Boolean)
    .slice(-TAIL_LINES)
    .map((line) => {
      const safe = redactSecretsInText(line).replace(ENV_LINE, "$1…");
      return safe.length > TAIL_LINE_MAX ? `${safe.slice(0, TAIL_LINE_MAX - 1)}…` : safe;
    });
}

function quietOf(call: Call, previous: ProcessSample | null, sinceMs: number, sample: ProcessSample): StepQuiet | undefined {
  const state = classifyQuiet({ logged: null, context: null, sample, previous, sinceMs });
  if (state.kind === "waiting-model") return { kind: "network" };
  if (state.kind === "busy") return { kind: "busy" };
  if (state.kind === "no-signs") return { kind: "idle" };
  return call.quiet;
}

const sameQuiet = (a: StepQuiet | undefined, b: StepQuiet | undefined) =>
  a?.kind === b?.kind && (a?.kind !== "output" || a.at === (b as { at?: number } | undefined)?.at);

export class LiveSteps {
  private readonly threads = new Map<string, Map<string, Call>>();
  private readonly opts: LiveStepsOptions;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: LiveStepsOptions) {
    this.opts = opts;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** A tool call starting gets its step, if it has one; a call's end, or its turn's, forgets it. */
  observe(event: RuntimeEvent, terminal: boolean): RuntimeEvent {
    if (terminal) {
      for (const call of this.threads.get(event.threadId)?.values() ?? []) this.drop(call);
      this.threads.delete(event.threadId);
      this.idleCheck();
      return event;
    }
    if (event.type === "item.completed" && event.itemType === "tool" && event.itemId) {
      const calls = this.threads.get(event.threadId);
      const call = calls?.get(event.itemId);
      if (call) this.drop(call);
      calls?.delete(event.itemId);
      if (calls?.size === 0) this.threads.delete(event.threadId);
      this.idleCheck();
      return event;
    }
    if (event.type !== "item.started" || event.itemType !== "tool" || !event.itemId) return event;
    const step = toolStep(event);
    if (!step) return event;
    let calls = this.threads.get(event.threadId);
    if (!calls) this.threads.set(event.threadId, (calls = new Map()));
    const repeated = calls.get(event.itemId);
    if (repeated) this.drop(repeated);
    const frame: ProgressEvent = {
      eventId: newId(), provider: event.provider, providerInstanceId: event.providerInstanceId, threadId: event.threadId,
      createdAt: event.createdAt, turnId: event.turnId, itemId: event.itemId, type: "turn.progress", ...step,
    };
    calls.set(event.itemId, {
      frame, startedAt: this.now(), output: "", outputAt: null, sample: null, sampledAt: 0, sampling: false, tailSentAt: 0, tailTimer: null,
    });
    this.timer ??= setInterval(() => void this.tick(), this.opts.tickMs?.() ?? quietTickMs());
    this.timer.unref?.();
    return { ...event, step };
  }

  /** The status-line frame of a call that just started, sent after the call's own start event. */
  announce(event: RuntimeEvent): void {
    const call = event.itemId ? this.threads.get(event.threadId)?.get(event.itemId) : undefined;
    if (call && event.type === "item.started") this.send(call);
  }

  /** An engine's own report about a call carries the call's step, how it is doing and its output too. */
  progress(event: ProgressEvent): ProgressEvent {
    const call = event.itemId ? this.threads.get(event.threadId)?.get(event.itemId) : undefined;
    if (!call) return event;
    const { tool: _tool, ...rest } = event;
    return { ...rest, ...this.words(call) };
  }

  output(event: OutputEvent): void {
    const call = event.itemId ? this.threads.get(event.threadId)?.get(event.itemId) : undefined;
    if (!call || !event.text || call.frame.activity !== "command") return;
    const output = event.whole ? event.text : call.output + event.text;
    call.output = output.length > OUTPUT_KEPT ? output.slice(-OUTPUT_KEPT) : output;
    call.outputAt = this.now();
    if (call.tailTimer) return;
    const wait = call.tailSentAt + TAIL_FRAME_MS - this.now();
    if (wait <= 0) {
      this.sendTail(call);
      return;
    }
    call.tailTimer = setTimeout(() => {
      call.tailTimer = null;
      this.sendTail(call);
    }, wait);
    call.tailTimer.unref?.();
  }

  private sendTail(call: Call): void {
    if (!this.tracked(call)) return;
    call.tailSentAt = this.now();
    const tail = outputTail(call.output);
    const noticed = this.now() - call.startedAt >= (this.opts.noticeMs?.() ?? quietNoticeMs());
    const quiet: StepQuiet | undefined = noticed && call.outputAt !== null ? { kind: "output", at: call.outputAt } : call.quiet;
    if (tail.join("\n") === call.tail?.join("\n") && sameQuiet(quiet, call.quiet)) return;
    call.tail = tail;
    call.quiet = quiet;
    this.send(call);
  }

  private words(call: Call): Partial<ProgressEvent> {
    const { activity, target, detail } = call.frame;
    return { activity, target, ...(detail ? { detail } : {}), ...(call.quiet ? { quiet: call.quiet } : {}), ...(call.tail?.length ? { tail: call.tail } : {}) };
  }

  private send(call: Call): void {
    this.opts.offer({ ...call.frame, eventId: newId(), createdAt: new Date(this.now()).toISOString(), ...this.words(call) });
  }

  private tracked(call: Call): boolean {
    return this.threads.get(call.frame.threadId)?.get(call.frame.itemId ?? "") === call;
  }

  private drop(call: Call): void {
    if (call.tailTimer) clearTimeout(call.tailTimer);
    call.tailTimer = null;
  }

  private idleCheck(): void {
    if (this.threads.size > 0 || !this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Each call that has run past the quiet notice gets its sign of life: its last output, else its processes' state. */
  async tick(): Promise<void> {
    const now = this.now();
    const noticeMs = this.opts.noticeMs?.() ?? quietNoticeMs();
    for (const calls of Array.from(this.threads.values())) {
      for (const call of Array.from(calls.values())) {
        if (now - call.startedAt < noticeMs || call.sampling) continue;
        const quiet = call.outputAt !== null ? { kind: "output" as const, at: call.outputAt } : await this.processQuiet(call, now);
        if (!this.tracked(call) || sameQuiet(quiet, call.quiet)) continue;
        call.quiet = quiet;
        this.send(call);
      }
    }
  }

  private async processQuiet(call: Call, now: number): Promise<StepQuiet | undefined> {
    const pid = this.opts.enginePid(call.frame);
    if (pid === undefined) return call.quiet;
    call.sampling = true;
    try {
      const sample = await (this.opts.sample ?? sampleProcessTree)(pid, call.startedAt);
      const previous = call.sample;
      const sinceMs = previous ? now - call.sampledAt : 0;
      call.sample = sample;
      call.sampledAt = now;
      return quietOf(call, previous, sinceMs, sample);
    } finally {
      call.sampling = false;
    }
  }

  /** Tests only. */
  stop(): void {
    for (const calls of this.threads.values()) for (const call of calls.values()) this.drop(call);
    this.threads.clear();
    this.idleCheck();
  }
}
