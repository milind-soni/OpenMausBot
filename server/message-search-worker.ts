import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { SearchHit } from "./message-search-query.ts";

export class SearchUnavailable extends Error {
  readonly status = 503;
}

/** One read-only worker, not a worker per keystroke. Bound outstanding scans
 * so a burst of searches cannot build an unbounded queue behind the database. */
export class MessageSearchWorker {
  private worker: Worker | undefined;
  private stopping: Promise<void> = Promise.resolve();
  private sequence = 0;
  private readonly pending = new Map<number, {
    resolve: (hits: SearchHit[]) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private readonly file: string;
  private readonly timeoutMs: number;
  constructor(file: string, timeoutMs = 30_000) {
    this.file = file;
    this.timeoutMs = timeoutMs;
  }

  search(query: string, limit: number, threadId?: string): Promise<SearchHit[]> {
    if (this.pending.size >= 8) return Promise.reject(new SearchUnavailable("Search is busy. Try again shortly."));
    if (!this.worker) {
      const source = new URL("./message-search.worker.ts", import.meta.url);
      const worker = new Worker(existsSync(source) ? source : new URL("./message-search.worker.js", import.meta.url), {
        workerData: { file: this.file },
        // Do not inherit test loaders or inspector ports into the worker.
        execArgv: [],
      });
      this.worker = worker;
      worker.on("message", (reply: { id: number; hits?: SearchHit[]; failed?: boolean }) => {
        if (this.worker !== worker) return;
        const request = this.pending.get(reply.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(reply.id);
        if (reply.failed) request.reject(new SearchUnavailable("Search could not finish. Try again shortly."));
        else request.resolve(reply.hits ?? []);
        if (!this.pending.size) worker.unref();
      });
      worker.on("error", () => {
        if (this.worker === worker) void this.close();
      });
      worker.on("exit", () => {
        if (this.worker === worker) void this.close();
      });
    }
    const worker = this.worker;
    worker.ref();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.close(); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ id, query, limit, threadId }); }
      catch { void this.close(); }
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new SearchUnavailable("Search was interrupted. Try again shortly."));
    }
    this.pending.clear();
    if (worker) this.stopping = Promise.all([this.stopping, worker.terminate()]).then(() => {});
    await this.stopping;
  }
}
