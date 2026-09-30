// Stuck check (jobs.ts, STUCK_CHECK): once the repeat detector has fired in
// a turn, is the bot actually stuck?
//
// One Yes/No. The state is the task (what the person last asked, or the
// conversation's title) and the turn's last tool steps, oldest first, each
// clipped to one line.
//
// Acting on it: yes at p >= 0.8 adds a plainer chip and a "looks stuck"
// notification. It only reports. It never stops, steers or changes a turn;
// the person has Stop. Anything less sure, and any failure, leaves today's
// repeat chip as the only word. Nothing here throws.
import type { Message } from "../store.ts";
import type { Decider } from "./index.ts";
import { STUCK_CHECK } from "./jobs.ts";
import type { DeciderFailure } from "./types.ts";

/** A yes at least this sure is reported. A false "stuck" costs the person a
 * look at a bot that was fine, so the bar is high. */
export const STUCK_MIN_PROBABILITY = 0.8;
/** How many of the latest tool steps the state carries. */
export const STUCK_RECENT_STEPS = 12;
const STEP_MAX = 300;
const TASK_MAX = 1_000;

export interface StuckCheckInput {
  task?: string;
  /** One line per tool step, oldest first. */
  steps: string[];
}

export type StuckVerdict =
  | { stuck: true; probability: number }
  | { stuck: false; reason: DeciderFailure | "not_stuck" | "no_steps" };

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The latest tool steps on a conversation's visible path, oldest first:
 * provider tool calls only (they carry an item id), not the harness's own
 * chips, each as "name: summary input". */
export function recentToolSteps(path: readonly Message[], max = STUCK_RECENT_STEPS): string[] {
  const steps: string[] = [];
  for (let index = path.length - 1; index >= 0 && steps.length < max; index--) {
    const message = path[index]!;
    const tool = message.kind === "activity" ? message.tool : undefined;
    if (!tool?.itemId) continue;
    const detail = [tool.summary, tool.input].filter((part): part is string => Boolean(part?.trim())).join(" ");
    steps.unshift(clip(detail ? `${tool.name}: ${detail}` : tool.name, STEP_MAX));
  }
  return steps;
}

/** What the person last asked on this path, for `task`. */
export function lastUserText(path: readonly Message[]): string | undefined {
  for (let index = path.length - 1; index >= 0; index--) {
    const message = path[index]!;
    if (message.role === "user" && message.kind === "text" && message.text?.trim()) return message.text;
  }
  return undefined;
}

export function stuckCheckRequest(input: StuckCheckInput) {
  const task = input.task ? clip(input.task, TASK_MAX) : "";
  const state = {
    ...(task ? { task } : {}),
    recent_steps: input.steps.slice(-STUCK_RECENT_STEPS).map((step) => clip(step, STEP_MAX)),
  };
  return { state, instructions: STUCK_CHECK.instructions };
}

/** Ask once and say whether to report the bot as stuck. Never throws. */
export async function decideStuck(
  decider: Pick<Decider, "yesNo">,
  input: StuckCheckInput,
  options: { timeoutMs?: number } = {},
): Promise<StuckVerdict> {
  try {
    const { state, instructions } = stuckCheckRequest(input);
    if (!state.recent_steps.length) return { stuck: false, reason: "no_steps" };
    const result = await decider.yesNo("stuckCheck", state, instructions, { timeoutMs: options.timeoutMs ?? STUCK_CHECK.timeoutMs });
    if (!result.ok) return { stuck: false, reason: result.reason };
    const { p } = result.answers;
    if (typeof p !== "number" || !Number.isFinite(p)) return { stuck: false, reason: "malformed" };
    return p >= STUCK_MIN_PROBABILITY ? { stuck: true, probability: p } : { stuck: false, reason: "not_stuck" };
  } catch {
    return { stuck: false, reason: "malformed" };
  }
}

/** The chip a confident "stuck" adds, under today's repeat chip. */
export function stuckChip(botName: string): string {
  return `${botName} looks stuck: repeating the same steps. Stop it or give it a hint.`;
}
