import { proposeWorkflow } from "./approval.ts";
import { browserWorkflowCatalog, browserWorkflowInvoker } from "./browser-workflow.ts";
import type { RecordedBrowserStep } from "./browser-replay.ts";
import { schemaCheckedInvoker } from "./schema-check.ts";
import { executeWorkflow, type Workflow } from "./workflow.ts";

/** Accept a proposed pattern only if its simulated actions exactly reproduce the observed first run. */
export async function validateLearnedBrowserWorkflow(input: unknown, trace: readonly RecordedBrowserStep[]): Promise<Workflow> {
  const catalog = browserWorkflowCatalog, allowed = new Set(catalog.map((tool) => tool.name));
  const plan = proposeWorkflow(input, allowed).plan;
  const lists = new Set(plan.steps.filter((step) => step.kind === "call" && step.tool === "MINAI_BROWSER_LIST").map((step) => step.id));
  const dynamic = plan.steps.some((step) => step.kind === "each" && step.from.endsWith(".items") && lists.has(step.from.slice(0, -6)) && step.steps.some((call) => call.tool === "MINAI_BROWSER_CLICK" && JSON.stringify(call.input.name) === JSON.stringify({ $ref: "item.name" })));
  if (!dynamic) throw new Error("The proposed pattern does not use current browser targets");
  let index = 0;
  const invoke = schemaCheckedInvoker(catalog, browserWorkflowInvoker(async (step) => {
    const expected = trace[index];
    if ("kind" in step && step.kind === "list") {
      if (!expected || "kind" in expected || !expected.observedNames || expected.origin !== step.origin || expected.url !== step.url || expected.role !== step.role || step.prefix.length < 3 || step.prefix === expected.name) throw new Error("The proposed lookup does not match the first run");
      const names = expected.observedNames.filter((name) => name.startsWith(step.prefix));
      if (!names.length || new Set(names).size !== names.length) throw new Error("The proposed lookup is ambiguous or incomplete");
      return names.map((name) => ({ origin: step.origin, url: step.url, role: step.role, name }));
    }
    if (!expected) throw new Error("The proposed pattern adds an action to the first run");
    if ("kind" in step) {
      if (!("kind" in expected) || step.kind !== expected.kind || step.url !== expected.url) throw new Error("The proposed action does not match the first run");
      if (step.kind === "fill" && (expected.kind !== "fill" || step.origin !== expected.origin || step.role !== expected.role || step.name !== expected.name || step.value !== expected.value)) throw new Error("The proposed form action does not match the first run");
    } else if ("kind" in expected || step.origin !== expected.origin || step.url !== expected.url || step.role !== expected.role || step.name !== expected.name) throw new Error("The proposed action does not match the first run");
    index++;
    return undefined;
  }));
  const result = await executeWorkflow(plan, invoke);
  if (result.status !== "completed" || result.unexercised?.length || index !== trace.length) throw new Error("The proposed pattern did not reproduce the complete first run");
  return plan;
}
