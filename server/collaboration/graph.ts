import {
  PlanValidationError,
  WORK_NODE_TYPES,
  type PlannerProposal,
  type WorkNodeType,
} from "./planner.ts";

export interface PlanningPolicy {
  allowedRepositories: readonly string[];
  supportedAgents: Record<WorkNodeType, readonly string[]>;
  allowedCommands: readonly string[];
  requiredDenyScopes: readonly string[];
  limits: {
    maxCommandsPerPlan: number;
    maxMinutesPerNode: number;
    maxAttemptsPerNode: number;
    maxTokensPerNode: number;
    maxTokensPerPlan: number;
  };
}

export interface ValidatedSequentialPlan extends PlannerProposal {
  nodes: PlannerProposal["nodes"];
}

function hasCycle(nodes: PlannerProposal["nodes"]): boolean {
  const dependencies = new Map(nodes.map((node) => [node.id, node.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (dependencies.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return nodes.some((node) => visit(node.id));
}

export function validateSequentialPlan(proposal: PlannerProposal, policy: PlanningPolicy): ValidatedSequentialPlan {
  const issues: string[] = [];
  const ids = proposal.nodes.map((node) => node.id);
  if (new Set(ids).size !== ids.length) issues.push("node IDs must be unique");

  proposal.nodes.forEach((node, index) => {
    const expectedType = WORK_NODE_TYPES[index];
    if (node.type !== expectedType) issues.push(`node ${index + 1} must be ${expectedType}`);
    if (!policy.supportedAgents[node.type].includes(node.agentId)) {
      issues.push(`${node.id} uses unsupported ${node.type} agent ${node.agentId}`);
    }
    for (const dependency of node.dependsOn) {
      if (!ids.includes(dependency)) issues.push(`${node.id} depends on unknown node ${dependency}`);
    }
    for (const command of node.commands) {
      if (!policy.allowedCommands.includes(command)) issues.push(`${node.id} uses command outside the allowlist: ${command}`);
    }
    for (const denied of policy.requiredDenyScopes) {
      if (!node.denyScope.includes(denied)) issues.push(`${node.id} omits required deny scope ${denied}`);
    }
    if (node.type === "modify" && node.writeScope.length === 0) {
      issues.push(`${node.id} must declare a write scope`);
    }
    if (node.type !== "modify" && node.writeScope.length > 0) {
      issues.push(`${node.id} cannot declare a write scope`);
    }
    if (node.budget.maxMinutes > policy.limits.maxMinutesPerNode) {
      issues.push(`${node.id} exceeds the per-node time budget`);
    }
    if (node.budget.maxAttempts > policy.limits.maxAttemptsPerNode) {
      issues.push(`${node.id} exceeds the per-node attempt budget`);
    }
    if (node.budget.maxTokens > policy.limits.maxTokensPerNode) {
      issues.push(`${node.id} exceeds the per-node token budget`);
    }
  });

  const commandCount = proposal.nodes.reduce((total, node) => total + node.commands.length, 0);
  if (commandCount > policy.limits.maxCommandsPerPlan) issues.push("plan exceeds the command-count budget");
  const totalTokens = proposal.nodes.reduce((total, node) => total + node.budget.maxTokens, 0);
  if (totalTokens > policy.limits.maxTokensPerPlan) issues.push("plan exceeds the total token budget");

  const byType = new Map(proposal.nodes.map((node) => [node.type, node]));
  for (const type of WORK_NODE_TYPES) {
    if (!byType.has(type)) issues.push(`plan is missing ${type} node`);
  }
  if (proposal.nodes.length === 4 && new Set(ids).size === 4) {
    const expectedDependencies: Array<readonly string[]> = [
      [],
      [proposal.nodes[0].id],
      [proposal.nodes[1].id],
      [proposal.nodes[2].id],
    ];
    proposal.nodes.forEach((node, index) => {
      const expected = expectedDependencies[index];
      if (node.dependsOn.length !== expected.length || node.dependsOn.some((id, offset) => id !== expected[offset])) {
        issues.push(`${node.id} does not follow the fixed analyze→modify→validate→report dependency chain`);
      }
    });
  }
  if (hasCycle(proposal.nodes)) issues.push("plan graph must be acyclic");
  if (issues.length) throw new PlanValidationError(issues);
  return proposal;
}
