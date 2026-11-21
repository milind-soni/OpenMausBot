import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

export type WorkerComparison = { text: string } | { reason: "too_large" | "failed" | "timeout" | "busy" };

const TIMEOUT_MS = 30_000;
const MAX_RUNNING = 2;
let running = 0;

/** compareTexts in a worker thread of its own, so a long document never holds the server's event loop; one per call,
 * at most two at once, each stopped after 30 seconds and capped in memory. */
export function compareInWorker(original: string, edited: string, start?: number): Promise<WorkerComparison> {
  if (running >= MAX_RUNNING) return Promise.resolve({ reason: "busy" });
  running += 1;
  const source = new URL("./text-changes.worker.ts", import.meta.url);
  return new Promise<WorkerComparison>((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(existsSync(source) ? source : new URL("./text-changes.worker.js", import.meta.url), {
        execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512 },
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
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ reason: "timeout" }), TIMEOUT_MS);
    worker.once("message", (reply: WorkerComparison) => finish(reply));
    worker.once("error", () => finish({ reason: "failed" }));
    worker.once("exit", () => finish({ reason: "failed" }));
    worker.postMessage({ original, edited, ...(start ? { start } : {}) });
  }).finally(() => { running -= 1; });
}
