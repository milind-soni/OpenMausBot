import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { ChangeList } from "../shared/text-changes.ts";

export type WorkerComparison = { list: ChangeList } | { reason: "too_large" | "too_many_sentences" | "failed" | "timeout" | "busy" };

const TIMEOUT_MS = 30_000;
/** The last answer, so asking for the next page of a long list never compares again. */
const KEEP_LAST_MS = 5 * 60_000;
let running = false;
let last: { key: string; list: ChangeList; until: number } | null = null;

/** compareTexts in a worker thread of its own, so a long document never holds the server's event loop: one at a time
 * (a Cloud home may have 2 GB and a shared core), stopped after 30 seconds, and held to a small heap. With the
 * sentence limit in text-changes.ts its worst case stays well under 200 MB. */
export function compareInWorker(original: string, edited: string): Promise<WorkerComparison> {
  const key = createHash("sha256").update(original).update("\0").update(edited).digest("hex");
  if (last && last.key === key && last.until > Date.now()) return Promise.resolve({ list: last.list });
  if (running) return Promise.resolve({ reason: "busy" });
  running = true;
  last = null;
  const source = new URL("./text-changes.worker.ts", import.meta.url);
  return new Promise<WorkerComparison>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(existsSync(source) ? source : new URL("./text-changes.worker.js", import.meta.url), {
        execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 8 },
      });
    } catch {
      return resolve({ reason: "failed" });
    }
    let settled = false;
    const finish = (answer: WorkerComparison) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if ("list" in answer) last = { key, list: answer.list, until: Date.now() + KEEP_LAST_MS };
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ reason: "timeout" }), TIMEOUT_MS);
    worker.once("message", (reply: WorkerComparison) => finish(reply));
    worker.once("error", () => finish({ reason: "failed" }));
    worker.once("exit", () => finish({ reason: "failed" }));
    worker.postMessage({ original, edited });
  }).finally(() => { running = false; });
}

export function __forgetLastComparisonForTests(): void {
  last = null;
}
