import { describe, expect, it } from "vitest";

import {
  createWorkerJobs,
  type WorkerJobRecord,
  type WorkerJobStore,
} from "./worker-jobs.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = (reason) => no(reason);
  });
  return { promise, resolve, reject };
}

function memoryStore(seed: WorkerJobRecord[] = []) {
  const records = new Map(seed.map((job) => [job.id, structuredClone(job)]));
  const terminalWrites = new Map<string, number>();
  const store: WorkerJobStore = {
    create(job) {
      records.set(job.id, structuredClone(job));
    },
    update(id, patch) {
      const current = records.get(id);
      if (!current) throw new Error(`missing job ${id}`);
      records.set(id, { ...current, ...structuredClone(patch) });
      if (patch.status === "completed" || patch.status === "failed" || patch.status === "canceled") {
        terminalWrites.set(id, (terminalWrites.get(id) ?? 0) + 1);
      }
    },
    list() {
      return [...records.values()].map((job) => structuredClone(job));
    },
  };
  return { store, records, terminalWrites };
}

describe("worker jobs", () => {
  it("projects one labeled batch with live counts and a consolidated terminal state", async () => {
    const { store } = memoryStore();
    const gates = [deferred<string>(), deferred<string>()];
    const updates: string[] = [];
    let nextId = 0;
    const controller = createWorkerJobs({
      store,
      createId: () => `job-${++nextId}`,
      run: (job) => gates[Number(job.id.split("-")[1]) - 1]!.promise,
      interrupt: async () => undefined,
    }, { concurrency: 1 });
    controller.subscribe((batch) => updates.push(`${batch.status}:${batch.counts.running}`));

    const batch = await controller.launchBatch("task-a", [
      { label: "first", prompt: "one" },
      { label: "second", prompt: "two" },
    ], { label: "Research lanes" });

    expect(batch.projection()).toMatchObject({
      id: batch.batchId,
      label: "Research lanes",
      taskId: "task-a",
      status: "running",
      counts: { total: 2, queued: 1, running: 1, completed: 0, failed: 0, canceled: 0 },
    });
    gates[0]!.resolve("done");
    await viWaitFor(() => controller.batchSnapshot("task-a")[0]?.counts.running === 1 && controller.batchSnapshot("task-a")[0]?.counts.queued === 0);
    gates[1]!.resolve("done");
    expect((await batch.settled).every((job) => job.status === "completed")).toBe(true);
    expect(batch.projection()).toMatchObject({ status: "completed", terminal: true, counts: { completed: 2 } });
    expect(updates).toContain("running:1");
    expect(updates.at(-1)).toBe("completed:0");
  });

  it("launches every allowed task in parallel by default", async () => {
    const { store } = memoryStore();
    const gates = Array.from({ length: 8 }, () => deferred<string>());
    let active = 0;
    let maxActive = 0;
    let nextId = 0;
    const controller = createWorkerJobs({
      store,
      createId: () => `job-${++nextId}`,
      run: async (job) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const result = await gates[Number(job.id.split("-")[1]) - 1]!.promise;
        active -= 1;
        return result;
      },
      interrupt: async () => undefined,
    });

    const batch = await controller.launchBatch("task-a", [
      { prompt: "one" },
      { prompt: "two" },
      { prompt: "three" },
      { prompt: "four" },
      { prompt: "five" },
      { prompt: "six" },
      { prompt: "seven" },
      { prompt: "eight" },
    ]);
    await viWaitFor(() => controller.snapshot().filter((job) => job.status === "running").length === 8);
    expect(maxActive).toBe(8);
    expect(batch.jobs).toHaveLength(8);
    expect(batch.jobs.every((job) => job.hidden && job.taskId === "task-a")).toBe(true);

    for (const gate of gates) gate.resolve("done");

    const settled = await batch.settled;
    expect(settled.every((job) => job.status === "completed")).toBe(true);
    expect(maxActive).toBe(8);
  });

  it("cancels only the requested task and settles each canceled job exactly once", async () => {
    const { store, terminalWrites } = memoryStore();
    const running = new Map<string, ReturnType<typeof deferred<string>>>();
    const interrupted: string[] = [];
    let nextId = 0;
    const controller = createWorkerJobs({
      store,
      createId: () => `job-${++nextId}`,
      run: (job) => {
        const gate = deferred<string>();
        running.set(job.id, gate);
        return gate.promise;
      },
      interrupt: (job) => {
        interrupted.push(job.id);
        running.get(job.id)?.reject(new Error("interrupted"));
      },
    }, { concurrency: 1 });

    const canceledBatch = await controller.launchBatch("task-a", [
      { prompt: "running a" },
      { prompt: "queued a" },
    ]);
    const survivingBatch = await controller.launchBatch("task-b", [{ prompt: "work b" }]);
    await viWaitFor(() => running.has("job-1"));

    expect(await controller.cancelTask("task-a")).toBe(2);
    const canceled = await canceledBatch.settled;
    expect(canceled.map((job) => job.status)).toEqual(["canceled", "canceled"]);
    expect(interrupted).toEqual(["job-1"]);
    expect(terminalWrites.get("job-1")).toBe(1);
    expect(terminalWrites.get("job-2")).toBe(1);

    await viWaitFor(() => running.has("job-3"));
    running.get("job-3")!.resolve("survived");
    expect((await survivingBatch.settled)[0]).toMatchObject({ status: "completed", result: "survived" });
  });

  it("recovers queued jobs, fails ambiguous running jobs, and never exceeds the hard cap of eight", async () => {
    const unfinished = Array.from({ length: 9 }, (_, index): WorkerJobRecord => {
      const job: WorkerJobRecord = {
        id: `recovered-${index + 1}`,
        taskId: index < 4 ? "task-a" : "task-b",
        prompt: `recover ${index + 1}`,
        hidden: true,
        status: index === 0 ? "running" : "queued",
        createdAt: index + 1,
        resumePolicy: index === 0 ? "never" : "safe",
      };
      if (index === 0) job.startedAt = 10;
      return job;
    });
    const completed: WorkerJobRecord = {
      id: "already-done",
      taskId: "task-a",
      prompt: "do not repeat",
      hidden: true,
      status: "completed",
      createdAt: 0,
      settledAt: 1,
      result: "kept",
    };
    const { store, records } = memoryStore([...unfinished, completed]);
    const gates = new Map<string, ReturnType<typeof deferred<string>>>();
    let active = 0;
    let maxActive = 0;
    const controller = createWorkerJobs({
      store,
      run: (job) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const gate = deferred<string>();
        gates.set(job.id, gate);
        return gate.promise.finally(() => {
          active -= 1;
        });
      },
      interrupt: async () => undefined,
    }, { concurrency: 99 });

    const recovered = await controller.recover();
    await viWaitFor(() => gates.size === 8);
    expect(recovered.jobs).toHaveLength(8);
    expect(records.get("recovered-1")).toMatchObject({
      status: "failed",
      error: "interrupted by restart; not replayed",
    });
    expect(controller.batchSnapshot().find((batch) => batch.id === "recovered-1")).toMatchObject({
      status: "failed",
      terminal: true,
      counts: { total: 1, failed: 1 },
    });
    expect(maxActive).toBe(8);
    expect(controller.snapshot().some((job) => job.id === "already-done")).toBe(false);
    expect((await controller.recover()).jobs).toEqual([]);

    expect(gates.has("recovered-1")).toBe(false);
    for (const [id, gate] of gates) {
      gate.resolve(`done ${id}`);
    }
    expect((await recovered.settled).every((job) => job.status === "completed")).toBe(true);
    expect(maxActive).toBe(8);
  });

  it("does not replay a queued job unless it explicitly opts into safe resumption", async () => {
    const queued: WorkerJobRecord = {
      id: "queued-ambiguous",
      taskId: "task-a",
      prompt: "may have an external effect",
      hidden: true,
      status: "queued",
      createdAt: 1,
    };
    const { store, records } = memoryStore([queued]);
    let runs = 0;
    const controller = createWorkerJobs({
      store,
      run: async () => {
        runs += 1;
        return "must not run";
      },
      interrupt: async () => undefined,
    });

    const recovered = await controller.recover();

    expect(recovered.jobs).toEqual([]);
    expect(runs).toBe(0);
    expect(records.get(queued.id)).toMatchObject({
      status: "failed",
      error: "queued job was not explicitly marked safe to resume; not replayed",
    });
  });

  it("checkpoints the durable open-job set without changing its lifecycle state", async () => {
    const { store, records } = memoryStore();
    let checkpoints = 0;
    const gate = deferred<string>();
    store.checkpoint = () => {
      checkpoints += 1;
    };
    const controller = createWorkerJobs({
      store,
      createId: () => "job-1",
      run: async () => gate.promise,
      interrupt: async () => undefined,
    });

    const batch = await controller.launchBatch("task-a", [{ prompt: "safe read", resumePolicy: "safe" }]);
    await viWaitFor(() => records.get("job-1")?.status === "running");
    const before = records.get("job-1")?.status;
    await controller.checkpoint();

    expect(checkpoints).toBe(1);
    expect(records.get("job-1")?.status).toBe(before);
    gate.resolve("done");
    await batch.settled;
  });

  it("dispatches independent lanes together, waits on prerequisites, and serializes only shared locks", async () => {
    const { store, records } = memoryStore();
    const gates = new Map<string, ReturnType<typeof deferred<string>>>();
    const active: string[] = [];
    let nextId = 0;
    const controller = createWorkerJobs({
      store,
      createId: () => `job-${++nextId}`,
      run: (job) => {
        active.push(job.key ?? job.id);
        const gate = deferred<string>();
        gates.set(job.key ?? job.id, gate);
        return gate.promise.finally(() => {
          active.splice(active.indexOf(job.key ?? job.id), 1);
        });
      },
      interrupt: async () => undefined,
    }, { concurrency: 4 });

    const batch = await controller.launchBatch("task-graph", [
      { key: "alpha", label: "Alpha", prompt: "alpha", resourceLocks: ["repo"] },
      { key: "beta", label: "Beta", prompt: "beta" },
      { key: "gamma", label: "Gamma", prompt: "gamma", dependsOn: ["alpha"] },
      { key: "delta", label: "Delta", prompt: "delta", resourceLocks: ["repo"] },
    ]);

    await viWaitFor(() => active.includes("alpha") && active.includes("beta"));
    const waiting = batch.projection().jobs;
    expect(waiting.find((job) => job.label === "Gamma")?.waitingReason).toContain("prerequisite alpha");
    expect(waiting.find((job) => job.label === "Delta")?.waitingReason).toContain("shared resource repo");
    expect(active).toEqual(expect.arrayContaining(["alpha", "beta"]));
    expect(active).not.toContain("gamma");
    expect(active).not.toContain("delta");

    gates.get("beta")?.resolve("beta done");
    gates.get("alpha")?.resolve("alpha done");
    await viWaitFor(() => active.includes("gamma") && active.includes("delta"));
    expect(batch.projection().jobs.find((job) => job.label === "Gamma")?.waitingReason).toBeUndefined();
    expect(batch.projection().jobs.find((job) => job.label === "Delta")?.waitingReason).toBeUndefined();
    gates.get("gamma")?.resolve("gamma done");
    gates.get("delta")?.resolve("delta done");
    expect((await batch.settled).every((job) => job.status === "completed")).toBe(true);
    expect(records.get("job-3")?.status).toBe("completed");
  });

  it("isolates one worker failure while siblings finish", async () => {
    const { store } = memoryStore();
    const controller = createWorkerJobs({
      store,
      createId: (() => { let next = 0; return () => `job-${++next}`; })(),
      run: async (job) => {
        if (job.key === "broken") throw new Error("injected worker failure");
        return `${job.key} complete`;
      },
      interrupt: async () => undefined,
    });

    const batch = await controller.launchBatch("task-failure", [
      { key: "broken", prompt: "fail" },
      { key: "sibling-a", prompt: "finish a" },
      { key: "sibling-b", prompt: "finish b" },
    ]);

    expect((await batch.settled).map((job) => job.status)).toEqual(["failed", "completed", "completed"]);
    expect(batch.projection()).toMatchObject({ status: "failed", terminal: true, counts: { failed: 1, completed: 2 } });
  });
});

async function viWaitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
