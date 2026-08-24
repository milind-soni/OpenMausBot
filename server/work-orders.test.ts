import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WorkOrderStore, type WorkOrderInput } from "./work-orders.ts";

const input: WorkOrderInput = {
  kind: "consultation",
  sourceBotId: "source",
  sourceTaskId: "source-task",
  sourceExecutionId: "turn-1",
  targetBotId: "target",
  targetTaskId: "target-task",
  request: "Please inspect this safely.",
  priority: "peer",
  depth: 0,
  delivery: "continuation",
};

function file() {
  return join(mkdtempSync(join(tmpdir(), "omb-work-orders-")), "orders.json");
}

describe("WorkOrderStore", () => {
  it("persists the lifecycle and redacts terminal output without changing the request", () => {
    let now = 100;
    const path = file();
    const store = new WorkOrderStore({ file: path, now: () => now });
    const order = store.create(input);
    now += 1;
    store.transition(order.id, "queued");
    now += 1;
    store.transition(order.id, "running");
    now += 1;
    const completed = store.transition(order.id, "completed", {
      result: "token=sk-test-12345678901234567890; done",
    });
    expect(completed.state).toBe("completed");
    expect(completed.request).toBe(input.request);
    expect(completed.result).not.toContain("sk-test-");
    expect(JSON.parse(readFileSync(path, "utf8")).orders[0].result).not.toContain("sk-test-");
    expect(() => store.transition(order.id, "failed")).toThrow(/terminal/);
  });

  it("reconstructs queued work, cancels source-bound work, and fails running work after restart", () => {
    const path = file();
    const first = new WorkOrderStore({ file: path, now: () => 100 });
    const source = first.create(input);
    const queued = first.create({ ...input, targetBotId: "target-2", targetTaskId: "target-task-2" }, "queued");
    const running = first.create({ ...input, targetBotId: "target-3", targetTaskId: "target-task-3" }, "queued");
    first.transition(running.id, "running");
    const second = new WorkOrderStore({ file: path, now: () => 200 });
    const recovered = second.recover();
    expect(recovered.cancelled.map((order) => order.id)).toEqual([source.id]);
    expect(recovered.failed.map((order) => order.id)).toEqual([running.id]);
    expect(second.get(queued.id)?.state).toBe("queued");
    expect(second.get(source.id)?.error).toContain("source execution");
  });

  it("keeps terminal history bounded while preserving active orders", () => {
    let now = 1;
    const store = new WorkOrderStore({ file: file(), maxTerminal: 2, now: () => now++ });
    for (let i = 0; i < 4; i += 1) {
      const order = store.create({ ...input, request: `request ${i}` });
      store.transition(order.id, "cancelled", { error: "no-op" });
    }
    const active = store.create({ ...input, request: "still queued" }, "queued");
    expect(store.list({ limit: 20 }).filter((order) => order.state === "cancelled")).toHaveLength(2);
    expect(store.get(active.id)?.state).toBe("queued");
  });

  it("rejects oversized input without changing accepted request text", () => {
    const store = new WorkOrderStore({ file: file() });
    const accepted = "x".repeat(20_000);
    expect(store.create({ ...input, request: accepted }).request).toBe(accepted);
    expect(() => store.create({ ...input, request: "x".repeat(20_001) })).toThrow(/request/);
    expect(() => store.create({ ...input, reason: "x".repeat(2_001) })).toThrow(/reason/);
  });

  it("bounds active work orders and frees capacity after cancellation", () => {
    const store = new WorkOrderStore({ file: file(), maxActive: 1 });
    const first = store.create(input);
    expect(() => store.create({ ...input, request: "second" })).toThrow(/capacity/);
    store.cancel(first.id);
    expect(store.create({ ...input, request: "after cancellation" }).state).toBe("pending-source");
  });

  it("settles both source and target orders when a bot is deleted", () => {
    const store = new WorkOrderStore({ file: file() });
    const sourceOrder = store.create(input, "queued");
    const targetOrder = store.create({ ...input, sourceBotId: "other", targetBotId: "source" }, "queued");
    const settled = store.settleForDeletedBot("source");
    expect(settled.cancelled.map((order) => order.id)).toEqual([sourceOrder.id]);
    expect(settled.failed.map((order) => order.id)).toEqual([targetOrder.id]);
    expect(store.get(sourceOrder.id)?.state).toBe("cancelled");
    expect(store.get(targetOrder.id)?.state).toBe("failed");
  });
});
