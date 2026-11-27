// On a subscription the engine's cost figure is notional, but it still marks a turn that ran far too long.
import { signatureOf } from "../normalize.ts";
import type { Detector, Observation } from "../types.ts";

export const cost: Detector = {
  name: "cost",
  detect(records, config) {
    const observations: Observation[] = [];
    for (const record of records) {
      if (record.type !== "turn" || record.cost === null || record.cost <= config.costUsd) continue;
      observations.push({
        kind: "cost",
        signature: signatureOf("cost", record.botId),
        title: `a turn cost over $${config.costUsd}`,
        origin: "harness",
        severity: "medium",
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
