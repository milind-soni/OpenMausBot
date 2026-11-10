import { PASS, type RouteHandler } from "../routes/table.ts";
import type { RequestAuth } from "../request-auth.ts";
import { bindWorkflow, workflowSchemaDigest, type WorkflowBindingInput } from "./binding.ts";
import { redactSecretsInText } from "../redact.ts";
import { prepareWorkflow, type WorkflowPlanner, type WorkflowToolDescriptor } from "./planning.ts";
import type { createWorkflowStore } from "./store.ts";
import { workflowToolNames, type ToolInvoker } from "./workflow.ts";
import { schemaCheckedInvoker } from "./schema-check.ts";

export interface SetupContext {
  binding: WorkflowBindingInput;
  catalog: readonly WorkflowToolDescriptor[];
  planner: WorkflowPlanner;
  invoke: ToolInvoker;
  accounts?: Array<{ service: string; name: string }>;
  paginatedTools?: ReadonlySet<string>;
  select?: (names: readonly string[]) => SetupContext;
}

export function createMinimumAiRoutes(deps: {
  store: ReturnType<typeof createWorkflowStore>;
  context: (auth: RequestAuth, routineId: string, stage: "prepare" | "existing") => Promise<SetupContext | null>;
  interrupted?: (routineId: string) => boolean;
  acknowledge?: (routineId: string) => void;
  hold?: (routineId: string) => void;
  testTimeoutMs?: number;
  authorizeRecovery?: (auth: RequestAuth, routineId: string) => boolean;
  record?: (auth: RequestAuth, routineId: string, signal: AbortSignal) => Promise<{ workflow: ReturnType<ReturnType<typeof createWorkflowStore>["saveDraft"]> }>;
}): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const match = path.match(/^\/api\/routines\/([\w-]+)\/minimum-ai(?:\/(prepare|record|test|approve|acknowledge|recovery))?$/);
    if (!match) return PASS;
    const [, id, action] = match;
    if (((!action || action === "recovery") && method !== "GET") || (action && action !== "recovery" && method !== "POST")) return json(res, 405, { error: "Method not allowed" });
    res.setHeader("cache-control", "no-store");
    try {
      if (action === "record") {
        if (!deps.record || !deps.authorizeRecovery?.(auth, id!)) return json(res, 404, { error: "Automation not found or unavailable" });
        const body = await readBody(req, 8192);
        if (body?.confirm !== true) return json(res, 400, { error: "Confirm that the first run will perform the task" });
        const controller = new AbortController();
        res.once("close", () => { if (!res.writableEnded) controller.abort(); });
        const timer = setTimeout(() => controller.abort(), deps.testTimeoutMs ?? 120_000);
        timer.unref?.();
        try { return json(res, 200, { ...await deps.record(auth, id!, controller.signal), accounts: [], interrupted: deps.interrupted?.(id!) ?? false }); }
        finally { clearTimeout(timer); }
      }
      if (action === "recovery" || (action === "acknowledge" && deps.authorizeRecovery)) {
        if (!deps.authorizeRecovery?.(auth, id!)) return json(res, 404, { error: "Automation not found or unavailable" });
        if (action === "recovery") return json(res, 200, { interrupted: deps.interrupted?.(id!) ?? false });
        const body = await readBody(req, 8192);
        if (body?.confirm !== true || !deps.acknowledge) return json(res, 400, { error: "Confirm that you reviewed the interrupted run" });
        deps.acknowledge(id!);
        try {
          const setup = await deps.context(auth, id!, "existing");
          if (setup) return json(res, 200, { workflow: deps.store.get(id!, setup.binding.owner, { ...setup.binding, schemaDigest: workflowSchemaDigest(setup.catalog) }), accounts: setup.accounts ?? [], interrupted: false });
        } catch { /* An unavailable account requires rebuilding after reconnection. */ }
        return json(res, 200, { workflow: null, accounts: [], interrupted: false });
      }
      const setup = await deps.context(auth, id!, action === "prepare" ? "prepare" : "existing");
      if (!setup) return json(res, 404, { error: "Automation not found or unavailable" });
      const { catalog, planner, invoke, accounts = [], paginatedTools = new Set() } = setup;
      const binding = { ...setup.binding, schemaDigest: workflowSchemaDigest(catalog) };
      const owner = binding.owner;
      const allowed = new Set(catalog.map((tool) => tool.name));
      if (!action) return json(res, 200, { workflow: deps.store.get(id!, owner, binding), accounts, interrupted: deps.interrupted?.(id!) ?? false });
      if (action === "prepare") {
        const draft = await prepareWorkflow(binding.prompt, allowed, planner, paginatedTools, catalog);
        const names = workflowToolNames(draft.plan);
        const selected = setup.select?.(names) ?? setup;
        const selectedBinding = { ...selected.binding, schemaDigest: workflowSchemaDigest(selected.catalog) };
        const fresh = await deps.context(auth, id!, "prepare");
        const freshSelected = fresh?.select?.(names) ?? fresh;
        if (!freshSelected || bindWorkflow({ ...freshSelected.binding, schemaDigest: workflowSchemaDigest(freshSelected.catalog) }) !== bindWorkflow(selectedBinding)) return json(res, 409, { error: "Automation or connections changed during setup" });
        return json(res, 200, { workflow: deps.store.saveDraft(id!, owner, selectedBinding, draft.plan, new Set(selected.catalog.map((tool) => tool.name)), selected.paginatedTools, selected.catalog), accounts: selected.accounts ?? [], interrupted: deps.interrupted?.(id!) ?? false });
      }
      const body = await readBody(req, 8192);
      if (action === "acknowledge") {
        if (body?.confirm !== true || !deps.acknowledge) return json(res, 400, { error: "Confirm that you reviewed the interrupted run" });
        deps.acknowledge(id!);
        return json(res, 200, { workflow: deps.store.get(id!, owner, binding), accounts, interrupted: false });
      }
      if (deps.interrupted?.(id!)) return json(res, 409, { error: "Review the interrupted run before continuing" });
      const fingerprint = body?.fingerprint;
      if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) return json(res, 400, { error: "Workflow revision required" });
      if (action === "test") {
        const controller = new AbortController();
        res.once("close", () => { if (!res.writableEnded) controller.abort(); });
        const timer = setTimeout(() => controller.abort(), deps.testTimeoutMs ?? 120_000);
        timer.unref?.();
        let attempted = false;
        const checked = schemaCheckedInvoker(catalog, (tool, input, signal) => { attempted = true; return invoke(tool, input, signal); });
        let result: Awaited<ReturnType<typeof deps.store.verify>>;
        try { result = await deps.store.verify(id!, owner, binding, fingerprint, allowed, checked, paginatedTools, controller.signal, {
          before: () => { if (deps.interrupted?.(id!)) throw new Error("Review the interrupted run before continuing"); },
          after: (outcome) => { if (outcome.status === "failed" && outcome.partial && attempted) deps.hold?.(id!); },
          error: () => { if (attempted) deps.hold?.(id!); },
        }); }
        finally { clearTimeout(timer); }
        return json(res, 200, { result, workflow: deps.store.get(id!, owner, binding), accounts, interrupted: deps.interrupted?.(id!) ?? false });
      }
      return json(res, 200, { workflow: deps.store.approve(id!, owner, binding, fingerprint), accounts, interrupted: false });
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? redactSecretsInText(error.message).slice(0, 500) : "Workflow setup failed" });
    }
  };
}
