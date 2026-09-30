// Risk check (jobs.ts, RISK_CHECK): before Full access answers a permission
// request for the person, how risky is running it unchecked?
//
// One Score over the contract's three levels (Low, Medium, High). The state
// is the action (tool, its one-line summary, the exact command and the
// tool's input preview, each clipped) and the conversation's task.
//
// Acting on it: High at p >= 0.6 holds the request for the person instead of
// approving it. That is the only thing this job can do. It never approves,
// never answers a card, and is only asked about a request the app was about
// to approve on its own; anything less sure, and any failure at all, lets
// the approval go ahead exactly as it did before. Nothing here throws.
import { isReadOnlyAgentTool } from "../agent-tool-policy.ts";
import type { Decider } from "./index.ts";
import { RISK_CHECK } from "./jobs.ts";
import type { DeciderFailure } from "./types.ts";

/** A High answer at least this sure holds the request. */
export const RISK_HOLD_MIN_PROBABILITY = 0.6;
/** The level whose probability decides: "High", last of the three. */
const HIGH = 2;

const TOOL_MAX = 200;
const SUMMARY_MAX = 500;
const COMMAND_MAX = 2_000;
const INPUT_MAX = 2_000;
const TASK_MAX = 500;
/** The built-in agents integration's MCP prefix. Its read-only tools arrive
 * under it on engines that namespace MCP tools (Claude, Codex). */
const AGENTS_PREFIX = "mcp__agents__";

export interface RiskCheckInput {
  tool: string;
  summary: string;
  /** The exact shell command, when the request carries one. */
  command?: string;
  /** The tool's bounded, redacted input preview, when one was shown. */
  input?: string;
  /** The conversation's title, or what the person asked for. */
  task?: string;
}

export type RiskVerdict =
  | { hold: true; probability: number }
  | { hold: false; reason: DeciderFailure | "low_risk" | "read_only" };

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Keeps its line breaks: a multi-line command reads differently flattened. */
function clipBlock(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** Tools reviewed as read-only (agent-tool-policy.ts), by their exact name
 * or under the built-in agents prefix. These never ask: a read waits on
 * nothing. Any other name, however it reads, is asked about. */
export function riskCheckSkips(tool: string): boolean {
  if (isReadOnlyAgentTool(tool)) return true;
  return tool.startsWith(AGENTS_PREFIX) && isReadOnlyAgentTool(tool.slice(AGENTS_PREFIX.length));
}

export function riskCheckRequest(input: RiskCheckInput) {
  const command = input.command ? clipBlock(input.command, COMMAND_MAX) : "";
  const preview = input.input ? clipBlock(input.input, INPUT_MAX) : "";
  const task = input.task ? clip(input.task, TASK_MAX) : "";
  const state = {
    action: {
      tool: clip(input.tool, TOOL_MAX),
      summary: clip(input.summary, SUMMARY_MAX),
      ...(command ? { command } : {}),
      ...(preview ? { input: preview } : {}),
    },
    ...(task ? { task } : {}),
  };
  return { state, question: { instructions: RISK_CHECK.instructions, levels: [...RISK_CHECK.levels!] } };
}

/** Ask once and say whether to hold. Never throws; `hold: false` means
 * approve as today. */
export async function decideRiskHold(
  decider: Pick<Decider, "score">,
  input: RiskCheckInput,
  options: { timeoutMs?: number } = {},
): Promise<RiskVerdict> {
  try {
    if (riskCheckSkips(input.tool)) return { hold: false, reason: "read_only" };
    const { state, question } = riskCheckRequest(input);
    const result = await decider.score("riskCheck", state, question, { timeoutMs: options.timeoutMs ?? RISK_CHECK.timeoutMs });
    if (!result.ok) return { hold: false, reason: result.reason };
    const { probabilities } = result.answers;
    const high = probabilities?.[HIGH];
    if (!Array.isArray(probabilities) || probabilities.length !== question.levels.length || typeof high !== "number" || !Number.isFinite(high)) {
      return { hold: false, reason: "malformed" };
    }
    return high >= RISK_HOLD_MIN_PROBABILITY ? { hold: true, probability: high } : { hold: false, reason: "low_risk" };
  } catch {
    return { hold: false, reason: "malformed" };
  }
}
