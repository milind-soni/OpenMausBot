import { executeApprovedWorkflow } from "./approval.ts";
import type { createRunLedger } from "./ledger.ts";
import type { createWorkflowStore } from "./store.ts";
import type { ToolInvoker, WorkflowResult } from "./workflow.ts";
import { workflowSchemaDigest, type WorkflowBindingInput } from "./binding.ts";
import type { WorkflowToolDescriptor } from "./planning.ts";
import { schemaCheckedInvoker } from "./schema-check.ts";

export async function runApprovedWorkflow(options: {
  routineId: string;
  runId: string;
  owner: string;
  context: WorkflowBindingInput;
  store: ReturnType<typeof createWorkflowStore>;
  ledger: ReturnType<typeof createRunLedger>;
  allowed: ReadonlySet<string>;
  catalog: readonly WorkflowToolDescriptor[];
  paginatedTools?: ReadonlySet<string>;
  invoke: ToolInvoker;
  signal?: AbortSignal;
}): Promise<WorkflowResult> {
  const lease = options.store.acquireRun(options.routineId, options.owner, { ...options.context, schemaDigest: workflowSchemaDigest(options.catalog) });
  let started = false;
  let attempted = false;
  try {
    if (!options.ledger.begin(options.runId, options.routineId)) throw new Error(options.ledger.held(options.routineId) ? "A previous run was interrupted; review its effects before allowing another run" : "This run or another run of this workflow has already started");
    started = true;
    const invoke = schemaCheckedInvoker(options.catalog, (tool, input, signal) => { attempted = true; return options.invoke(tool, input, signal); });
    const result = await executeApprovedWorkflow(lease.proposal, options.allowed, invoke, options.signal, options.paginatedTools);
    options.ledger.finish(options.runId, result.status, result.status === "failed" && result.partial && attempted ? options.routineId : undefined);
    started = false;
    return result;
  } catch (error) {
    if (started) options.ledger.finish(options.runId, "failed", attempted ? options.routineId : undefined);
    throw error;
  } finally {
    lease.release();
  }
}
