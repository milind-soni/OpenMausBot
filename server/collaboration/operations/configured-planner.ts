import type { PlanningPolicy } from "../graph.ts";
import type { PlannerPort, PlannerProposal } from "../planner.ts";
import type { WorkItemSnapshot } from "../snapshot.ts";

const AGENT_ID = "codex-patch";

export interface ConfiguredPlannerOptions {
  repository: string;
  writeScopes: readonly string[];
  targetCommandIds: readonly string[];
  denyScopes?: readonly string[];
  maxMinutes?: number;
  maxAttempts?: number;
  maxTokens?: number;
}

export class ConfiguredSequentialPlanner implements PlannerPort {
  private readonly options: Required<ConfiguredPlannerOptions>;

  constructor(options: ConfiguredPlannerOptions) {
    if (!options.repository.trim()) throw new Error("configured_planner_repository_required");
    if (!options.writeScopes.length || options.writeScopes.some((scope) => !scope.trim())) {
      throw new Error("configured_planner_write_scopes_required");
    }
    if (!options.targetCommandIds.length || options.targetCommandIds.some((command) => !command.trim())) {
      throw new Error("configured_planner_target_commands_required");
    }
    this.options = {
      repository: options.repository,
      writeScopes: [...options.writeScopes],
      targetCommandIds: [...options.targetCommandIds],
      denyScopes: [...(options.denyScopes ?? [".git", ".git/**", ".env", ".env*", "**/.env*"])],
      maxMinutes: options.maxMinutes ?? 15,
      maxAttempts: options.maxAttempts ?? 2,
      maxTokens: options.maxTokens ?? 120_000,
    };
  }

  propose(snapshot: WorkItemSnapshot): PlannerProposal {
    const evidence = snapshot.facts.length ? snapshot.facts : [snapshot.goal ?? "confirmed work item goal"];
    const goal = snapshot.goal ?? "Complete the confirmed work item";
    const budget = {
      maxMinutes: this.options.maxMinutes,
      maxAttempts: this.options.maxAttempts,
      maxTokens: this.options.maxTokens,
    };
    const common = {
      agentId: AGENT_ID,
      inputEvidence: evidence,
      readScope: ["**/*"],
      denyScope: [...this.options.denyScopes],
      risk: "low" as const,
      budget,
    };
    return {
      version: 1,
      summary: goal,
      nodes: [
        {
          ...common,
          id: "analyze",
          type: "analyze",
          dependsOn: [],
          objective: `Analyze: ${goal}`,
          instructions: "Read the approved worktree and identify the smallest change. Do not write during analysis.",
          writeScope: [],
          commands: [],
          expectedArtifacts: ["bounded implementation plan"],
          completionDefinition: "The change and its verification boundary are explicit.",
        },
        {
          ...common,
          id: "modify",
          type: "modify",
          dependsOn: ["analyze"],
          objective: goal,
          instructions: "Produce complete contents only for files inside the approved write scopes. Do not commit or push.",
          writeScope: [...this.options.writeScopes],
          commands: [],
          expectedArtifacts: [...this.options.writeScopes],
          completionDefinition: snapshot.acceptanceConditions.map((item) => item.description).join("; ") || goal,
        },
        {
          ...common,
          id: "validate",
          type: "validate",
          dependsOn: ["modify"],
          objective: "Run the trusted target verification commands.",
          instructions: "Validation commands are selected only from the configured command registry.",
          writeScope: [],
          commands: [...this.options.targetCommandIds],
          expectedArtifacts: ["target test evidence"],
          completionDefinition: snapshot.acceptanceConditions.map((item) => item.observation).join("; ") || "All target commands pass.",
        },
        {
          ...common,
          id: "report",
          type: "report",
          dependsOn: ["validate"],
          objective: "Report the candidate SHA, changed paths, and target-test evidence.",
          instructions: "Report only evidence already captured by the controlled executor.",
          writeScope: [],
          commands: [],
          expectedArtifacts: ["candidate status report"],
          completionDefinition: "The sole Owner can evaluate the exact candidate and evidence.",
        },
      ],
    };
  }
}

export function configuredPlanningPolicy(options: ConfiguredPlannerOptions): PlanningPolicy {
  const supportedAgents = {
    analyze: [AGENT_ID],
    modify: [AGENT_ID],
    validate: [AGENT_ID],
    report: [AGENT_ID],
  };
  return {
    allowedRepositories: [options.repository],
    supportedAgents,
    allowedCommands: [...options.targetCommandIds],
    requiredDenyScopes: [...(options.denyScopes ?? [".git", ".git/**", ".env", ".env*", "**/.env*"])],
    limits: {
      maxCommandsPerPlan: Math.max(4, options.targetCommandIds.length),
      maxMinutesPerNode: options.maxMinutes ?? 15,
      maxAttemptsPerNode: options.maxAttempts ?? 2,
      maxTokensPerNode: options.maxTokens ?? 120_000,
      maxTokensPerPlan: (options.maxTokens ?? 120_000) * 4,
    },
  };
}
