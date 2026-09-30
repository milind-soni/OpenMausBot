// The decision model's tool pick: which of a turn's connected-app and MCP
// tools this message might need, so a bot with a long tool list is not
// handed every one of them on every model call.
//
// One yes/no per tool (TOOL_PICK in jobs.ts), each described as
// "name: description", with the person's message. Only the caller's
// trimmable tools are ever asked about: OpenMausBot's own harness tools
// (agents, computer, browser, ask_user) and Composio's gateway tools are
// never offered, so they are never withheld.
//
// Acting on it: with more than 20 trimmable tools, a tool is kept when its
// probability is at least 0.2, and the 5 most likely are always kept. Past
// the contract's 120 entries, the first 120 are asked about and the rest are
// kept untouched. Any failure keeps every tool, which is what a turn does
// today. Nothing here throws.
import type { Decider } from "./index.ts";
import { perItemProbabilities, perItemQuestions, rankByProbability, TOOL_PICK } from "./jobs.ts";
import { RELAY_MAX_STATE_BYTES } from "./relay.ts";
import type { DeciderFailure } from "./types.ts";

/** Asked only with more trimmable tools than this: a short list costs
 * little to send, and trimming it saves nothing worth the wait. */
export const TOOL_PICK_MIN_TOOLS = 20;
/** Kept at this probability or above. Low on purpose: a missing tool costs
 * a turn, a spare one costs a few hundred tokens. */
export const TOOL_PICK_MIN_PROBABILITY = 0.2;
/** Always kept, whatever their probability, so a flat answer never leaves a
 * bot with nothing to call. */
export const TOOL_PICK_KEEP_TOP = 5;

const MESSAGE_MAX = 1_500;
const ENTRY_MAX = 200;
const ENTRY_MIN = 40;
/** The relay's state cap less room for JSON's own quoting, so a list of 120
 * long, non-ASCII descriptions still fits (relay.ts). */
const STATE_BUDGET_BYTES = RELAY_MAX_STATE_BYTES - 1_000;

export interface PickableTool {
  name: string;
  description: string;
}

export type ToolPick =
  /** Every name the turn keeps, asked-about or not. */
  | { kind: "keep"; names: Set<string>; asked: number }
  | { kind: "fallback"; reason: DeciderFailure | "too_few" };

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** The request for up to TOOL_PICK.maxItems tools. Entries shrink together
 * until the state fits the relay's cap. */
export function toolPickRequest(message: string, tools: readonly PickableTool[]) {
  const asked = tools.slice(0, TOOL_PICK.maxItems);
  const text = clip(message, MESSAGE_MAX);
  let entryMax = ENTRY_MAX;
  let entries = asked.map((tool) => clip(`${tool.name}: ${tool.description}`, entryMax));
  while (entryMax > ENTRY_MIN && bytes({ message: text, tools: entries }) > STATE_BUDGET_BYTES) {
    entryMax = Math.max(ENTRY_MIN, entryMax - 20);
    entries = asked.map((tool) => clip(`${tool.name}: ${tool.description}`, entryMax));
  }
  return { state: { message: text, tools: entries }, questions: perItemQuestions(TOOL_PICK, entries.length) };
}

/** Ask once and turn the answer into the names to keep. Never throws. */
export async function decideToolPick(
  decider: Pick<Decider, "ask">,
  input: { message: string; tools: readonly PickableTool[] },
  options: { signal?: AbortSignal } = {},
): Promise<ToolPick> {
  try {
    if (input.tools.length <= TOOL_PICK_MIN_TOOLS) return { kind: "fallback", reason: "too_few" };
    const { state, questions } = toolPickRequest(input.message, input.tools);
    const asked = state.tools.length;
    const result = await decider.ask("toolPick", state, questions, { timeoutMs: TOOL_PICK.timeoutMs, signal: options.signal });
    if (!result.ok) return { kind: "fallback", reason: result.reason };
    const probabilities = perItemProbabilities(TOOL_PICK, asked, result.answers);
    if (!probabilities) return { kind: "fallback", reason: "malformed" };
    const names = new Set<string>();
    const askedTools = input.tools.slice(0, asked);
    for (const tool of rankByProbability(askedTools, probabilities).slice(0, TOOL_PICK_KEEP_TOP)) names.add(tool.name);
    askedTools.forEach((tool, index) => {
      if (probabilities[index]! >= TOOL_PICK_MIN_PROBABILITY) names.add(tool.name);
    });
    // Past the contract's limit nothing was asked, so nothing is withheld.
    for (const tool of input.tools.slice(asked)) names.add(tool.name);
    return { kind: "keep", names, asked };
  } catch {
    return { kind: "fallback", reason: "malformed" };
  }
}
