"use strict";

const { createHash } = require("node:crypto");

const HASH = /^sha256:[0-9a-f]{64}$/;
const ID = /^[\w-]+$/;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/i;
const REDACTED = /(?:\b(?:redacted|omitted|withheld)\b|\*{3,}|\[(?:secret|private)\])/i;

function text(value, max = 500) {
  return typeof value === "string"
    ? value.replace(/[\u202a-\u202e\u2066-\u2069]/gi, "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max)
    : "";
}

function canonical(value) {
  const visit = (item) => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(
      Object.entries(item)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, visit(nested)]),
    );
  };
  return JSON.stringify(visit(value));
}

function canonicalHash(value) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

/** Validate the server-owned immutable draft and render its semantic scope. */
function graphApprovalDetail(payload, expectedId, expectedHash) {
  if (!ID.test(expectedId) || !HASH.test(expectedHash)) throw new Error("Invalid agent graph approval target");
  const graph = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.graph : null;
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) throw new Error("Agent graph draft is unavailable");
  if (graph.id !== expectedId || graph.graphHash !== expectedHash || graph.status !== "draft") {
    throw new Error("Agent graph changed before approval; preview it again");
  }
  if (!Array.isArray(graph.nodes) || graph.nodes.length < 1 || graph.nodes.length > 32) {
    throw new Error("Agent graph node manifest is invalid");
  }

  const lines = [
    `Graph: ${expectedId}`,
    `Exact hash: ${expectedHash}`,
    `Objective: ${text(graph.objective, 800) || "(missing)"}`,
    `Proposal feed: ${HASH.test(graph.feedHash) ? graph.feedHash : "none"}`,
  ];
  const proposals = Array.isArray(graph.proposalSnapshots) ? graph.proposalSnapshots.slice(0, 20) : [];
  if (proposals.length) {
    lines.push("Proposals:");
    for (const proposal of proposals) {
      const evidence = Array.isArray(proposal?.evidenceHashes)
        ? proposal.evidenceHashes.filter((value) => HASH.test(value)).slice(0, 8).join(", ")
        : "";
      lines.push(`- ${text(proposal?.proposalId, 100)} content=${HASH.test(proposal?.contentHash) ? proposal.contentHash : "invalid"}${evidence ? ` evidence=${evidence}` : ""}`);
      lines.push(`  change=${text(proposal?.proposedChange, 1_500) || "(none)"}`);
      lines.push(`  risk=${text(proposal?.risk, 700) || "(none)"}`);
      const tests = Array.isArray(proposal?.tests) ? proposal.tests.slice(0, 5).map((value) => text(value, 400)).filter(Boolean) : [];
      lines.push(`  tests=${tests.join(" | ") || "(none)"}`);
      lines.push(`  rollback=${text(proposal?.rollback, 700) || "(none)"}`);
    }
  }
  lines.push("Nodes:");
  for (const [index, node] of graph.nodes.entries()) {
    const routes = Array.isArray(node?.routes) ? node.routes.slice(0, 8) : [];
    if (!routes.length) throw new Error("Agent graph route manifest is invalid");
    lines.push(`${index + 1}. ${text(node.id, 100)} — ${text(node.title, 300)}`);
    lines.push(`   role=${text(node.role, 100)} permission=${text(node.permissionClass, 40)}`);
    for (const route of routes) {
      lines.push(`   route=${text(route?.botId, 100)} / ${text(route?.engine, 80)} / ${text(route?.model, 160)}`);
      lines.push(`   workspace=${text(route?.workspaceRoot, 700)}`);
      lines.push(`   workspace identity=${HASH.test(route?.workspaceIdentity) ? route.workspaceIdentity : "invalid"}`);
      lines.push(`   authority digest=${HASH.test(route?.authorityDigest) ? route.authorityDigest : "invalid"}`);
    }
  }
  const detail = lines.join("\n");
  if (detail.length > 16_000) throw new Error("Agent graph approval manifest is too large");
  return detail;
}

/** Render and independently bind the exact completed run the host is asked
 * to promote. The server still performs the authoritative admission refresh;
 * this native manifest ensures the visible approval covers every requirement,
 * route identity, task/turn identity, and proof reference in the receipt. */
function graphVerificationDetail(payload, expectedId, expectedGraphHash, expectedReceiptHash) {
  if (!ID.test(expectedId) || !HASH.test(expectedGraphHash) || !HASH.test(expectedReceiptHash)) {
    throw new Error("Invalid agent graph verification target");
  }
  const graph = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.graph : null;
  const receipt = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.receipt : null;
  const preview = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.verificationPreview : null;
  if (!graph || typeof graph !== "object" || Array.isArray(graph) ||
      !receipt || typeof receipt !== "object" || Array.isArray(receipt) ||
      !preview || typeof preview !== "object" || Array.isArray(preview)) {
    throw new Error("Agent graph verification evidence is unavailable");
  }
  if (
    payload.receiptHash !== expectedReceiptHash || canonicalHash(receipt) !== expectedReceiptHash ||
    graph.id !== expectedId || graph.graphHash !== expectedGraphHash || graph.status !== "completed" ||
    receipt.graph_id !== expectedId || receipt.graph_hash !== expectedGraphHash || receipt.status !== "completed" ||
    receipt.verification_status !== "unverified" ||
    receipt.completion_claim !== "provider_turns_completed_with_task_receipts_unverified" ||
    receipt.automatic_mutation !== false || receipt.model_weights_changed !== false ||
    receipt.instruction_authority !== false || typeof receipt.finished_at !== "string" ||
    receipt.verified_at !== null || receipt.evidence_manifest_hash !== null ||
    preview.graph_id !== expectedId || preview.graph_hash !== expectedGraphHash ||
    preview.receipt_hash !== expectedReceiptHash || !HASH.test(preview.evidence_manifest_hash) ||
    !Array.isArray(preview.evidence) || canonicalHash(preview.evidence) !== preview.evidence_manifest_hash
  ) throw new Error("Agent graph run changed before verification; read it again");
  if (
    !Array.isArray(graph.nodes) || !Array.isArray(receipt.nodes) || !graph.nodes.length ||
    graph.nodes.length !== receipt.nodes.length || graph.nodes.length > 40
  ) throw new Error("Agent graph verification node manifest is invalid");

  const lines = [
    `Graph: ${expectedId}`,
    `Exact graph hash: ${expectedGraphHash}`,
    `Exact run receipt hash: ${expectedReceiptHash}`,
    `Exact evidence manifest hash: ${preview.evidence_manifest_hash}`,
    `Finished: ${text(receipt.finished_at, 100)}`,
    "Completed nodes and host evidence:",
  ];
  for (const [index, graphNode] of graph.nodes.entries()) {
    const evidence = receipt.nodes[index];
    const route = graphNode?.selectedRoute;
    const requirements = Array.isArray(graphNode?.proofRequirements) ? graphNode.proofRequirements : [];
    const references = Array.isArray(evidence?.proof_refs) ? evidence.proof_refs : [];
    const hostEvidence = preview.evidence.filter((item) => item?.node_id === graphNode?.id);
    if (
      !graphNode || !evidence || evidence.id !== graphNode.id || graphNode.status !== "completed" ||
      evidence.status !== "completed" || evidence.evidence_status !== "task-receipt-only" || evidence.error !== null ||
      !Array.isArray(evidence.verified_evidence) || evidence.verified_evidence.length !== 0 ||
      !route || typeof route !== "object" || !requirements.length || requirements.length > 10 ||
      !hostEvidence.length || hostEvidence.length > 8 ||
      !references.length || references.length > 40 || new Set(references).size !== references.length ||
      !references.includes(`thread:${evidence.thread_id}`) ||
      ![evidence.task_id, evidence.thread_id, evidence.turn_id, evidence.bot_id, evidence.instance_id,
        evidence.engine, evidence.model, evidence.workspace_root, evidence.workspace_identity].every((value) =>
        typeof value === "string" && value.length > 0) ||
      evidence.bot_id !== route.botId || evidence.instance_id !== route.instanceId ||
      evidence.engine !== route.engine || evidence.model !== route.model ||
      evidence.workspace_root !== route.workspaceRoot || evidence.workspace_identity !== route.workspaceIdentity ||
      !HASH.test(route.workspaceIdentity) || !HASH.test(route.authorityDigest)
    ) throw new Error(`Agent graph node ${text(graphNode?.id, 100) || index + 1} has partial verification evidence`);
    if (references.some((reference) => typeof reference !== "string" || BIDI.test(reference) || REDACTED.test(reference))) {
      throw new Error(`Agent graph node ${text(graphNode.id, 100)} contains redacted verification evidence`);
    }
    if (hostEvidence.some((item) =>
      !item || typeof item.relative_path !== "string" || !item.relative_path || item.relative_path.length > 700 ||
      /^(?:[\\/]|[A-Za-z]:[\\/])/.test(item.relative_path) ||
      item.relative_path.split(/[\\/]/).includes("..") || BIDI.test(item.relative_path) || REDACTED.test(item.relative_path) ||
      item.workspace_identity !== route.workspaceIdentity || !HASH.test(item.sha256) ||
      !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 1024 * 1024
    )) throw new Error(`Agent graph node ${text(graphNode.id, 100)} contains invalid host file evidence`);
    lines.push(`${index + 1}. ${text(graphNode.id, 100)} — ${text(graphNode.title, 300)}`);
    lines.push(`   task=${text(evidence.task_id, 200)} thread=${text(evidence.thread_id, 200)} turn=${text(evidence.turn_id, 200)}`);
    lines.push(`   route=${text(route.botId, 100)} / ${text(route.engine, 80)} / ${text(route.model, 160)}`);
    lines.push(`   workspace=${text(route.workspaceRoot, 700)}`);
    lines.push(`   workspace identity=${route.workspaceIdentity}`);
    lines.push(`   authority digest=${route.authorityDigest}`);
    for (const requirement of requirements) lines.push(`   requirement=${text(requirement, 500)}`);
    for (const reference of references) lines.push(`   proof=${text(reference, 500)}`);
    for (const item of hostEvidence) {
      lines.push(`   file=${text(item.relative_path, 700)} sha256=${item.sha256} bytes=${item.bytes}`);
    }
  }
  const detail = lines.join("\n");
  if (detail.length > 24_000) throw new Error("Agent graph verification manifest is too large");
  return detail;
}

module.exports = { graphApprovalDetail, graphVerificationDetail };
