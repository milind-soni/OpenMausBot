import type {
  AgentGraphNodeInput,
  AgentGraphPreviewInput,
  AgentGraphProposalSnapshot,
  AgentGraphRoute,
} from "./agent-graphs.ts";

export interface AgentGraphRouteCandidate extends AgentGraphRoute {
  name: string;
  title: string;
  chiefOfStaff: boolean;
  hermes: boolean;
}

export interface AgentGraphDraftRequest {
  objective: string;
  proposalIds?: string[];
  feedHash?: string | null;
  proposalSnapshots?: AgentGraphProposalSnapshot[];
  goalId?: string | null;
}

function uniqueRoutes(candidates: AgentGraphRouteCandidate[]): AgentGraphRoute[] {
  const seen = new Set<string>();
  return candidates.flatMap(({ botId, instanceId, engine, model, workspaceRoot, workspaceIdentity, authorityDigest }) => {
    const key = `${botId}\0${instanceId}\0${engine}\0${model}\0${workspaceIdentity}\0${authorityDigest}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ botId, instanceId, engine, model, workspaceRoot, workspaceIdentity, authorityDigest }];
  });
}

function ordered(
  candidates: AgentGraphRouteCandidate[],
  score: (candidate: AgentGraphRouteCandidate) => number,
): AgentGraphRoute[] {
  return uniqueRoutes([...candidates].sort((left, right) => {
    const delta = score(right) - score(left);
    return delta || left.name.localeCompare(right.name) || left.botId.localeCompare(right.botId);
  })).slice(0, 8);
}

/**
 * Build one deterministic, bounded draft. This is intentionally model-free:
 * the Chief control plane chooses from already admitted OpenMaus routes and
 * AgentGraphManager performs the authoritative DAG/hash validation.
 */
export function buildAgentGraphDraft(
  request: AgentGraphDraftRequest,
  candidates: AgentGraphRouteCandidate[],
): AgentGraphPreviewInput {
  if (!candidates.length) throw new Error("no admitted OpenMaus bot route is ready for graph preview");
  const qualityWords = /qa|quality|review|test|verify|acceptance|security/i;
  const implementationWords = /code|engineer|implement|source|developer|build/i;
  const memoryWords = /memory|research|retriev|observer|hermes|analysis/i;
  const inspectRoutes = ordered(candidates, (candidate) =>
    (candidate.hermes ? 40 : 0) + (memoryWords.test(`${candidate.name} ${candidate.title}`) ? 25 : 0) + (candidate.chiefOfStaff ? 10 : 0));
  const planRoutes = ordered(candidates, (candidate) =>
    (candidate.chiefOfStaff ? 50 : 0) + (candidate.hermes ? 20 : 0));
  const implementRoutes = ordered(candidates, (candidate) =>
    (implementationWords.test(`${candidate.name} ${candidate.title}`) ? 40 : 0) + (candidate.chiefOfStaff ? 15 : 0) - (candidate.hermes ? 5 : 0));
  const verifyRoutes = ordered(candidates, (candidate) =>
    (qualityWords.test(`${candidate.name} ${candidate.title}`) ? 45 : 0) + (candidate.chiefOfStaff ? 10 : 0) - (candidate.hermes ? 5 : 0));
  const nodes: AgentGraphNodeInput[] = [
    {
      id: "inspect",
      title: "Inspect the objective, selected proposals, and current source truth",
      role: "Memory and Improvement Steward",
      kind: "inspect",
      dependsOn: [],
      routes: inspectRoutes,
      permissionClass: "read",
      successCriteria: [
        "Current source, installed state, and relevant durable evidence are distinguished",
        "The bounded implementation surface and protected gates are identified",
      ],
      proofRequirements: ["Exact paths, hashes, and fresh read-only receipts"],
    },
    {
      id: "plan",
      title: "Turn the approved objective into a bounded implementation handoff",
      role: "Chief of Staff",
      kind: "plan",
      dependsOn: [],
      routes: planRoutes,
      permissionClass: "read",
      successCriteria: [
        "The implementation handoff stays within the approved objective",
        "Dependencies, validation, rollback, and protected actions are explicit",
      ],
      proofRequirements: ["A task-local handoff capsule with no new authority claims"],
    },
    {
      id: "implement",
      title: "Implement the bounded safe-local change",
      role: "Implementation Specialist",
      kind: "implement",
      dependsOn: ["inspect", "plan"],
      routes: implementRoutes,
      permissionClass: "workspace-write",
      successCriteria: [
        "The smallest coherent approved change is implemented without overwriting owner work",
        "Normal credential, external-write, merge, deployment, release, and destructive gates remain active",
      ],
      proofRequirements: ["Exact changed paths and focused deterministic test results"],
    },
    {
      id: "verify",
      title: "Verify the implemented outcome and calibrate completion claims",
      role: "QA and Acceptance",
      kind: "verify",
      dependsOn: ["implement"],
      routes: verifyRoutes,
      permissionClass: "read",
      successCriteria: [
        "Exact changed files and content hashes satisfy the approved acceptance criteria",
        "Source, installed, live, and release claims remain separate",
      ],
      // Graph turns intentionally have no shell lane: provider-native tools
      // and shell_execute are denied. The node gathers bounded read-only
      // evidence; a separate one-use desktop approval promotes only the exact
      // receipt after the host validates any command-based acceptance outside
      // the graph turn.
      proofRequirements: ["Exact read-only file and content-hash evidence plus the host-verified acceptance receipt"],
    },
  ];
  return {
    objective: request.objective,
    proposalIds: request.proposalIds,
    feedHash: request.feedHash,
    proposalSnapshots: request.proposalSnapshots,
    goalId: request.goalId,
    maxParallel: 2,
    nodes,
  };
}
