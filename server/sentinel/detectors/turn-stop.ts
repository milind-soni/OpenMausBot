// Stops the person asked for are not failures.
import { capTitle, HARNESS_NOTICE, normalizeSignatureText, signatureOf } from "../normalize.ts";
import type { Detector, Observation, Origin } from "../types.ts";
import { isServerLine } from "../../server-lines.ts";

export const TURN_TIMEOUT_NOTICE = /\b(?:exceeded|made no progress for) \d+ minutes?\b/i;
/** A stopped room turn's row, as written before rows were in the room's language, or in any language now. */
export function isTurnTimeoutNotice(text: string): boolean {
  return TURN_TIMEOUT_NOTICE.test(text) || isServerLine("server.rooms.turnStalled.one", text) || isServerLine("server.rooms.turnStalled.many", text);
}

const PERSON_STOPS = new Set(["interrupted", "cancelled"]);
/** Settled ok, but out of budget rather than done. */
const BUDGET_STOPS = new Set(["max_tokens", "max_turns"]);
/** The provider or the account, not OpenMausBot. */
const ACCOUNT_STOPS = new Set(["auth_required", "quota", "update_required", "setup_required", "provider_safety"]);

export const turnStop: Detector = {
  name: "turn_stop",
  detect(records) {
    const observations: Observation[] = [];
    for (const record of records) {
      if (record.type === "tool" && record.tool === HARNESS_NOTICE && isTurnTimeoutNotice(record.text)) {
        const text = normalizeSignatureText(record.text);
        observations.push({
          kind: "turn_timeout",
          signature: signatureOf("turn_timeout", text),
          title: capTitle(text),
          origin: "harness",
          severity: "medium",
          threadId: record.threadId,
          at: record.at,
          occurrence: `tool:${record.id}`,
          evidence: { source: "messages", id: record.id },
          ...(record.botId ? { botId: record.botId } : {}),
          ...(record.turnId ? { turnId: record.turnId } : {}),
        });
        continue;
      }
      if (record.type !== "turn") continue;
      const reason = record.stopReason ?? "none";
      if (PERSON_STOPS.has(reason)) continue;
      if (record.ok && !BUDGET_STOPS.has(reason)) continue;
      const kind = /time(d_?)?out/i.test(reason) ? "turn_timeout" : "turn_stop";
      const origin: Origin = ACCOUNT_STOPS.has(reason) ? "external" : "harness";
      observations.push({
        kind,
        signature: signatureOf(kind, reason),
        title: capTitle(record.ok ? `turn stopped on its budget: ${reason}` : `turn failed: ${reason}`),
        origin,
        severity: origin === "harness" && !record.ok ? "high" : "medium",
        threadId: record.threadId,
        at: record.at,
        occurrence: `turn:${record.id}`,
        evidence: { source: "events", id: record.id },
        ...(record.botId ? { botId: record.botId } : {}),
        ...(record.turnId ? { turnId: record.turnId } : {}),
      });
    }
    return observations;
  },
};
