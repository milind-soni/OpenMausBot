import type { ScenarioResult } from "../../scorers/snapshot.ts";

/** The normalized behavior trace one scenario run leaves behind: the
 * stable, release-diffable summary of what the harness did. Argument
 * values are deliberately absent (they are scenario data); the trace pins
 * the tool sequence, the argument key shape, error outcomes, dispatch
 * tree, send admission, and the overall assertion outcome. */

export interface TraceTurn {
  bot: string;
  index: number;
  calls: Array<{ tool: string; argKeys: string[]; errored: boolean }>;
}

export interface BehaviorTrace {
  id: string;
  turns: TraceTurn[];
  handoffs: Array<{ bot: string; status: string; hasParent?: boolean }>;
  sends: Array<{ bot: string; queued: boolean | undefined }>;
  outcome: "pass" | "fail";
}

export function behaviorTrace(result: ScenarioResult): BehaviorTrace {
  return {
    id: result.id,
    turns: result.evidence.turns.map((turn) => ({
      bot: turn.bot,
      index: turn.index,
      calls: turn.toolCalls.map((call) => ({
        tool: call.tool,
        argKeys: Object.keys(call.arguments).sort(),
        errored: call.errored,
      })),
    })),
    handoffs: result.evidence.handoffs.map((node) => ({
      bot: node.bot,
      status: node.status,
      ...(node.hasParent === undefined ? {} : { hasParent: node.hasParent }),
    })),
    sends: result.evidence.sends.map((send) => ({ bot: send.bot, queued: send.queued })),
    outcome: result.pass ? "pass" : "fail",
  };
}
