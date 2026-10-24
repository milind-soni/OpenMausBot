import { describe, expect, it } from "vitest";
import type { CoordinatorHost } from "./coordinator.ts";
import { cancelCoordinatorRoot, coordinatorCancellationSnapshot, RuntimeCoordinator } from "./runtime-coordinator.ts";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const reports: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const host: CoordinatorHost = {
    validate: () => undefined, busy: () => false,
    run: (node, _resumed, signal) => new Promise(resolve => {
      signals.set(node.id, signal);
      signal.addEventListener("abort", () => resolve({ ok: false, text: "stopped" }), { once: true });
    }),
    report: node => { reports.push(node.id); }, changed: () => {}, park: () => {},
    names: () => ({ requester: "Chief", assignee: "Expert", person: "Owner" }),
    levelOf: () => ({ level: "ask" }), chiefOf: address => address.botId === "chief",
  };
  const coordinator = new RuntimeCoordinator({ dataDir: ":memory:", host });
  const root = (id: string) => coordinator.beginTurn({ id, address: { botId: "chief", threadId: "source" }, brief: id,
    requestMessageId: `request-${id}`, level: "ask" });
  const assign = (parent: ReturnType<typeof root>, botId: string) => coordinator.enqueue(
    { botId: parent.botId, threadId: parent.threadId }, parent.id, parent.parentId ? parent.id : undefined,
    { botId, threadId: `work-${botId}` }, `Work for ${botId}`).node;
  return { coordinator, root, assign, reports, signals };
}

describe("exact native cancellation tree", () => {
  it("aborts owned running descendants and reports each once without stopping a replacement or unrelated job", async () => {
    const f = fixture(), root = f.root("root-old"), child = f.assign(root, "expert");
    f.coordinator.tick(); await flush();
    const grandchild = f.assign(child, "specialist");
    const newer = f.root("root-new"), unrelated = f.assign(newer, "other");
    f.coordinator.tick(); await flush();
    const snapshot = coordinatorCancellationSnapshot(f.coordinator, root.id)!;
    expect(snapshot.requestMessageId).toBe("request-root-old");
    expect(cancelCoordinatorRoot(f.coordinator, root.id, snapshot.treeVersion, "Cancelled by person")).toBe(true);
    await flush();
    for (const id of [child.id, grandchild.id]) {
      expect(f.coordinator.node(id)?.status).toBe("cancelled");
      expect(f.signals.get(id)?.aborted).toBe(true);
      expect(f.reports.filter(value => value === id)).toHaveLength(1);
    }
    expect(f.coordinator.node(newer.id)?.status).toBe("source");
    expect(f.coordinator.node(unrelated.id)?.status).toBe("running");
    expect(f.signals.get(unrelated.id)?.aborted).toBe(false);
    const after = coordinatorCancellationSnapshot(f.coordinator, root.id)!;
    expect(cancelCoordinatorRoot(f.coordinator, root.id, after.treeVersion, "Cancelled again")).toBe(true);
    expect(f.reports.filter(value => value === child.id)).toHaveLength(1);
    f.coordinator.cancelDirect(unrelated.threadId); f.coordinator.close();
  });

  it("refuses a stale native tree before aborting its running child", async () => {
    const f = fixture(), root = f.root("root-old"), child = f.assign(root, "expert");
    f.coordinator.tick(); await flush();
    const snapshot = coordinatorCancellationSnapshot(f.coordinator, root.id)!;
    f.assign(child, "specialist");
    expect(cancelCoordinatorRoot(f.coordinator, root.id, snapshot.treeVersion, "stale")).toBe(false);
    expect(f.signals.get(child.id)?.aborted).toBe(false);
    const current = coordinatorCancellationSnapshot(f.coordinator, root.id)!;
    cancelCoordinatorRoot(f.coordinator, root.id, current.treeVersion, "cleanup"); f.coordinator.close();
  });
});
