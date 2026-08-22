import approval from "./agent-graph-approval.cjs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const hash = (value) => `sha256:${value.repeat(64)}`;
const canonical = (value) => {
  const visit = (item) => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, nested]) => [key, visit(nested)]),
    );
  };
  return JSON.stringify(visit(value));
};
const canonicalHash = (value) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
const graph = {
  id: "graph-1",
  graphHash: hash("a"),
  status: "draft",
  objective: "Implement bounded retrieval",
  feedHash: hash("b"),
  proposalSnapshots: [{
    proposalId: "proposal-1",
    contentHash: hash("c"),
    evidenceHashes: [hash("d")],
    proposedChange: "Bind the exact retrieval snapshot",
    risk: "Low, local-only",
    tests: ["Canary does not cross tasks"],
    rollback: "Remove the bounded retrieval adapter",
  }],
  nodes: [{
    id: "inspect",
    title: "Inspect source",
    role: "reviewer",
    permissionClass: "read",
    routes: [{
      botId: "bot-1",
      instanceId: "instance-1",
      engine: "claudeAgent",
      model: "claude-test",
      workspaceRoot: "/tmp/project",
      workspaceIdentity: hash("e"),
      authorityDigest: hash("f"),
    }],
  }],
};

describe("native graph approval manifest", () => {
  it("renders the server-owned objective, permissions, routes, workspace identity, and proposal hashes", () => {
    const detail = approval.graphApprovalDetail({ graph }, graph.id, graph.graphHash);
    for (const value of [
      graph.objective,
      "permission=read",
      "claudeAgent",
      "/tmp/project",
      hash("e"),
      hash("f"),
      hash("b"),
      hash("c"),
      hash("d"),
      "Bind the exact retrieval snapshot",
      "Low, local-only",
      "Canary does not cross tasks",
      "Remove the bounded retrieval adapter",
    ]) expect(detail).toContain(value);
  });

  it("strips bidi display controls from native approval semantics", () => {
    const spoofed = structuredClone(graph);
    spoofed.proposalSnapshots[0].risk = "low\u202Ehigh";
    const detail = approval.graphApprovalDetail({ graph: spoofed }, graph.id, graph.graphHash);
    expect(detail).toContain("risk=lowhigh");
    expect(detail).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/i);
  });

  it("fails closed on an id, hash, status, or route mismatch", () => {
    expect(() => approval.graphApprovalDetail({ graph }, "graph-2", graph.graphHash)).toThrow(/changed/);
    expect(() => approval.graphApprovalDetail({ graph }, graph.id, hash("f"))).toThrow(/changed/);
    expect(() => approval.graphApprovalDetail({ graph: { ...graph, status: "approved" } }, graph.id, graph.graphHash)).toThrow(/changed/);
    expect(() => approval.graphApprovalDetail({ graph: { ...graph, nodes: [{ ...graph.nodes[0], routes: [] }] } }, graph.id, graph.graphHash)).toThrow(/route/);
  });
});

describe("native graph host-verification manifest", () => {
  const completedGraph = {
    ...structuredClone(graph),
    status: "completed",
    nodes: [{
      ...structuredClone(graph.nodes[0]),
      status: "completed",
      selectedRoute: structuredClone(graph.nodes[0].routes[0]),
      proofRequirements: ["Exact read-only source and content hash"],
    }],
  };
  const receipt = {
    schema: "openmaus.agent_graph_run_receipt.v1",
    graph_id: graph.id,
    graph_hash: graph.graphHash,
    status: "completed",
    proposal_ids: [],
    feed_hash: null,
    proposal_content_hashes: [],
    goal_id: null,
    created_at: "2026-08-22T00:00:00.000Z",
    approved_at: "2026-08-22T00:01:00.000Z",
    finished_at: "2026-08-22T00:02:00.000Z",
    automatic_mutation: false,
    model_weights_changed: false,
    instruction_authority: false,
    verified_at: null,
    evidence_manifest_hash: null,
    verification_status: "unverified",
    completion_claim: "provider_turns_completed_with_task_receipts_unverified",
    nodes: [{
      id: "inspect",
      status: "completed",
      bot_id: "bot-1",
      engine: "claudeAgent",
      model: "claude-test",
      instance_id: "instance-1",
      workspace_root: "/tmp/project",
      workspace_identity: hash("e"),
      task_id: "task-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
      permission_class: "read",
      evidence_status: "task-receipt-only",
      proof_refs: ["thread:thread-1"],
      verified_evidence: [],
      error: null,
    }],
  };
  const receiptHash = canonicalHash(receipt);
  const hostEvidence = [{
    node_id: "inspect",
    relative_path: "src/index.ts",
    workspace_identity: hash("e"),
    sha256: hash("9"),
    bytes: 123,
  }];
  const payloadFor = (currentReceipt, evidence = hostEvidence) => {
    const currentReceiptHash = canonicalHash(currentReceipt);
    return {
      graph: completedGraph,
      receipt: currentReceipt,
      receiptHash: currentReceiptHash,
      verificationPreview: {
        graph_id: graph.id,
        graph_hash: graph.graphHash,
        receipt_hash: currentReceiptHash,
        evidence_manifest_hash: canonicalHash(evidence),
        evidence,
      },
    };
  };

  it("renders the exact run, authority, requirements, and proof references", () => {
    const detail = approval.graphVerificationDetail(
      payloadFor(receipt),
      graph.id,
      graph.graphHash,
      receiptHash,
    );
    for (const value of [
      receiptHash,
      "task=task-1",
      "thread=thread-1",
      "turn=turn-1",
      hash("e"),
      hash("f"),
      "Exact read-only source and content hash",
      "proof=thread:thread-1",
      "file=src/index.ts",
      hash("9"),
    ]) expect(detail).toContain(value);
  });

  it("fails closed on a stale hash, partial evidence, redaction, or already-verified receipt", () => {
    expect(() => approval.graphVerificationDetail(
      payloadFor(receipt), graph.id, graph.graphHash, hash("0"),
    )).toThrow(/changed/);
    const partial = structuredClone(receipt);
    partial.nodes[0].turn_id = null;
    expect(() => approval.graphVerificationDetail(
      payloadFor(partial),
      graph.id, graph.graphHash, canonicalHash(partial),
    )).toThrow(/partial/);
    const redacted = structuredClone(receipt);
    redacted.nodes[0].proof_refs.push("[REDACTED]");
    expect(() => approval.graphVerificationDetail(
      payloadFor(redacted),
      graph.id, graph.graphHash, canonicalHash(redacted),
    )).toThrow(/redacted/);
    const verified = { ...structuredClone(receipt), verification_status: "verified" };
    expect(() => approval.graphVerificationDetail(
      payloadFor(verified),
      graph.id, graph.graphHash, canonicalHash(verified),
    )).toThrow(/changed/);
    expect(() => approval.graphVerificationDetail(
      payloadFor(receipt, []), graph.id, graph.graphHash, receiptHash,
    )).toThrow(/partial/);
    expect(() => approval.graphVerificationDetail(
      payloadFor(receipt, [{ ...hostEvidence[0], relative_path: "../secret" }]),
      graph.id, graph.graphHash, receiptHash,
    )).toThrow(/invalid host file evidence/);
  });
});
