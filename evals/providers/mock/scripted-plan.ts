import type { Scenario, ScriptedToolCall } from "../../types.ts";

/** The deterministic mock provider. This builds the room-plan file the
 * fake engine replays: every bot turn is a scripted response (tool calls,
 * text, refusals via expectError/fail) keyed by bot id, with "@key" bot
 * references resolved to the live ids the harness just created. No API
 * calls are made anywhere in an eval run; the "model" is this file. */

type BotResolver = (ref: string) => string;
type GateResolver = (gate: string) => string;

const resolveRefs = (value: unknown, resolveBot: BotResolver): unknown => {
  if (typeof value === "string" && value.startsWith("@")) return resolveBot(value.slice(1));
  if (Array.isArray(value)) return value.map((entry) => resolveRefs(entry, resolveBot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveRefs(entry, resolveBot)]));
  }
  return value;
};

export function scriptedToolCall(call: ScriptedToolCall, resolveBot: BotResolver): Record<string, unknown> {
  return {
    ...(call.tool === undefined ? {} : { tool: call.tool }),
    arguments: resolveRefs(call.arguments, resolveBot),
    ...(call.expectError === undefined ? {} : { expectError: call.expectError }),
  };
}

export function buildScriptedPlan(
  scenario: Scenario,
  resolveBot: BotResolver,
  resolveGate: GateResolver,
): Record<string, unknown> {
  const plan: Record<string, unknown> = {};
  for (const bot of scenario.bots) {
    plan[resolveBot("@" + bot.key)] = {
      turns: bot.turns.map((turn) => ({
        ...(turn.steps === undefined ? {} : { steps: turn.steps.map((call) => scriptedToolCall(call, resolveBot)) }),
        ...(turn.reply === undefined ? {} : { reply: turn.reply }),
        ...(turn.gate === undefined ? {} : { gateFile: resolveGate(turn.gate) }),
        ...(turn.delayMs === undefined ? {} : { delayMs: turn.delayMs }),
        ...(turn.fail === undefined ? {} : { fail: turn.fail }),
      })),
    };
  }
  return plan;
}
