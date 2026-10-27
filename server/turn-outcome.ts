import { errorTranscript } from "../shared/client-cancel.ts";
import { isOutboundTool } from "../shared/outbound.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { buildTurnDigest, digestTools } from "./digest.ts";
import { stopCause } from "./drivers/engine-errors.ts";
import type { TurnEvidence } from "./runtime/types.ts";
import type { Message } from "./store.ts";

const REASON_CHARS = 600;

type RuntimeError = RuntimeEvent & { type: "runtime.error" };

export interface TurnStop {
  turnId?: string;
  cause?: string;
  error?: string;
  /** The engine's own flags on that error (a setup or credit refusal, a stall, a usage limit's reset). */
  flags?: Pick<RuntimeError, "setup" | "stalled" | "trialCredit" | "limitResetsAt">;
  handoffPath?: string;
}

export class TurnStops {
  readonly #byThread = new Map<string, TurnStop>();

  note(event: RuntimeEvent): void {
    if (event.type === "turn.started") {
      this.#byThread.delete(event.threadId);
      return;
    }
    const error = event.type === "runtime.error" ? event.message
      : event.type === "item.completed" && event.itemType === "assistant_text" && event.synthetic ? event.text : undefined;
    if (event.type !== "cap.exhausted" && (error === undefined || errorTranscript(error).kind !== "error")) return;
    const stop = this.#turn(event.threadId, event.turnId);
    if (event.type === "cap.exhausted") stop.handoffPath = event.handoffPath;
    else stop.error = error;
    if (event.type === "runtime.error") {
      const { setup, stalled, trialCredit, limitResetsAt } = event;
      if (setup || stalled || trialCredit || limitResetsAt) stop.flags = { setup, stalled, trialCredit, limitResetsAt };
    }
  }

  stopping(threadId: string, turnId: string | undefined, cause: string): void {
    this.#turn(threadId, turnId).cause = cause;
  }

  #turn(threadId: string, turnId: string | undefined): TurnStop {
    const held = this.#byThread.get(threadId);
    const stop: TurnStop = held && held.turnId === turnId ? held : { turnId };
    this.#byThread.set(threadId, stop);
    return stop;
  }

  read(threadId: string, turnId?: string): TurnStop | undefined {
    const stop = this.#byThread.get(threadId);
    return stop && (!turnId || !stop.turnId || stop.turnId === turnId) ? stop : undefined;
  }

  /** The turn's own last error, else the provider's stop reason in words; undefined for a turn that did not fail. */
  failureCause(event: { threadId: string; turnId?: string; ok: boolean; stopReason?: string | null }): string | undefined {
    if (event.ok) return undefined;
    return this.read(event.threadId, event.turnId)?.error ?? stopCause(event.stopReason);
  }

  forget(threadId: string): void {
    this.#byThread.delete(threadId);
  }
}

/** Cause first (a chip shows only the start), then the last message quoted as data, so a teammate's words never pass for the harness's. */
export function stoppedTurnOutcome(input: {
  reason: string;
  activities: readonly Message[];
  turnId?: string;
  said?: string;
}): string {
  const parts = [sentence(clip(input.reason, REASON_CHARS))];
  if (input.turnId) {
    const digest = buildTurnDigest({
      turnId: input.turnId, botId: "", threadId: "", at: 0, durationMs: 0,
      activities: input.activities, memory: [], reply: "", hookCoverage: "preview",
    });
    parts.push(digest.toolCalls
      ? `Before it stopped it made ${digest.toolCalls} tool call${digest.toolCalls === 1 ? "" : "s"}: ${digestTools(digest)}.`
      : "No tool calls were seen before it stopped.");
  }
  const said = input.said?.trim();
  return said ? `${parts.join(" ")}\nIts last message, quoted: ${JSON.stringify(said)}` : parts.join(" ");
}

const SHELL_TOOL = /^(?:mcp__[\w-]+?__)?(?:bash|shell|exec|run_command|execute_command|run_shell_command|run_terminal_cmd|terminal|COMPOSIO_REMOTE_BASH_TOOL)$/i;
const GIT_OUTWARD = /\bgit\s+(commit|push)\b/g;
const MONEY_OUTWARD = /\b(pay|payment|charge|refund|transfer)\b/gi;
const ERROR_CHARS = 200;
const ERRORS_KEPT = 3;

const toolRows = (rows: readonly Message[]) =>
  rows.filter((row) => row.role === "bot" && row.kind === "activity" && row.tool !== undefined);

/** The one outward-action classifier: the restart policy uses it so a cut turn that already acted never reruns. */
export function outwardActions(rows: readonly Message[]): string[] {
  const labels: string[] = [];
  const add = (label: string) => { if (!labels.includes(label)) labels.push(label); };
  for (const row of toolRows(rows)) {
    const tool = row.tool!;
    if (tool.ok === false) continue;
    if (isOutboundTool(tool.name)) { add(tool.name); continue; }
    if (!SHELL_TOOL.test(tool.name)) continue;
    const command = [tool.input, tool.summary].filter((text): text is string => typeof text === "string").join("\n");
    for (const git of command.matchAll(GIT_OUTWARD)) add(`git ${git[1]}`);
    for (const money of command.matchAll(MONEY_OUTWARD)) add(money[1]!.toLowerCase());
  }
  return labels;
}

export function turnEvidence(rows: readonly Message[]): TurnEvidence {
  const tools = toolRows(rows);
  const errors = tools.filter((row) => row.tool!.ok === false).map((row) => {
    const tool = row.tool!;
    const output = tool.itemId && typeof tool.output === "string" ? tool.output.split("\n").find((line) => line.trim()) : undefined;
    return clip(output ? `${tool.name}: ${output}` : tool.name, ERROR_CHARS);
  }).slice(-ERRORS_KEPT);
  const okToolCalls = tools.filter((row) => row.tool!.ok !== false && row.tool!.itemId !== undefined).length;
  const outward = outwardActions(rows);
  return { toolCalls: tools.filter((row) => row.tool!.itemId !== undefined).length, okToolCalls, errors, ...(outward.length ? { outward } : {}) };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function sentence(text: string): string {
  const capital = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  return /[.!?…"]$/.test(capital) ? capital : `${capital}.`;
}
