export const AGENT_GRAPH_SCHEMA = "openmaus.agent_graph.v1" as const;
export const AGENT_GRAPH_RECEIPT_SCHEMA = "openmaus.agent_graph_run_receipt.v1" as const;

export type AgentGraphPermissionClass = "read" | "workspace-write" | "protected";
export type AgentGraphNodeKind = "inspect" | "plan" | "implement" | "verify" | "closeout";
export type AgentGraphNodeStatus =
  | "pending"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";
export type AgentGraphStatus = "draft" | "approved" | "running" | "blocked" | "completed" | "cancelled";

export interface AgentGraphRoute {
  botId: string;
  instanceId: string;
  model: string;
  engine: string;
  /** Exact local desk authorized by the graph hash. */
  workspaceRoot: string;
  /** Worktree-aware identity derived from the real workspace and git dir. */
  workspaceIdentity: string;
  /** Hash of the enforced provider-broker and graph permission posture. */
  authorityDigest: string;
}

export interface AgentGraphProposalSnapshot {
  proposalId: string;
  title: string;
  proposedChange: string | null;
  recurrence: number;
  risk: string | null;
  tests: string[];
  rollback: string | null;
  contentHash: string;
  evidenceHashes: string[];
}

export interface AgentGraphNodeInput {
  id: string;
  title: string;
  role: string;
  kind: AgentGraphNodeKind;
  dependsOn: string[];
  routes: AgentGraphRoute[];
  permissionClass: AgentGraphPermissionClass;
  successCriteria: string[];
  proofRequirements: string[];
}

export interface AgentGraphNode extends AgentGraphNodeInput {
  status: AgentGraphNodeStatus;
  selectedRoute?: AgentGraphRoute;
  taskId?: string;
  threadId?: string;
  turnId?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Persisted request marker; the node remains active until its exact
   * provider turn emits a terminal completion after capability revocation. */
  cancellationRequestedAt?: number;
  error?: string;
  proofRefs: string[];
}

export interface AgentGraph {
  schema: typeof AGENT_GRAPH_SCHEMA;
  id: string;
  /** Monotonic, persisted version used to order REST snapshots and SSE updates.
   * Draft creation starts at 1 and every durable graph transition increments it. */
  revision: number;
  objective: string;
  proposalIds: string[];
  feedHash: string | null;
  proposalSnapshots: AgentGraphProposalSnapshot[];
  goalId: string | null;
  maxParallel: 1 | 2;
  graphHash: string;
  status: AgentGraphStatus;
  nodes: AgentGraphNode[];
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  finishedAt?: number;
}

export interface AgentGraphPreviewInput {
  objective: string;
  proposalIds?: string[];
  feedHash?: string | null;
  proposalSnapshots?: AgentGraphProposalSnapshot[];
  goalId?: string | null;
  maxParallel?: 1 | 2;
  nodes: AgentGraphNodeInput[];
}

export interface AgentGraphVerificationPathInput {
  nodeId: string;
  /** Normalized relative to the node's exact approved workspace. */
  relativePath: string;
}

export interface AgentGraphVerificationEvidence {
  node_id: string;
  relative_path: string;
  workspace_identity: string;
  sha256: string;
  bytes: number;
}

export interface AgentGraphVerificationPreview {
  graph_id: string;
  graph_hash: string;
  receipt_hash: string;
  evidence_manifest_hash: string;
  evidence: AgentGraphVerificationEvidence[];
}

export interface AgentGraphRunReceipt {
  schema: typeof AGENT_GRAPH_RECEIPT_SCHEMA;
  graph_id: string;
  graph_hash: string;
  status: AgentGraphStatus;
  proposal_ids: string[];
  feed_hash: string | null;
  proposal_content_hashes: Array<{ proposal_id: string; content_hash: string }>;
  goal_id: string | null;
  created_at: string;
  approved_at: string | null;
  finished_at: string | null;
  automatic_mutation: false;
  model_weights_changed: false;
  instruction_authority: false;
  verified_at: string | null;
  evidence_manifest_hash: string | null;
  verification_status: "unverified" | "verified";
  completion_claim:
    | "no_completion_claim"
    | "partial_execution_failed_or_blocked"
    | "cancelled_before_verified_completion"
    | "provider_turns_completed_with_task_receipts_unverified"
    | "verified_with_host_checked_evidence";
  nodes: Array<{
    id: string;
    status: AgentGraphNodeStatus;
    bot_id: string | null;
    engine: string | null;
    model: string | null;
    instance_id: string | null;
    workspace_root: string | null;
    workspace_identity: string | null;
    task_id: string | null;
    thread_id: string | null;
    turn_id: string | null;
    permission_class: AgentGraphPermissionClass;
    evidence_status: "task-receipt-only" | "verified" | "none";
    proof_refs: string[];
    verified_evidence: AgentGraphVerificationEvidence[];
    error: string | null;
  }>;
}
