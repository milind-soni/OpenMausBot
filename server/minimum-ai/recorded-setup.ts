import { randomUUID } from "node:crypto";
import { bindWorkflow, type WorkflowBindingInput } from "./binding.ts";
import type { RecordedBrowserStep } from "./browser-replay.ts";
import type { createRunLedger } from "./ledger.ts";
import type { createWorkflowStore } from "./store.ts";
import { browserWorkflowFromRecording } from "./browser-workflow.ts";
import { validateLearnedBrowserWorkflow } from "./browser-learning.ts";

/** Holds the routine while its real first run executes and preserves an interruption for owner review. */
export async function recordBrowserWorkflow(options: {
  routineId: string;
  owner: string;
  store: ReturnType<typeof createWorkflowStore>;
  ledger: ReturnType<typeof createRunLedger>;
  context: () => Promise<WorkflowBindingInput>;
  firstRun: (signal: AbortSignal) => Promise<RecordedBrowserStep[]>;
  learn?: (steps: readonly RecordedBrowserStep[]) => Promise<unknown>;
  signal: AbortSignal;
}) {
  const initial = await options.context();
  if (initial.owner !== options.owner) throw new Error("Workflow owner changed");
  options.signal.throwIfAborted();
  const lease = options.store.acquireRecording(options.routineId, options.owner);
  const runId = `setup-${randomUUID()}`;
  let started = false;
  try {
    if (!options.ledger.begin(runId, options.routineId)) throw new Error("Review the interrupted or active run before recording");
    started = true;
    const steps = await options.firstRun(options.signal);
    options.signal.throwIfAborted();
    browserWorkflowFromRecording(steps); // Validate recorded pages and secrets before sharing observations with a model.
    let learned;
    if (options.learn) {
      try { learned = await validateLearnedBrowserWorkflow(await options.learn(steps), steps); }
      catch { /* A fixed trace remains reviewable when no safe pattern can be proved. */ }
    }
    options.signal.throwIfAborted();
    const latest = await options.context();
    if (bindWorkflow(initial) !== bindWorkflow(latest)) throw new Error("The automation or browser changed during recording");
    const proposal = options.store.saveRecordedBrowserDraft(options.routineId, options.owner, latest, steps, lease.token, learned);
    options.ledger.finish(runId, "completed");
    started = false;
    return proposal;
  } catch (error) {
    if (started) options.ledger.finish(runId, "failed", options.routineId);
    throw error;
  } finally { lease.release(); }
}
