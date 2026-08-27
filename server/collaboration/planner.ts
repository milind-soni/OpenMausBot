import { z } from "zod";

import type { WorkItemSnapshot } from "./snapshot.ts";

export const WORK_NODE_TYPES = ["analyze", "modify", "validate", "report"] as const;
export type WorkNodeType = (typeof WORK_NODE_TYPES)[number];

const budgetSchema = z
  .object({
    maxMinutes: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
  })
  .strict();

const nodeSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u),
    type: z.enum(WORK_NODE_TYPES),
    agentId: z.string().min(1).max(128),
    dependsOn: z.array(z.string().min(1).max(64)).max(4),
    objective: z.string().min(1).max(2_000),
    inputEvidence: z.array(z.string().min(1).max(500)).min(1).max(50),
    instructions: z.string().min(1).max(8_000),
    readScope: z.array(z.string().min(1).max(500)).max(100),
    writeScope: z.array(z.string().min(1).max(500)).max(100),
    denyScope: z.array(z.string().min(1).max(500)).min(1).max(100),
    commands: z.array(z.string().min(1).max(500)).max(4),
    expectedArtifacts: z.array(z.string().min(1).max(500)).min(1).max(20),
    completionDefinition: z.string().min(1).max(2_000),
    risk: z.enum(["low", "medium", "high"]),
    budget: budgetSchema,
  })
  .strict();

const proposalSchema = z
  .object({
    version: z.literal(1),
    summary: z.string().min(1).max(2_000),
    nodes: z.array(nodeSchema).length(4),
  })
  .strict();

export type PlannerProposal = z.infer<typeof proposalSchema>;

export interface PlannerPort {
  /** Model/provider output is deliberately unknown until strict parsing. */
  propose(snapshot: WorkItemSnapshot): unknown;
}

export class PlanValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid planner proposal: ${issues.join("; ")}`);
    this.issues = issues;
    this.name = "PlanValidationError";
  }
}

export function parsePlannerProposal(value: unknown): PlannerProposal {
  const result = proposalSchema.safeParse(value);
  if (!result.success) {
    throw new PlanValidationError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "proposal"}: ${issue.message}`),
    );
  }
  return result.data;
}
