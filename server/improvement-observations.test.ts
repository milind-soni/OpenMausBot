import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeVerifiedAgentGraphObservation } from "./improvement-observations.ts";
import type { AgentGraphRunReceipt } from "./agent-graphs.ts";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function receipt(status: AgentGraphRunReceipt["status"], verified = false): AgentGraphRunReceipt {
  return {
    schema: "openmaus.agent_graph_run_receipt.v1",
    graph_id: "graph-1",
    graph_hash: `sha256:${"a".repeat(64)}`,
    status,
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
    verified_at: verified ? "2026-08-22T00:03:00.000Z" : null,
    evidence_manifest_hash: verified ? `sha256:${"e".repeat(64)}` : null,
    verification_status: verified ? "verified" : "unverified",
    completion_claim: verified ? "verified_with_host_checked_evidence" : "provider_turns_completed_with_task_receipts_unverified",
    nodes: [{
      id: "verify", status: status === "completed" ? "completed" : "blocked", bot_id: "bot-1", engine: "codexAgent", model: "gpt",
      instance_id: "instance-1", workspace_root: "/tmp/project", workspace_identity: `sha256:${"d".repeat(64)}`,
      task_id: "task-1", thread_id: "thread-1", turn_id: "turn-1", permission_class: "read",
      evidence_status: verified ? "verified" : status === "completed" ? "task-receipt-only" : "none",
      proof_refs: ["thread:thread-1"], error: null,
      verified_evidence: verified ? [{
        node_id: "verify",
        relative_path: "result.txt",
        workspace_identity: `sha256:${"d".repeat(64)}`,
        sha256: `sha256:${"f".repeat(64)}`,
        bytes: 12,
      }] : [],
    }],
  };
}

describe("verified graph observations", () => {
  it("writes only a completed, fully verified graph as non-authoritative observation data", () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-observations-"));
    temporary.push(directory);
    expect(writeVerifiedAgentGraphObservation(receipt("blocked"), { directory })).toBeNull();
    expect(writeVerifiedAgentGraphObservation(receipt("completed"), { directory })).toBeNull();
    const verified = receipt("completed", true);
    const path = writeVerifiedAgentGraphObservation(verified, { directory });
    expect(basename(path!)).toMatch(/^observation-[a-f0-9]{32}\.json$/);
    const observation = JSON.parse(readFileSync(path!, "utf8"));
    expect(observation).toMatchObject({
      schema: "improvement_observation.v1",
      surface: "openmaus",
      project: "openmausbot",
      category: "verified_agent_graph",
      sensitivity: "restricted",
    });
    expect(observation.evidence_refs).toEqual([
      `sha256:${"a".repeat(64)}`,
      expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      `sha256:${"e".repeat(64)}`,
      "thread:thread-1",
      `sha256:${"f".repeat(64)}`,
    ]);
    expect(Object.keys(observation).sort()).toEqual([
      "category", "dedupe_key", "evidence_refs", "observation_id", "project",
      "schema", "sensitivity", "summary", "surface", "timestamp",
    ]);
    expect(observation.timestamp).toBe("2026-08-22T00:03:00.000Z");
    expect(writeVerifiedAgentGraphObservation(verified, { directory })).toBeNull();
    expect(readdirSync(directory)).toEqual([basename(path!)]);
    writeFileSync(path!, "{}\n");
    expect(() => writeVerifiedAgentGraphObservation(verified, { directory })).toThrow(/different content/);
  });

  it("creates no observation when the approved directory path is replaced before the anchored write", () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-observations-race-"));
    const displaced = `${directory}-before-swap`;
    temporary.push(directory, displaced);
    expect(() => writeVerifiedAgentGraphObservation(receipt("completed", true), {
      directory,
      beforeAnchoredWrite: () => {
        renameSync(directory, displaced);
        mkdirSync(directory);
      },
    })).toThrow(/parent identity changed/);
    expect(readdirSync(directory)).toEqual([]);
    expect(readdirSync(displaced)).toEqual([]);
  });
});
