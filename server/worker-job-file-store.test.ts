import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createWorkerJobFileStore } from "./worker-job-file-store.ts";

describe("worker job file store", () => {
  it("persists open work and terminal receipts across adapter reloads", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "centipede-worker-jobs-")), "jobs.json");
    const first = createWorkerJobFileStore(path);
    await first.create({
      id: "job-1",
      taskId: "thread-chief",
      prompt: "Research this",
      batchId: "batch-1",
      batchLabel: "Research lanes",
      hidden: true,
      status: "queued",
      createdAt: 10,
    });
    await first.update("job-1", { status: "running", startedAt: 11 });

    const second = createWorkerJobFileStore(path);
    expect(await second.list()).toEqual([
      expect.objectContaining({ id: "job-1", status: "running", startedAt: 11, batchId: "batch-1", batchLabel: "Research lanes" }),
    ]);

    await second.update("job-1", { status: "completed", settledAt: 12, result: "done" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([
      expect.objectContaining({ id: "job-1", status: "completed", result: "done" }),
    ]);
  });
});
