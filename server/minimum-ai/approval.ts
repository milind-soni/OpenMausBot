import { createHash } from "node:crypto";
import { executeWorkflow, parseWorkflow, type ToolInvoker, type Workflow, type WorkflowResult } from "./workflow.ts";
import { redactSecretsInText } from "../redact.ts";

export type WorkflowProposal = { plan: Workflow; fingerprint: string; verified: boolean; approved: boolean };
const SECRET_KEY = /^(?:access_?token|refresh_?token|token|api_?key|secret|password|authorization|credential)$/i;

function validate(plan: Workflow, allowed: ReadonlySet<string>, paginatedTools: ReadonlySet<string>) {
  const inspect = (value: unknown, depth = 0): void => {
    if (depth > 20) throw new Error("Workflow input is too deeply nested");
    if (typeof value === "string" && redactSecretsInText(value) !== value) throw new Error("Credentials cannot be stored in a workflow");
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) throw new Error("Credentials cannot be stored in a workflow");
      inspect(child, depth + 1);
    }
  };
  for (const step of plan.steps) {
    if (step.kind !== "call") inspect(step.where);
    for (const action of step.kind === "call" ? [step] : [...step.steps, ...(step.kind === "if" ? step.otherwise ?? [] : [])]) {
      if (!allowed.has(action.tool)) throw new Error(`Tool ${action.tool} is not granted`);
      if (action.pagination && !paginatedTools.has(action.tool)) throw new Error("Pagination requires an approved read-only tool");
      inspect(action.input);
    }
  }
  inspect(plan.output);
}
const fingerprint = (plan: Workflow) => createHash("sha256").update(JSON.stringify(plan)).digest("hex");

export function proposeWorkflow(input: unknown, allowed: ReadonlySet<string>, paginatedTools: ReadonlySet<string> = new Set()): WorkflowProposal {
  const plan = parseWorkflow(input);
  validate(plan, allowed, paginatedTools);
  return { plan, fingerprint: fingerprint(plan), verified: false, approved: false };
}

export async function verifyWorkflow(proposal: WorkflowProposal, allowed: ReadonlySet<string>, invoke: ToolInvoker, paginatedTools: ReadonlySet<string> = new Set(), signal?: AbortSignal): Promise<{ proposal: WorkflowProposal; result: WorkflowResult }> {
  const plan = parseWorkflow(proposal.plan);
  if (fingerprint(plan) !== proposal.fingerprint) throw new Error("Workflow changed before testing");
  validate(plan, allowed, paginatedTools);
  const result = await executeWorkflow(plan, invoke, signal);
  return { proposal: { plan, fingerprint: proposal.fingerprint, verified: result.status === "completed", approved: false }, result };
}

export function approveWorkflow(proposal: WorkflowProposal): WorkflowProposal {
  const plan = parseWorkflow(proposal.plan);
  if (!proposal.verified) throw new Error("Workflow needs a successful test before approval");
  if (fingerprint(plan) !== proposal.fingerprint) throw new Error("Workflow changed before approval");
  return { plan, fingerprint: proposal.fingerprint, verified: true, approved: true };
}

export async function executeApprovedWorkflow(proposal: WorkflowProposal, allowed: ReadonlySet<string>, invoke: ToolInvoker, signal?: AbortSignal, paginatedTools: ReadonlySet<string> = new Set()): Promise<WorkflowResult> {
  if (!proposal.approved) throw new Error("Workflow approval is required");
  const plan = parseWorkflow(proposal.plan);
  if (fingerprint(plan) !== proposal.fingerprint) throw new Error("Workflow changed after approval");
  validate(plan, allowed, paginatedTools);
  return executeWorkflow(plan, invoke, signal);
}
