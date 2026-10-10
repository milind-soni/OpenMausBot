import type { BehaviorTrace, TraceTurn } from "./behavior-trace.ts";

/** Structural comparison of two behavior traces. Every difference becomes
 * one human-readable delta line; an empty delta means the behavior is
 * byte-for-byte stable between the two runs. */

export function diffTrace(baseline: BehaviorTrace, current: BehaviorTrace): string[] {
  const deltas: string[] = [];
  if (baseline.id !== current.id) deltas.push("id: " + baseline.id + " -> " + current.id);
  if (baseline.outcome !== current.outcome) deltas.push("outcome: " + baseline.outcome + " -> " + current.outcome);

  const turnCount = Math.max(baseline.turns.length, current.turns.length);
  for (let index = 0; index < turnCount; index += 1) {
    const want = baseline.turns[index];
    const got = current.turns[index];
    if (want === undefined) {
      const extra = got as TraceTurn;
      const tools = extra.calls.length === 0 ? "" : " (tools: " + extra.calls.map((call) => call.tool).join(", ") + ")";
      deltas.push("turn " + index + ": unexpected extra turn for " + extra.bot + tools);
      continue;
    }
    if (got === undefined) {
      const tools = want.calls.length === 0 ? "" : " (tools: " + want.calls.map((call) => call.tool).join(", ") + ")";
      deltas.push("turn " + index + ": missing turn for " + want.bot + tools);
      continue;
    }
    if (want.bot !== got.bot) deltas.push("turn " + index + ": bot " + want.bot + " -> " + got.bot);
    const callCount = Math.max(want.calls.length, got.calls.length);
    for (let call = 0; call < callCount; call += 1) {
      const wantCall = want.calls[call];
      const gotCall = got.calls[call];
      const where = "turn " + index + " (" + want.bot + ") call " + (call + 1);
      if (wantCall === undefined) {
        deltas.push(where + ": unexpected extra tool " + (gotCall as { tool: string }).tool);
        continue;
      }
      if (gotCall === undefined) {
        deltas.push(where + ": missing tool " + wantCall.tool);
        continue;
      }
      if (wantCall.tool !== gotCall.tool) deltas.push(where + ": tool " + wantCall.tool + " -> " + gotCall.tool);
      if (JSON.stringify(wantCall.argKeys) !== JSON.stringify(gotCall.argKeys)) {
        deltas.push(where + " (" + wantCall.tool + "): argKeys [" + wantCall.argKeys.join(", ") + "] -> [" + gotCall.argKeys.join(", ") + "]");
      }
      if (wantCall.errored !== gotCall.errored) deltas.push(where + " (" + wantCall.tool + "): errored " + wantCall.errored + " -> " + gotCall.errored);
    }
  }

  if (JSON.stringify(baseline.handoffs) !== JSON.stringify(current.handoffs)) {
    deltas.push(
      "handoff tree: [" + baseline.handoffs.map((node) => node.bot + ":" + node.status).join(", ") + "] -> [" +
        current.handoffs.map((node) => node.bot + ":" + node.status).join(", ") + "]",
    );
  }
  if (JSON.stringify(baseline.sends) !== JSON.stringify(current.sends)) {
    deltas.push(
      "sends: [" + baseline.sends.map((send) => send.bot + ":" + send.queued).join(", ") + "] -> [" +
        current.sends.map((send) => send.bot + ":" + send.queued).join(", ") + "]",
    );
  }
  return deltas;
}
