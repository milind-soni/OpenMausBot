import { readFile } from "node:fs/promises";
import type { EvidenceEvent } from "./types.ts";
import { isEvidenceEvent } from "./evaluation.ts";

export type TraceRecord = {
  readonly event: EvidenceEvent;
  readonly raw: unknown;
};

/** Read one or more adapter trace files and return only validated events. This
 * makes a failed live run replayable without re-running a process or endpoint. */
export async function readTrace(path: string): Promise<readonly TraceRecord[]> {
  const text = await readFile(path, "utf8");
  const records: TraceRecord[] = [];
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    const raw: unknown = JSON.parse(line);
    if (typeof raw !== "object" || raw === null) continue;
    const event: unknown = "event" in raw ? raw.event : raw;
    if (isEvidenceEvent(event)) records.push({ raw, event });
  }
  return records;
}

export async function replayTrace(path: string): Promise<readonly EvidenceEvent[]> {
  const records = await readTrace(path);
  return records.map((record) => record.event);
}
