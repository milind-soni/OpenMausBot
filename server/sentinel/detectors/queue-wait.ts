// One issue per assignee bot: a bot whose queue keeps backing up is one problem.
import { signatureOf } from "../normalize.ts";
import type { Detector, Observation } from "../types.ts";

export const queueWait: Detector = {
  name: "queue_wait",
  detect(records, config) {
    const observations: Observation[] = [];
    for (const record of records) {
      if (record.type !== "queue" || record.waitMs <= config.queueWaitMs) continue;
      observations.push({
        kind: "queue_wait",
        signature: signatureOf("queue_wait", record.botId),
        title: `delegated work queued over ${Math.round(config.queueWaitMs / 1000)} s`,
        origin: "harness",
        severity: "medium",
        threadId: record.threadId,
        at: record.at,
        occurrence: `queue:${record.id}`,
        evidence: { source: "runtime", id: record.assignmentId },
        ...(record.botId ? { botId: record.botId } : {}),
      });
    }
    return observations;
  },
};
