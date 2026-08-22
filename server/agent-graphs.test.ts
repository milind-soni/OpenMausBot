import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentGraphManager,
  type AgentGraphManagerOptions,
  type AgentGraphNodeInput,
  type AgentGraphRoute,
  type AgentGraphRunReceipt,
} from "./agent-graphs.ts";
import type { RuntimeEvent } from "./contracts.ts";

// These tests deliberately fsync every graph transition. Shared macOS CI and
// desktop hosts can have high disk latency even though the state machine is
// making progress; keep the assertions strict and give each case headroom.
vi.setConfig({ testTimeout: 60_000 });

const temporary: string[] = [];
const hash = (character: string) => `sha256:${character.repeat(64)}`;
const routeA: AgentGraphRoute = { botId: "bot-a", instanceId: "instance-a", engine: "codex", model: "gpt-test", workspaceRoot: "/tmp/bot-a", workspaceIdentity: hash("a"), authorityDigest: hash("d") };
const routeB: AgentGraphRoute = { botId: "bot-b", instanceId: "instance-b", engine: "hermes", model: "hermes-test", workspaceRoot: "/tmp/bot-b", workspaceIdentity: hash("b"), authorityDigest: hash("e") };
const routeC: AgentGraphRoute = { botId: "bot-c", instanceId: "instance-c", engine: "claudeAgent", model: "claude-test", workspaceRoot: "/tmp/bot-c", workspaceIdentity: hash("c"), authorityDigest: hash("f") };

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "omb-agent-graphs-"));
  temporary.push(path);
  return path;
}

function nodes(routes: AgentGraphRoute[] = [routeA]): AgentGraphNodeInput[] {
  return [
    {
      id: "inspect",
      title: "Inspect current source",
      role: "Memory and Improvement Steward",
      kind: "inspect",
      dependsOn: [],
      routes,
      permissionClass: "read",
      successCriteria: ["Current source is identified"],
      proofRequirements: ["Exact source path and hash"],
    },
    {
      id: "implement",
      title: "Implement the approved change",
      role: "Source Closeout",
      kind: "implement",
      dependsOn: ["inspect"],
      routes,
      permissionClass: "workspace-write",
      successCriteria: ["The bounded change is implemented"],
      proofRequirements: ["Focused test receipt"],
    },
    {
      id: "verify",
      title: "Verify the result",
      role: "QA and Acceptance",
      kind: "verify",
      dependsOn: ["implement"],
      routes,
      permissionClass: "read",
      successCriteria: ["Acceptance checks pass"],
      proofRequirements: ["Exact runtime receipt"],
    },
  ];
}

function startedEvent(
  threadId: string,
  providerInstanceId = routeA.instanceId,
  turnId = `turn-${threadId}`,
): RuntimeEvent {
  return {
    eventId: `started-${threadId}`,
    provider: "fake",
    providerInstanceId,
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
    type: "turn.started",
  };
}

function event(
  threadId: string,
  ok = true,
  denials?: string[],
  providerInstanceId = routeA.instanceId,
  turnId = `turn-${threadId}`,
): RuntimeEvent {
  return {
    eventId: `event-${threadId}`,
    provider: "fake",
    providerInstanceId,
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
    type: "turn.completed",
    turnToken: undefined,
    ok,
    ...(denials ? { denials } : {}),
  };
}

function eventFor(
  started: { threadId: string; instanceId: string; turnId: string },
  ok = true,
  denials?: string[],
): RuntimeEvent {
  return event(started.threadId, ok, denials, started.instanceId, started.turnId);
}

function harness(
  states: Record<string, "ready" | "busy" | "missing"> = { "bot-a": "ready", "bot-b": "ready", "bot-c": "ready" },
  storage: Pick<AgentGraphManagerOptions, "writeState" | "writeReceipt"> = {},
) {
  const root = directory();
  const started: Array<{ botId: string; instanceId: string; workspaceRoot: string; threadId: string; turnId: string; prompt: string }> = [];
  const interrupted: string[] = [];
  let task = 0;
  let manager!: AgentGraphManager;
  manager = new AgentGraphManager({
    file: join(root, "graphs.json"),
    now: (() => { let now = 1_700_000_000_000; return () => ++now; })(),
    routeState: (route) => states[route.botId] ?? "missing",
    createTask: (_route, _title) => ({ id: `task-${++task}`, threadId: `thread-${task}` }),
    startTurn: async (route, threadId, prompt, _fail, onDispatched) => {
      const turnId = `turn-${threadId}`;
      started.push({ botId: route.botId, instanceId: route.instanceId, workspaceRoot: route.workspaceRoot, threadId, turnId, prompt });
      onDispatched(`turn-${threadId}`);
      manager.handleRuntimeEvent(startedEvent(threadId, route.instanceId, turnId));
    },
    interruptTurn: async (_route, threadId) => { interrupted.push(threadId); },
    ...storage,
  });
  return { manager, file: join(root, "graphs.json"), started, interrupted };
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("approval-bound agent graphs", () => {
  it("persists a draft without dispatch and requires the exact graph hash", async () => {
    const { manager, started, file } = harness();
    const graph = manager.preview({ objective: "Improve startup reliability", nodes: nodes() });
    expect(graph.status).toBe("draft");
    expect(graph.revision).toBe(1);
    expect(started).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8")).graphs).toHaveLength(1);
    await expect(manager.approve(graph.id, `sha256:${"0".repeat(64)}`)).rejects.toThrow(/hash mismatch/);
    await manager.approve(graph.id, graph.graphHash);
    await Promise.resolve();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ botId: "bot-a", threadId: "thread-1" });
    expect(started[0]!.prompt).toContain("Graph approval never bypasses normal credential");
  });

  it("increments revisions monotonically for same-millisecond durable transitions", async () => {
    const root = directory();
    const revisions: number[] = [];
    let manager!: AgentGraphManager;
    manager = new AgentGraphManager({
      file: join(root, "graphs.json"),
      now: () => 1_700_000_000_000,
      emit: (payload) => revisions.push((payload.graph as { revision: number }).revision),
      routeState: () => "ready",
      createTask: () => ({ id: "constant-task", threadId: "constant-thread" }),
      startTurn: async (route, threadId) => {
        manager.handleRuntimeEvent(startedEvent(threadId, route.instanceId));
      },
    });
    const verifyOnly = [{ ...nodes()[2]!, dependsOn: [] }];
    const graph = manager.preview({ objective: "Monotonic revision proof", nodes: verifyOnly });
    await manager.approve(graph.id, graph.graphHash);
    await vi.waitFor(() => expect(manager.get(graph.id)?.nodes[0]?.turnId).toBe("turn-constant-thread"));

    manager.handleRuntimeEvent({
      eventId: "constant-error",
      provider: "fake",
      providerInstanceId: routeA.instanceId,
      threadId: "constant-thread",
      turnId: "turn-constant-thread",
      createdAt: new Date().toISOString(),
      type: "runtime.error",
      message: "diagnostic only",
    });
    manager.handleRuntimeEvent({
      eventId: "constant-request",
      provider: "fake",
      providerInstanceId: routeA.instanceId,
      threadId: "constant-thread",
      turnId: "turn-constant-thread",
      createdAt: new Date().toISOString(),
      type: "request.opened",
      requestType: "permission",
      requestId: "constant-approval",
      tool: "Bash",
      summary: "local test",
    });
    manager.handleRuntimeEvent({
      eventId: "constant-resolution",
      provider: "fake",
      providerInstanceId: routeA.instanceId,
      threadId: "constant-thread",
      turnId: "turn-constant-thread",
      createdAt: new Date().toISOString(),
      type: "request.resolved",
      requestId: "constant-approval",
      behavior: "allow",
      source: "user",
    });
    manager.handleRuntimeEvent(event("constant-thread"));

    expect(revisions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(manager.get(graph.id)).toMatchObject({
      revision: 9,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      approvedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_000_000,
    });
    expect(JSON.parse(readFileSync(join(root, "graphs.json"), "utf8")).graphs[0].revision).toBe(9);
  });

  it("rejects missing, non-positive, fractional, and unsafe persisted revisions", () => {
    for (const invalid of [undefined, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const { manager, file } = harness();
      manager.preview({ objective: "Revision validation seed", nodes: nodes() });
      const disk = JSON.parse(readFileSync(file, "utf8"));
      if (invalid === undefined) delete disk.graphs[0].revision;
      else disk.graphs[0].revision = invalid;
      writeFileSync(file, JSON.stringify(disk));
      const restarted = new AgentGraphManager({
        file,
        routeState: () => "ready",
        createTask: () => null,
        startTurn: async () => {},
      });
      expect(restarted.list()).toEqual([]);
      expect(restarted.storageHealth()).toMatchObject({
        state: "quarantined",
        quarantined: [{ reason: expect.stringMatching(/revision/) }],
      });
    }
  });

  it("rejects duplicate ids, cycles, missing verification, unavailable routes, and secret-shaped input", () => {
    const { manager } = harness({ "bot-a": "missing" });
    expect(() => manager.preview({ objective: "Valid objective", nodes: nodes() })).toThrow(/unavailable approved route/);

    const ready = harness().manager;
    expect(() => ready.preview({ objective: "Valid objective", nodes: [nodes()[0]!, nodes()[0]!] })).toThrow(/duplicate/);
    expect(() => ready.preview({ objective: "Valid objective", nodes: nodes().filter((node) => node.kind !== "verify") })).toThrow(/verify node/);
    const cyclic = nodes();
    cyclic[0] = { ...cyclic[0]!, dependsOn: ["verify"] };
    expect(() => ready.preview({ objective: "Valid objective", nodes: cyclic })).toThrow(/cycle/);
    expect(() => ready.preview({ objective: `API_KEY=${"x".repeat(32)}`, nodes: nodes() })).toThrow(/secret-shaped/);
    expect(() => ready.preview({ objective: "Review safe text\u202Etxt.exe", nodes: nodes() })).toThrow(/bidi control/);
  });

  it("runs dependency-ready nodes only, uses an approved fallback, and emits a calibrated receipt", async () => {
    const { manager, started } = harness({ "bot-a": "busy", "bot-b": "ready" });
    const graph = manager.preview({ objective: "Improve routing", maxParallel: 2, nodes: nodes([routeA, routeB]) });
    await manager.approve(graph.id, graph.graphHash);
    await Promise.resolve();
    expect(started.map((row) => row.botId)).toEqual(["bot-b"]);

    manager.handleRuntimeEvent(eventFor(started[0]!));
    await vi.waitFor(() => expect(started).toHaveLength(2));
    manager.handleRuntimeEvent(eventFor(started[1]!));
    await vi.waitFor(() => expect(started).toHaveLength(3));
    manager.handleRuntimeEvent(eventFor(started[2]!));
    await vi.waitFor(() => expect(manager.get(graph.id)?.status).toBe("completed"));

    const receipt = manager.receipt(graph.id);
    expect(receipt).toMatchObject({
      schema: "openmaus.agent_graph_run_receipt.v1",
      graph_hash: graph.graphHash,
      status: "completed",
      automatic_mutation: false,
      model_weights_changed: false,
      instruction_authority: false,
      verification_status: "unverified",
      completion_claim: "provider_turns_completed_with_task_receipts_unverified",
    });
    expect(receipt.nodes.every((node) => node.bot_id === "bot-b" && node.proof_refs.length === 1)).toBe(true);
  });

  it("host verifies only the exact complete run after current route admission and persists before observation", async () => {
    const root = directory();
    const receiptsDir = join(root, "receipts");
    const states: Record<string, "ready" | "busy" | "missing"> = { "bot-a": "ready" };
    const started: Array<{ threadId: string; instanceId: string; turnId: string }> = [];
    const observed: AgentGraphRunReceipt[] = [];
    let task = 0;
    let refreshes = 0;
    let manager!: AgentGraphManager;
    manager = new AgentGraphManager({
      file: join(root, "graphs.json"),
      receiptsDir,
      routeState: (route) => states[route.botId] ?? "missing",
      refreshRoutes: async () => { refreshes += 1; },
      createTask: () => ({ id: `verify-task-${++task}`, threadId: `verify-thread-${task}` }),
      startTurn: async (route, threadId) => {
        const turnId = `verify-turn-${threadId}`;
        started.push({ threadId, instanceId: route.instanceId, turnId });
        manager.handleRuntimeEvent(startedEvent(threadId, route.instanceId, turnId));
      },
      onVerifiedOutcome: (receipt) => {
        const durable = JSON.parse(readFileSync(join(receiptsDir, `${receipt.graph_id}.json`), "utf8"));
        expect(durable).toEqual(receipt);
        expect(durable.verification_status).toBe("verified");
        observed.push(receipt);
      },
    });
    const workspaceRoot = join(root, "workspace");
    mkdirSync(workspaceRoot);
    for (const name of ["inspect", "implement", "verify"]) writeFileSync(join(workspaceRoot, `${name}.txt`), `${name}\n`);
    const verificationRoute = { ...routeA, workspaceRoot: realpathSync(workspaceRoot) };
    const draft = manager.preview({ objective: "Promote exact host checked evidence", nodes: nodes([verificationRoute]) });
    const beforeRun = manager.receiptSnapshot(draft.id);
    await expect(manager.verify(draft.id, draft.graphHash, beforeRun.receiptHash, hash("9"), [])).rejects.toThrow(/fully completed/);
    await manager.approve(draft.id, draft.graphHash);
    for (let index = 0; index < 3; index += 1) {
      await vi.waitFor(() => expect(started).toHaveLength(index + 1));
      manager.handleRuntimeEvent(eventFor(started[index]!));
    }
    await vi.waitFor(() => expect(manager.get(draft.id)?.status).toBe("completed"));

    const current = manager.receiptSnapshot(draft.id);
    const paths = draft.nodes.map((node) => ({ nodeId: node.id, relativePath: `${node.id}.txt` }));
    await expect(manager.verify(draft.id, hash("0"), current.receiptHash, hash("9"), [])).rejects.toThrow(/graph hash mismatch/);
    await expect(manager.verify(draft.id, draft.graphHash, hash("0"), hash("9"), [])).rejects.toThrow(/receipt hash mismatch/);
    await expect(manager.verify(draft.id, draft.graphHash, current.receiptHash, hash("9"), [])).rejects.toThrow(/manifest is invalid/);
    states["bot-a"] = "missing";
    await expect(manager.verificationPreview(draft.id, draft.graphHash, current.receiptHash, paths)).rejects.toThrow(/authority changed/);
    states["bot-a"] = "busy";

    const preview = await manager.verificationPreview(draft.id, draft.graphHash, current.receiptHash, paths);
    writeFileSync(join(workspaceRoot, "verify.txt"), "changed after preview\n");
    await expect(manager.verify(
      draft.id,
      draft.graphHash,
      current.receiptHash,
      preview.evidence_manifest_hash,
      preview.evidence,
    )).rejects.toThrow(/changed after visible confirmation/);
    const currentPreview = await manager.verificationPreview(draft.id, draft.graphHash, current.receiptHash, paths);
    const verified = await manager.verify(
      draft.id,
      draft.graphHash,
      current.receiptHash,
      currentPreview.evidence_manifest_hash,
      currentPreview.evidence,
    );
    expect(refreshes).toBeGreaterThanOrEqual(2);
    expect(verified).toMatchObject({
      verification_status: "verified",
      completion_claim: "verified_with_host_checked_evidence",
      automatic_mutation: false,
      model_weights_changed: false,
      instruction_authority: false,
      evidence_manifest_hash: currentPreview.evidence_manifest_hash,
    });
    expect(verified.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(verified.nodes.every((node) => node.evidence_status === "verified" && node.verified_evidence.length === 1)).toBe(true);
    expect(observed).toEqual([verified]);
    expect(manager.receipt(draft.id)).toEqual(verified);
    await expect(manager.verify(
      draft.id,
      draft.graphHash,
      current.receiptHash,
      currentPreview.evidence_manifest_hash,
      currentPreview.evidence,
    )).rejects.toThrow(/already verified/);

    const restarted = new AgentGraphManager({
      file: join(root, "graphs.json"),
      receiptsDir,
      routeState: () => "ready",
      createTask: () => null,
      startTurn: async () => {},
    });
    expect(restarted.receipt(draft.id)).toEqual(verified);
  });

  it("rejects missing and redacted proof references even when a stored graph claims completion", async () => {
    for (const proofRefs of [[], ["thread:proof-thread-1", "[REDACTED]"]]) {
      const root = directory();
      let manager!: AgentGraphManager;
      manager = new AgentGraphManager({
        file: join(root, "graphs.json"),
        routeState: () => "ready",
        createTask: () => ({ id: "proof-task-1", threadId: "proof-thread-1" }),
        startTurn: async (route, threadId) => {
          manager.handleRuntimeEvent(startedEvent(threadId, route.instanceId, "proof-turn-1"));
        },
      });
      const graph = manager.preview({
        objective: "Reject incomplete host evidence",
        nodes: [{ ...nodes()[2]!, dependsOn: [] }],
      });
      await manager.approve(graph.id, graph.graphHash);
      await vi.waitFor(() => expect(manager.get(graph.id)?.nodes[0]?.turnId).toBe("proof-turn-1"));
      manager.handleRuntimeEvent(event("proof-thread-1", true, undefined, routeA.instanceId, "proof-turn-1"));
      await vi.waitFor(() => expect(manager.get(graph.id)?.status).toBe("completed"));

      const disk = JSON.parse(readFileSync(join(root, "graphs.json"), "utf8"));
      disk.graphs[0].nodes[0].proofRefs = proofRefs;
      writeFileSync(join(root, "graphs.json"), JSON.stringify(disk));
      const restarted = new AgentGraphManager({
        file: join(root, "graphs.json"),
        routeState: () => "ready",
        createTask: () => null,
        startTurn: async () => {},
      });
      const snapshot = restarted.receiptSnapshot(graph.id);
      await expect(restarted.verify(graph.id, graph.graphHash, snapshot.receiptHash, hash("9"), [])).rejects.toThrow(
        proofRefs.length ? /redacted or unsafe/ : /partial or mismatched/,
      );
    }
  });

  it("binds the prompt workspace to the actually selected fallback route", async () => {
    const fallback = { ...routeB, workspaceRoot: "/tmp/distinct-approved-fallback" };
    const { manager, started } = harness({ "bot-a": "busy", "bot-b": "ready" });
    const graph = manager.preview({
      objective: "Use the approved fallback checkout",
      nodes: nodes([routeA, fallback]),
    });

    await manager.approve(graph.id, graph.graphHash);
    await vi.waitFor(() => expect(started).toHaveLength(1));

    expect(started[0]).toMatchObject({
      botId: fallback.botId,
      workspaceRoot: fallback.workspaceRoot,
    });
    expect(started[0]!.prompt).toContain(
      `Authorized workspace: ${started[0]!.workspaceRoot}. Do not work in a different checkout.`,
    );
    expect(started[0]!.prompt).not.toContain(`Authorized workspace: ${routeA.workspaceRoot}.`);
    expect(manager.get(graph.id)?.nodes[0]?.selectedRoute?.workspaceRoot).toBe(fallback.workspaceRoot);
  });

  it("binds only an exact turn.started instance and rejects mismatched later events", async () => {
    const root = directory();
    const dispatched: string[] = [];
    const manager = new AgentGraphManager({
      file: join(root, "graphs.json"),
      routeState: () => "ready",
      createTask: () => ({ threadId: "exact-thread" }),
      startTurn: async () => { dispatched.push("exact-thread"); },
    });
    const graph = manager.preview({ objective: "Exact native event binding", nodes: nodes() });
    await manager.approve(graph.id, graph.graphHash);
    await vi.waitFor(() => expect(dispatched).toEqual(["exact-thread"]));
    const beforeBinding = manager.get(graph.id)!.revision;

    expect(manager.handleRuntimeEvent(startedEvent("exact-thread", routeB.instanceId, "exact-turn"))).toBeNull();
    expect(manager.get(graph.id)?.revision).toBe(beforeBinding);
    expect(manager.handleRuntimeEvent(startedEvent("exact-thread", routeA.instanceId, "exact-turn"))).not.toBeNull();
    const boundRevision = manager.get(graph.id)!.revision;
    expect(manager.get(graph.id)?.nodes[0]?.turnId).toBe("exact-turn");
    expect(manager.handleRuntimeEvent(startedEvent("exact-thread", routeA.instanceId, "other-turn"))).toBeNull();

    const wrongTurn = event("exact-thread", true, undefined, routeA.instanceId, "other-turn");
    const wrongInstance = event("exact-thread", true, undefined, routeB.instanceId, "exact-turn");
    expect(manager.handleRuntimeEvent(wrongTurn)).toBeNull();
    expect(manager.handleRuntimeEvent(wrongInstance)).toBeNull();
    expect(manager.handleRuntimeEvent({
      eventId: "wrong-runtime-instance",
      provider: "fake",
      providerInstanceId: routeB.instanceId,
      threadId: "exact-thread",
      turnId: "exact-turn",
      createdAt: new Date().toISOString(),
      type: "runtime.error",
      message: "must be ignored",
    })).toBeNull();
    expect(manager.handleRuntimeEvent({
      eventId: "wrong-request-turn",
      provider: "fake",
      providerInstanceId: routeA.instanceId,
      threadId: "exact-thread",
      turnId: "other-turn",
      createdAt: new Date().toISOString(),
      type: "request.opened",
      requestType: "permission",
      requestId: "wrong-request",
      tool: "Bash",
      summary: "must be ignored",
    })).toBeNull();
    expect(manager.get(graph.id)?.revision).toBe(boundRevision);
    expect(manager.handleRuntimeEvent(event("exact-thread", true, undefined, routeA.instanceId, "exact-turn"))).not.toBeNull();
    expect(manager.get(graph.id)?.nodes[0]?.status).toBe("completed");
  });

  it("persists a synchronous native start binding before accepting synchronous completion", async () => {
    const root = directory();
    let task = 0;
    let manager!: AgentGraphManager;
    manager = new AgentGraphManager({
      file: join(root, "graphs.json"),
      routeState: () => "ready",
      createTask: () => ({ id: `sync-task-${++task}`, threadId: `sync-thread-${task}` }),
      startTurn: async (route, threadId) => {
        const turnId = `sync-turn-${threadId}`;
        expect(manager.handleRuntimeEvent(startedEvent(threadId, route.instanceId, turnId))?.nodes
          .find((node) => node.threadId === threadId)?.turnId).toBe(turnId);
        expect(manager.handleRuntimeEvent(event(threadId, true, undefined, route.instanceId, turnId))).not.toBeNull();
      },
    });
    const graph = manager.preview({ objective: "Synchronous provider ordering", nodes: nodes() });
    await manager.approve(graph.id, graph.graphHash);
    await vi.waitFor(() => expect(manager.get(graph.id)?.status).toBe("completed"));

    const receipt = manager.receipt(graph.id);
    expect(receipt.nodes.map((node) => node.turn_id)).toEqual([
      "sync-turn-sync-thread-1",
      "sync-turn-sync-thread-2",
      "sync-turn-sync-thread-3",
    ]);
    expect(receipt.nodes.every((node) => node.status === "completed")).toBe(true);
  });

  it("makes no completion claim when execution blocks before task ownership", async () => {
    const root = directory();
    const manager = new AgentGraphManager({
      file: join(root, "graphs.json"),
      routeState: () => "ready",
      createTask: () => null,
      startTurn: async () => {},
    });
    const graph = manager.preview({ objective: "Block before dispatch", nodes: nodes() });
    await manager.approve(graph.id, graph.graphHash);
    await vi.waitFor(() => expect(manager.get(graph.id)?.status).toBe("blocked"));

    expect(manager.receipt(graph.id).completion_claim).toBe("no_completion_claim");
    expect(manager.receipt(graph.id).nodes.every((node) => node.task_id === null)).toBe(true);
  });

  it("tracks approval waits, recovers active nodes as blocked, and cancels only owned task threads", async () => {
    const { manager, file, interrupted } = harness();
    const graph = manager.preview({ objective: "Protected workflow", nodes: nodes() });
    await manager.approve(graph.id, graph.graphHash);
    await Promise.resolve();
    manager.handleRuntimeEvent({
      eventId: "request-1",
      provider: "fake",
      providerInstanceId: routeA.instanceId,
      threadId: "thread-1",
      turnId: "turn-thread-1",
      createdAt: new Date().toISOString(),
      type: "request.opened",
      requestType: "permission",
      requestId: "approval-1",
      tool: "Bash",
      summary: "git push",
    });
    expect(manager.get(graph.id)?.nodes[0]?.status).toBe("waiting_for_approval");
    const beforeRecoveryRevision = manager.get(graph.id)!.revision;

    const restarted = new AgentGraphManager({
      file,
      routeState: () => "ready",
      createTask: () => null,
      startTurn: async () => {},
    });
    expect(restarted.get(graph.id)?.status).toBe("blocked");
    expect(restarted.get(graph.id)?.nodes[0]?.status).toBe("blocked");
    expect(restarted.get(graph.id)?.revision).toBe(beforeRecoveryRevision + 1);

    const second = manager.preview({ objective: "Cancellation", nodes: nodes([routeB]) });
    await manager.approve(second.id, second.graphHash);
    await Promise.resolve();
    await manager.cancel(second.id);
    expect(interrupted).toEqual(["thread-2"]);
    expect(manager.get(second.id)?.status).toBe("running");
    expect(manager.get(second.id)?.nodes[0]).toMatchObject({
      status: "running",
      error: expect.stringMatching(/awaiting exact turn completion/),
    });
    manager.handleRuntimeEvent(event("thread-2", false, undefined, routeB.instanceId));
    expect(manager.get(second.id)?.status).toBe("cancelled");
    expect(manager.get(second.id)?.nodes[0]?.status).toBe("cancelled");
  });

  it("enforces the two-node ceiling across separately approved graphs", async () => {
    const { manager, started } = harness();
    const first = manager.preview({ objective: "First graph", nodes: nodes([routeA]) });
    const second = manager.preview({ objective: "Second graph", nodes: nodes([routeB]) });
    const third = manager.preview({ objective: "Third graph", nodes: nodes([routeC]) });
    await Promise.all([
      manager.approve(first.id, first.graphHash),
      manager.approve(second.id, second.graphHash),
      manager.approve(third.id, third.graphHash),
    ]);
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toHaveLength(2);
    expect(new Set(started.map((row) => row.botId)).size).toBe(2);
    manager.handleRuntimeEvent(eventFor(started[0]!));
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toHaveLength(3);
  });

  it("propagates a failed dependency regardless of node ordering", async () => {
    const { manager, started } = harness();
    const reversed = [...nodes()].reverse();
    const graph = manager.preview({ objective: "Reverse ordered graph", nodes: reversed });
    await manager.approve(graph.id, graph.graphHash);
    await Promise.resolve();
    expect(started).toHaveLength(1);
    expect(started[0]!.prompt).toContain("node inspect");

    manager.handleRuntimeEvent(eventFor(started[0]!, false));
    await Promise.resolve();
    const settled = manager.get(graph.id)!;
    expect(settled.status).toBe("blocked");
    expect(settled.nodes.map((node) => node.status)).toEqual(["blocked", "blocked", "failed"]);
    expect(started).toHaveLength(1);
  });

  it("does not claim cancellation when task interruption is unconfirmed", async () => {
    const root = directory();
    let task = 0;
    const manager = new AgentGraphManager({
      file: join(root, "graphs.json"),
      routeState: () => "ready",
      createTask: () => ({ threadId: `interrupt-thread-${++task}` }),
      startTurn: async () => {},
      interruptTurn: async () => { throw new Error("provider interrupt failed"); },
    });
    const graph = manager.preview({ objective: "Honest cancellation", nodes: nodes() });
    await manager.approve(graph.id, graph.graphHash);
    await Promise.resolve();
    const cancelled = await manager.cancel(graph.id);

    expect(cancelled.status).toBe("running");
    expect(cancelled.nodes[0]).toMatchObject({
      status: "running",
      error: "Cancellation requested, but task interruption could not be confirmed",
    });
    manager.handleRuntimeEvent(startedEvent("interrupt-thread-1"));
    manager.handleRuntimeEvent(event("interrupt-thread-1"));
    const settled = manager.get(graph.id)!;
    expect(settled.status).toBe("cancelled");
    expect(settled.nodes[0]).toMatchObject({
      status: "cancelled",
      proofRefs: ["thread:interrupt-thread-1"],
    });
    expect(manager.receipt(graph.id).completion_claim).toBe("cancelled_before_verified_completion");
  });

  it("settles a cancellation before provider start without fabricating provider proof", async () => {
    const root = directory();
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    let enteredStart!: () => void;
    const startEntered = new Promise<void>((resolve) => { enteredStart = resolve; });
    let effectiveDispatches = 0;
    const interrupts: Array<string | undefined> = [];
    const manager = new AgentGraphManager({
      file: join(root, "graphs.json"),
      routeState: () => "ready",
      createTask: () => ({ threadId: "deferred-thread" }),
      startTurn: async (_route, _threadId, _prompt, _fail, _onDispatched, _permission, control) => {
        enteredStart();
        await startGate;
        if (!control.isDispatchAllowed()) {
          control.onCancelledBeforeDispatch();
          return;
        }
        effectiveDispatches += 1;
      },
      interruptTurn: async (_route, _threadId, turnId) => { interrupts.push(turnId); },
    });
    const graph = manager.preview({ objective: "Cancel deferred provider start", nodes: nodes() });
    await manager.approve(graph.id, graph.graphHash);
    await startEntered;
    const beforeCancellationRevision = manager.get(graph.id)!.revision;
    const requested = await manager.cancel(graph.id);
    expect(requested.nodes[0]).toMatchObject({
      status: "running",
      cancellationRequestedAt: expect.any(Number),
    });
    expect(requested.revision).toBe(beforeCancellationRevision + 2);
    expect(interrupts).toEqual([undefined]);
    expect(manager.authorizationForThread("deferred-thread")).toBeNull();

    releaseStart();
    await vi.waitFor(() => expect(manager.get(graph.id)?.status).toBe("cancelled"));
    expect(effectiveDispatches).toBe(0);
    expect(manager.receipt(graph.id).nodes[0]).toMatchObject({
      status: "cancelled",
      turn_id: null,
      proof_refs: [],
      error: expect.stringMatching(/provider turn did not start/),
    });
  });

  it("re-interrupts immediately when an exact turn starts after cancellation was persisted", async () => {
    const root = directory();
    const interrupts: Array<string | undefined> = [];
    const manager = new AgentGraphManager({
      file: join(root, "graphs.json"),
      routeState: () => "ready",
      createTask: () => ({ threadId: "late-start-thread" }),
      startTurn: async () => {},
      interruptTurn: async (_route, _threadId, turnId) => { interrupts.push(turnId); },
    });
    const graph = manager.preview({ objective: "Interrupt exact late start", nodes: nodes() });
    await manager.approve(graph.id, graph.graphHash);
    await vi.waitFor(() => expect(manager.get(graph.id)?.nodes[0]?.status).toBe("running"));
    await manager.cancel(graph.id);
    expect(interrupts).toEqual([undefined]);

    manager.handleRuntimeEvent(startedEvent("late-start-thread", routeA.instanceId, "late-turn"));
    expect(interrupts).toEqual([undefined, "late-turn"]);
    expect(manager.get(graph.id)?.nodes[0]).toMatchObject({
      status: "running",
      turnId: "late-turn",
      cancellationRequestedAt: expect.any(Number),
    });
    manager.handleRuntimeEvent(event("late-start-thread", false, undefined, routeA.instanceId, "late-turn"));
    expect(manager.get(graph.id)?.status).toBe("cancelled");
  });

  it("rejects route drift between preview and approval without dispatch", async () => {
    const states: Record<string, "ready" | "busy" | "missing"> = { "bot-a": "ready" };
    const { manager, started } = harness(states);
    const graph = manager.preview({ objective: "Bind the exact route", nodes: nodes() });
    states["bot-a"] = "missing";
    await expect(manager.approve(graph.id, graph.graphHash)).rejects.toThrow(/no currently admitted/);
    expect(started).toEqual([]);
    expect(manager.get(graph.id)?.status).toBe("draft");
  });

  it("quarantines a hash-tampered record while preserving a valid sibling", () => {
    const { manager, file } = harness();
    const first = manager.preview({ objective: "First durable draft", nodes: nodes() });
    const second = manager.preview({ objective: "Second durable draft", nodes: nodes() });
    const disk = JSON.parse(readFileSync(file, "utf8"));
    disk.graphs.find((graph: { id: string }) => graph.id === second.id).objective = "Tampered after preview";
    writeFileSync(file, JSON.stringify(disk));

    const restarted = new AgentGraphManager({
      file,
      routeState: () => "ready",
      createTask: () => null,
      startTurn: async () => {},
    });
    expect(restarted.list().map((graph) => graph.id)).toEqual([first.id]);
    expect(restarted.storageHealth()).toMatchObject({ state: "quarantined", quarantined: [{ reason: expect.stringMatching(/hash mismatch/) }] });
  });

  it("withholds corrupt, oversized, and symlink store roots without leaking their contents", async () => {
    const canary = "GRAPH_STORE_SECRET_CANARY_7f3b9c2a";
    for (const kind of ["corrupt", "oversized", "symlink"] as const) {
      const root = directory();
      const file = join(root, "graphs.json");
      let symlinkTarget: string | null = null;
      if (kind === "corrupt") {
        writeFileSync(file, `{"private":"${canary}"`);
      } else if (kind === "oversized") {
        writeFileSync(file, `${canary}${"x".repeat(2 * 1024 * 1024)}`);
      } else {
        symlinkTarget = join(root, "untrusted-target.json");
        writeFileSync(symlinkTarget, canary);
        symlinkSync(symlinkTarget, file);
      }

      const manager = new AgentGraphManager({
        file,
        routeState: () => "ready",
        createTask: () => null,
        startTurn: async () => {},
      });
      expect(manager.list()).toEqual([]);
      expect(manager.storageHealth().state).toBe("quarantined");
      const quarantineFiles = readdirSync(join(root, "agent-graph-receipts"))
        .filter((name) => name.startsWith("quarantine-"));
      expect(quarantineFiles).toHaveLength(1);
      const metadata = JSON.parse(readFileSync(join(root, "agent-graph-receipts", quarantineFiles[0]!), "utf8"));
      expect(Object.keys(metadata).sort()).toEqual(["fingerprint", "reason"]);
      expect(JSON.stringify(metadata)).not.toContain(canary);

      expect(() => manager.preview({ objective: `Recover ${kind} graph storage`, nodes: nodes() })).toThrow(/storage is quarantined/);
      await expect(manager.approve("missing", hash("0"))).rejects.toThrow(/storage is quarantined/);
      await expect(manager.cancel("missing")).rejects.toThrow(/not found/);
      expect(lstatSync(file).isSymbolicLink()).toBe(kind === "symlink");
      if (symlinkTarget) expect(readFileSync(symlinkTarget, "utf8")).toBe(canary);
    }
  });

  it("withholds a state file that changes during a no-follow descriptor read", () => {
    const root = directory();
    const file = join(root, "graphs.json");
    const seed = new AgentGraphManager({
      file,
      routeState: () => "ready",
      createTask: () => null,
      startTurn: async () => {},
    });
    seed.preview({ objective: "Stable descriptor seed", nodes: nodes() });

    const manager = new AgentGraphManager({
      file,
      readState: (fd) => {
        const serialized = readFileSync(fd, "utf8");
        writeFileSync(file, `${serialized} `);
        return serialized;
      },
      routeState: () => "ready",
      createTask: () => null,
      startTurn: async () => {},
    });

    expect(manager.list()).toEqual([]);
    expect(manager.storageHealth()).toMatchObject({
      state: "quarantined",
      quarantined: [{ reason: expect.stringMatching(/changed while it was being read/) }],
    });
    expect(() => manager.preview({ objective: "Do not overwrite raced state", nodes: nodes() })).toThrow(/storage is quarantined/);
  });

  it("withholds a multi-link state file", () => {
    const root = directory();
    const file = join(root, "graphs.json");
    const seed = new AgentGraphManager({
      file,
      routeState: () => "ready",
      createTask: () => null,
      startTurn: async () => {},
    });
    seed.preview({ objective: "Single-link seed", nodes: nodes() });
    linkSync(file, join(root, "graphs-hardlink.json"));

    const manager = new AgentGraphManager({
      file,
      routeState: () => "ready",
      createTask: () => null,
      startTurn: async () => {},
    });
    expect(manager.list()).toEqual([]);
    expect(manager.storageHealth()).toMatchObject({
      state: "quarantined",
      quarantined: [{ reason: expect.stringMatching(/single-link/) }],
    });
  });

  it("bounds retained drafts to the newest safe records", () => {
    const { manager, file } = harness();
    const graphIds = Array.from({ length: 40 }, (_, index) =>
      manager.preview({ objective: `Bounded draft ${index}`, nodes: nodes() }).id);

    expect(manager.list()).toHaveLength(32);
    expect(manager.get(graphIds[0]!)).toBeNull();
    expect(manager.get(graphIds.at(-1)!)).not.toBeNull();
    expect(JSON.parse(readFileSync(file, "utf8")).graphs).toHaveLength(32);
  });

  it("rolls a near-cap approval back atomically and never starts execution", async () => {
    const root = directory();
    const file = join(root, "graphs.json");
    const seed = new AgentGraphManager({
      file,
      routeState: () => "ready",
      createTask: () => null,
      startTurn: async () => {},
    });
    const graph = seed.preview({ objective: "Near capacity approval", nodes: nodes() });
    const durableDraft = readFileSync(file, "utf8");
    let started = 0;
    const manager = new AgentGraphManager({
      file,
      maxFileBytes: Buffer.byteLength(durableDraft, "utf8") + 1,
      routeState: () => "ready",
      createTask: () => ({ threadId: "must-not-start" }),
      startTurn: async () => { started += 1; },
    });

    await expect(manager.approve(graph.id, graph.graphHash)).rejects.toThrow(/retention limit/);
    expect(started).toBe(0);
    expect(manager.get(graph.id)?.status).toBe("draft");
    expect(readFileSync(file, "utf8")).toBe(durableDraft);
    expect(manager.storageHealth().state).toBe("degraded");
    expect(() => manager.preview({ objective: "Degraded preview", nodes: nodes() })).toThrow(/storage is degraded/);
    await expect(manager.approve(graph.id, graph.graphHash)).rejects.toThrow(/storage is degraded/);
    await expect(manager.cancel(graph.id)).rejects.toThrow();
  });

  it("rolls runtime and cancellation mutations back when the durable store is unavailable", async () => {
    let failWrites = false;
    const writeState: NonNullable<AgentGraphManagerOptions["writeState"]> = (path, data, options = {}) => {
      if (failWrites) throw new Error("injected graph store failure");
      writeFileSync(path, data, { encoding: "utf8", mode: options.mode });
    };
    const { manager, file, started, interrupted } = harness(undefined, { writeState });
    const graph = manager.preview({ objective: "Transactional runtime state", nodes: nodes() });
    await manager.approve(graph.id, graph.graphHash);
    await vi.waitFor(() => expect(started).toHaveLength(1));
    const durableRunning = readFileSync(file, "utf8");
    failWrites = true;
    const result = manager.handleRuntimeEvent(event("thread-1"));
    // A rolled-back event is not durable admission for downstream folds.
    expect(result).toBeNull();
    expect(manager.get(graph.id)?.nodes[0]?.status).toBe("running");
    expect(readFileSync(file, "utf8")).toBe(durableRunning);

    await expect(manager.cancel(graph.id)).rejects.toThrow();
    expect(interrupted).toEqual(["thread-1"]);
    expect(manager.get(graph.id)?.status).toBe("running");
    expect(manager.get(graph.id)?.nodes[0]?.cancellationRequestedAt).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(durableRunning);
  });

  it("still revokes an exact active turn when an unrelated receipt sink degraded health", async () => {
    const root = directory();
    const receiptsDir = join(root, "receipts");
    const interrupted: Array<{ threadId: string; turnId?: string }> = [];
    let failReceipts = false;
    let manager!: AgentGraphManager;
    manager = new AgentGraphManager({
      file: join(root, "graphs.json"),
      receiptsDir,
      routeState: () => "ready",
      createTask: (route) => ({ threadId: `sink-${route.botId}` }),
      startTurn: async (route, threadId) => {
        manager.handleRuntimeEvent(startedEvent(threadId, route.instanceId));
      },
      interruptTurn: async (_route, threadId, turnId) => { interrupted.push({ threadId, ...(turnId ? { turnId } : {}) }); },
      writeReceipt: (path, data, options = {}) => {
        if (failReceipts) throw new Error("injected graph receipt sink failure");
        writeFileSync(path, data, { encoding: "utf8", mode: options.mode });
      },
    });
    const verifyOnly = (route: AgentGraphRoute) => [{ ...nodes([route])[2]!, dependsOn: [] }];
    const terminal = manager.preview({ objective: "Receipt sink failure seed", nodes: verifyOnly(routeA) });
    const active = manager.preview({ objective: "Emergency cancellation target", nodes: verifyOnly(routeB) });
    await Promise.all([
      manager.approve(terminal.id, terminal.graphHash),
      manager.approve(active.id, active.graphHash),
    ]);
    await vi.waitFor(() => {
      expect(manager.get(terminal.id)?.nodes[0]?.turnId).toBe("turn-sink-bot-a");
      expect(manager.get(active.id)?.nodes[0]?.turnId).toBe("turn-sink-bot-b");
    });

    failReceipts = true;
    manager.handleRuntimeEvent(event("sink-bot-a"));
    expect(manager.get(terminal.id)?.status).toBe("completed");
    expect(manager.storageHealth().state).toBe("degraded");

    const cancelled = await manager.cancel(active.id);
    expect(cancelled.status).toBe("running");
    expect(interrupted).toEqual([{ threadId: "sink-bot-b", turnId: "turn-sink-bot-b" }]);
    expect(manager.get(active.id)?.nodes[0]?.cancellationRequestedAt).toEqual(expect.any(Number));
  });

  it("does not start a drain node when its running ownership record cannot persist", async () => {
    const root = directory();
    const file = join(root, "graphs.json");
    let refreshCalls = 0;
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
    let created = 0;
    let started = 0;
    let failWrites = false;
    const manager = new AgentGraphManager({
      file,
      routeState: () => "ready",
      refreshRoutes: async () => {
        refreshCalls += 1;
        if (refreshCalls > 1) await drainGate;
      },
      createTask: () => { created += 1; return { threadId: "must-not-dispatch" }; },
      startTurn: async () => { started += 1; },
      writeState: (path, data, options = {}) => {
        if (failWrites) throw new Error("injected graph store failure");
        writeFileSync(path, data, { encoding: "utf8", mode: options.mode });
      },
    });
    const graph = manager.preview({ objective: "Transactional drain", nodes: nodes() });
    await manager.approve(graph.id, graph.graphHash);
    await vi.waitFor(() => expect(refreshCalls).toBe(2));
    const durableApproved = readFileSync(file, "utf8");

    failWrites = true;
    releaseDrain();
    await vi.waitFor(() => expect(manager.storageHealth().state).toBe("degraded"));
    expect(created).toBe(0);
    expect(started).toBe(0);
    expect(manager.get(graph.id)?.status).toBe("approved");
    expect(readFileSync(file, "utf8")).toBe(durableApproved);
  });

  it("rolls back injected dispatch, terminal, and exact turn binding write failures", async () => {
    const writer = (shouldFail: (disk: any) => boolean) =>
      (path: string, data: string, options: { mode?: number } = {}) => {
        const disk = JSON.parse(data);
        if (shouldFail(disk)) throw new Error("injected graph store failure");
        writeFileSync(path, data, { encoding: "utf8", mode: options.mode });
      };

    const dispatchRoot = directory();
    let created = 0;
    let dispatched = 0;
    const discarded: string[] = [];
    const dispatchManager = new AgentGraphManager({
      file: join(dispatchRoot, "graphs.json"),
      routeState: () => "ready",
      writeState: writer((disk) => disk.graphs.some((graph: any) =>
        graph.nodes.some((node: any) => node.threadId === "orphan-window"))),
      createTask: () => { created += 1; return { threadId: "orphan-window" }; },
      discardTask: (_route, threadId) => { discarded.push(threadId); },
      startTurn: async () => { dispatched += 1; },
    });
    const dispatchGraph = dispatchManager.preview({ objective: "Dispatch persistence", nodes: nodes() });
    await dispatchManager.approve(dispatchGraph.id, dispatchGraph.graphHash);
    await vi.waitFor(() => expect(dispatchManager.storageHealth().state).toBe("degraded"));
    expect(created).toBe(1);
    expect(discarded).toEqual(["orphan-window"]);
    expect(dispatched).toBe(0);
    expect(dispatchManager.get(dispatchGraph.id)?.nodes[0]).toMatchObject({ status: "pending" });
    expect(dispatchManager.get(dispatchGraph.id)?.nodes[0]?.threadId).toBeUndefined();

    const terminalRoot = directory();
    let failTerminal = false;
    const terminalManager = new AgentGraphManager({
      file: join(terminalRoot, "graphs.json"),
      routeState: () => "ready",
      writeState: writer((disk) => failTerminal && disk.graphs.some((graph: any) =>
        graph.nodes.some((node: any) => node.status === "completed"))),
      createTask: () => ({ threadId: "terminal-thread" }),
      startTurn: async () => {},
    });
    const terminalGraph = terminalManager.preview({ objective: "Terminal persistence", nodes: nodes() });
    await terminalManager.approve(terminalGraph.id, terminalGraph.graphHash);
    await vi.waitFor(() => expect(terminalManager.get(terminalGraph.id)?.nodes[0]?.status).toBe("running"));
    terminalManager.handleRuntimeEvent(startedEvent("terminal-thread"));
    const terminalDisk = readFileSync(join(terminalRoot, "graphs.json"), "utf8");
    failTerminal = true;
    expect(terminalManager.handleRuntimeEvent(event("terminal-thread"))).toBeNull();
    expect(terminalManager.get(terminalGraph.id)?.nodes[0]?.status).toBe("running");
    expect(readFileSync(join(terminalRoot, "graphs.json"), "utf8")).toBe(terminalDisk);

    const dispatchedRoot = directory();
    let dispatchedManager!: AgentGraphManager;
    dispatchedManager = new AgentGraphManager({
      file: join(dispatchedRoot, "graphs.json"),
      routeState: () => "ready",
      writeState: writer((disk) => disk.graphs.some((graph: any) =>
        graph.nodes.some((node: any) => node.turnId === "injected-turn"))),
      createTask: () => ({ threadId: "dispatched-thread" }),
      startTurn: async (route, threadId) => {
        dispatchedManager.handleRuntimeEvent(startedEvent(threadId, route.instanceId, "injected-turn"));
      },
    });
    const dispatchedGraph = dispatchedManager.preview({ objective: "Turn id persistence", nodes: nodes() });
    await dispatchedManager.approve(dispatchedGraph.id, dispatchedGraph.graphHash);
    await vi.waitFor(() => expect(dispatchedManager.storageHealth().state).toBe("degraded"));
    expect(dispatchedManager.get(dispatchedGraph.id)?.nodes[0]).toMatchObject({
      status: "running",
      threadId: "dispatched-thread",
    });
    expect(dispatchedManager.get(dispatchedGraph.id)?.nodes[0]?.turnId).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dispatchedRoot, "graphs.json"), "utf8")).graphs[0].nodes[0].turnId).toBeUndefined();
  });

  it("regenerates a missing terminal receipt idempotently on startup", async () => {
    const { manager, file, started } = harness();
    const graph = manager.preview({ objective: "Receipt regeneration", nodes: nodes() });
    await manager.approve(graph.id, graph.graphHash);
    for (let index = 0; index < 3; index += 1) {
      await vi.waitFor(() => expect(started).toHaveLength(index + 1));
      manager.handleRuntimeEvent(eventFor(started[index]!));
    }
    await vi.waitFor(() => expect(manager.get(graph.id)?.status).toBe("completed"));
    const receiptFile = join(dirname(file), "agent-graph-receipts", `${graph.id}.json`);
    rmSync(receiptFile);

    const restarted = new AgentGraphManager({
      file,
      routeState: () => "ready",
      createTask: () => null,
      startTurn: async () => {},
    });
    expect(JSON.parse(readFileSync(receiptFile, "utf8"))).toEqual(restarted.receipt(graph.id));
    const firstReadback = readFileSync(receiptFile, "utf8");
    const restartedAgain = new AgentGraphManager({
      file,
      routeState: () => "ready",
      createTask: () => null,
      startTurn: async () => {},
    });
    expect(readFileSync(receiptFile, "utf8")).toBe(firstReadback);
    expect(restartedAgain.get(graph.id)?.status).toBe("completed");
  });

  it("quarantines impossible mutable runtime state even when the immutable hash still matches", () => {
    const { manager, file } = harness();
    manager.preview({ objective: "Preserve runtime provenance", nodes: nodes() });
    const disk = JSON.parse(readFileSync(file, "utf8"));
    disk.graphs[0].nodes[0].status = "completed";
    disk.graphs[0].nodes[0].finishedAt = disk.graphs[0].updatedAt + 1;
    writeFileSync(file, JSON.stringify(disk));

    const restarted = new AgentGraphManager({
      file,
      routeState: () => "ready",
      createTask: () => null,
      startTurn: async () => {},
    });
    expect(restarted.list()).toEqual([]);
    expect(restarted.storageHealth()).toMatchObject({
      state: "quarantined",
      quarantined: [{ reason: expect.stringMatching(/runtime ownership|draft graph runtime/) }],
    });
  });

  it("omits private objective prose from the durable run receipt", () => {
    const { manager } = harness();
    const graph = manager.preview({ objective: "Review the local account for gus@example.com", nodes: nodes() });
    const serialized = JSON.stringify(manager.receipt(graph.id));
    expect(serialized).not.toContain("gus@example.com");
    expect(manager.receipt(graph.id)).not.toHaveProperty("objective");
    expect(manager.receipt(graph.id).completion_claim).toBe("no_completion_claim");
  });

  it("fails approved-but-not-started work closed after restart", () => {
    const { manager, file } = harness();
    const graph = manager.preview({ objective: "Restart boundary", nodes: nodes() });
    const disk = JSON.parse(readFileSync(file, "utf8"));
    disk.graphs[0].status = "approved";
    disk.graphs[0].approvedAt = disk.graphs[0].updatedAt + 1;
    disk.graphs[0].updatedAt += 1;
    writeFileSync(file, JSON.stringify(disk));

    const restarted = new AgentGraphManager({
      file,
      routeState: () => "ready",
      createTask: () => null,
      startTurn: async () => {},
    });
    expect(restarted.get(graph.id)).toMatchObject({
      status: "blocked",
      nodes: [
        { status: "blocked", error: expect.stringMatching(/fresh preview/) },
        { status: "blocked", error: expect.stringMatching(/fresh preview/) },
        { status: "blocked", error: expect.stringMatching(/fresh preview/) },
      ],
    });
  });

  it("keeps runtime errors diagnostic until exact completion and settles a thread only once", async () => {
    const first = harness();
    const faulted = first.manager.preview({ objective: "Runtime fault", nodes: nodes() });
    await first.manager.approve(faulted.id, faulted.graphHash);
    first.manager.handleRuntimeEvent({
      eventId: "runtime-fault", provider: "fake", threadId: "thread-1", createdAt: new Date().toISOString(),
      providerInstanceId: routeA.instanceId, turnId: "turn-thread-1",
      type: "runtime.error", message: "capability denied",
    });
    expect(first.manager.get(faulted.id)?.status).toBe("running");
    expect(first.manager.get(faulted.id)?.nodes[0]).toMatchObject({
      status: "running",
      error: "capability denied",
    });
    expect(first.manager.authorizationForThread("thread-1")).not.toBeNull();
    expect(first.manager.receipt(faulted.id).completion_claim).toBe("no_completion_claim");
    first.manager.handleRuntimeEvent(event("thread-1", true));
    expect(first.manager.get(faulted.id)?.nodes[0]?.status).toBe("completed");
    expect(first.manager.get(faulted.id)?.nodes[0]?.error).toBeUndefined();
    expect(first.manager.handleRuntimeEvent(event("thread-1", false))).toBeNull();
    expect(first.manager.get(faulted.id)?.nodes[0]?.status).toBe("completed");

    const second = harness();
    const denied = second.manager.preview({ objective: "Denied completion", nodes: nodes() });
    await second.manager.approve(denied.id, denied.graphHash);
    second.manager.handleRuntimeEvent(event("thread-1", true, ["protected action"]));
    expect(second.manager.get(denied.id)?.status).toBe("blocked");
    expect(second.manager.get(denied.id)?.nodes[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/denied actions/) });
    expect(second.manager.receipt(denied.id).completion_claim).toBe("partial_execution_failed_or_blocked");
  });

  it("keeps a blocked failure receipt immutable when cancellation is requested", async () => {
    const { manager } = harness();
    const graph = manager.preview({ objective: "Blocked cancellation", nodes: nodes() });
    await manager.approve(graph.id, graph.graphHash);
    manager.handleRuntimeEvent(event("thread-1", false));
    const before = manager.receipt(graph.id);
    const after = await manager.cancel(graph.id);
    expect(after.status).toBe("blocked");
    expect(manager.receipt(graph.id)).toEqual(before);
  });
});
