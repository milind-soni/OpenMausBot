import { isHeldMemberLine } from "../../room-holds.ts";
import { failureKey, HARNESS_NOTICE, signatureOf, toolOrigin } from "../normalize.ts";
import type { Detector, Observation, Origin, Severity } from "../types.ts";
import { isTurnTimeoutNotice } from "./turn-stop.ts";

export const SEVERITY_BY_ORIGIN: Record<Origin, Severity> = { harness: "high", external: "medium", shell: "low" };

export const toolError: Detector = {
  name: "tool_error",
  detect(records) {
    const observations: Observation[] = [];
    for (const record of records) {
      if (record.type !== "tool" || record.ok) continue;
      // a stopped room turn is turn_timeout's, not a tool's
      if (record.tool === HARNESS_NOTICE && isTurnTimeoutNotice(record.text)) continue;
      // a member the person held on purpose is not a failure: a status row reaches here as a harness notice with its words
      if (isHeldMemberLine(record.tool) || (record.tool === HARNESS_NOTICE && isHeldMemberLine(record.text))) continue;
      const origin = toolOrigin(record.tool);
      const { key, title } = failureKey(record.tool, record.text);
      observations.push({
        kind: "tool_error",
        signature: signatureOf("tool_error", record.tool, key),
        title,
        origin,
        severity: SEVERITY_BY_ORIGIN[origin],
        tool: record.tool,
        threadId: record.threadId,
        at: record.at,
        occurrence: `tool:${record.id}`,
        evidence: { source: "messages", id: record.id },
        ...(record.botId ? { botId: record.botId } : {}),
        ...(record.turnId ? { turnId: record.turnId } : {}),
      });
    }
    return observations;
  },
};
