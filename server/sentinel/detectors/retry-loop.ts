// Counted over the whole scan window, so a loop that spans two scans still adds up.
import { capTitle, failureKey, signatureOf, toolOrigin } from "../normalize.ts";
import type { Detector, Observation, SentinelRecord } from "../types.ts";

type ToolRecord = Extract<SentinelRecord, { type: "tool" }>;

export const retryLoop: Detector = {
  name: "retry_loop",
  detect(records, config) {
    const loops = new Map<string, { signature: string; title: string; calls: ToolRecord[] }>();
    for (const record of records) {
      if (record.type !== "tool" || record.ok || !record.turnId) continue;
      const failure = failureKey(record.tool, record.text);
      const signature = signatureOf("retry_loop", record.tool, failure.key);
      const key = `${record.turnId}\n${signature}`;
      const loop = loops.get(key) ?? { signature, title: failure.title, calls: [] };
      loop.calls.push(record);
      loops.set(key, loop);
    }
    const observations: Observation[] = [];
    for (const { signature, title, calls } of loops.values()) {
      if (calls.length < config.retryLoopMin) continue;
      const last = calls.reduce((a, b) => (b.at >= a.at ? b : a));
      const origin = toolOrigin(last.tool);
      observations.push({
        kind: "retry_loop",
        signature,
        title: capTitle(`repeated in one turn: ${title}`),
        origin,
        severity: origin === "harness" ? "high" : "medium",
        tool: last.tool,
        threadId: last.threadId,
        turnId: last.turnId!,
        at: last.at,
        occurrence: `retry:${last.turnId}:${signature}`,
        evidence: { source: "messages", id: last.id },
        ...(last.botId ? { botId: last.botId } : {}),
      });
    }
    return observations;
  },
};
