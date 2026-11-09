import type { RequestAuth } from "../request-auth.ts";
import type { ConnectorServiceState } from "../composio.ts";
import { isReadOnlyAction } from "../../shared/connector-scopes.ts";
import { workflowAccountIds } from "./binding.ts";
import { createWorkflowConnector, type WorkflowConnectorDeps } from "./connector.ts";
import { discoverWorkflowTools, refreshWorkflowSchemas } from "./discovery.ts";
import type { WorkflowPlanner } from "./planning.ts";
import type { SetupContext } from "./routes.ts";
import type { createWorkflowStore } from "./store.ts";

type RoutineForSetup = { botId: string; prompt: string; target: string; runOn: string; executionMode?: string };
type Relay = WorkflowConnectorDeps["relay"];

export function createSetupContext(deps: {
  owner: (auth: RequestAuth) => string | null;
  routine: (id: string) => RoutineForSetup | undefined;
  services: () => Promise<Record<string, ConnectorServiceState>>;
  permitted: (botId: string, tool: string, slugs: readonly string[]) => boolean;
  serviceFor: (tool: string, slugs: readonly string[]) => string | null;
  withRelay: <T>(botId: string, routineId: string, threadId: string | undefined, run: (relay: Relay) => Promise<T>) => Promise<T>;
  planner: (botId: string) => WorkflowPlanner;
  store: ReturnType<typeof createWorkflowStore>;
}) {
  const forOwner = async (owner: string | null, id: string, stage: "prepare" | "existing", threadId?: string, signal: AbortSignal = new AbortController().signal, sharedRelay?: Relay): Promise<SetupContext | null> => {
    const routine = deps.routine(id);
    if (!owner || !routine || routine.executionMode !== "minimum-ai" || routine.target !== "bot" || routine.runOn !== "maus") return null;
    const services = await deps.services();
    const slugs = Object.keys(services);
    const permitted = (tool: string) => deps.permitted(routine.botId, tool, slugs);
    signal.throwIfAborted();
    const useRelay = <T>(work: (relay: Relay) => Promise<T>) => sharedRelay ? work(sharedRelay) : deps.withRelay(routine.botId, id, threadId, work);
    const catalog = await useRelay((relay) => stage === "prepare"
      ? discoverWorkflowTools(routine.prompt, relay, permitted, signal)
      : refreshWorkflowSchemas(deps.store.catalog(id, owner), relay, signal));
    if (catalog.some((tool) => !permitted(tool.name))) throw new Error("A workflow tool is no longer granted");
    const accountFor = (tool: string) => {
      const service = deps.serviceFor(tool, slugs);
      if (!service) throw new Error("A workflow tool has no connected service");
      workflowAccountIds(services, [service]);
      return services[service]!.accounts.find((account) => account.status.toUpperCase() === "ACTIVE" && account.id.trim())!.id;
    };
    const sharedInvoke = sharedRelay ? createWorkflowConnector({ relay: sharedRelay, authorize: async (name) => permitted(name), accountFor }) : null;
    const invoke: SetupContext["invoke"] = (tool, input, callSignal) => sharedInvoke ? sharedInvoke(tool, input, callSignal) : useRelay((relay) => createWorkflowConnector({ relay, authorize: async (name) => permitted(name), accountFor })(tool, input, callSignal));
    const paginated = (tools: typeof catalog) => new Set(tools.filter((tool) => isReadOnlyAction(tool.name, deps.serviceFor(tool.name, slugs) ?? undefined) || ["NOTION_QUERY_DATABASE", "NOTION_QUERY_DATABASE_WITH_FILTER", "NOTION_QUERY_DATA_SOURCE"].includes(tool.name)).map((tool) => tool.name));
    const select = (names: readonly string[]): SetupContext => {
      const wanted = new Set(names), selected = catalog.filter((tool) => wanted.has(tool.name));
      if (selected.length !== wanted.size) throw new Error("A workflow tool is no longer available");
      const required = selected.map((tool) => deps.serviceFor(tool.name, slugs));
      if (required.some((slug) => !slug)) throw new Error("A workflow tool has no connected service");
      const binding = { owner, botId: routine.botId, prompt: routine.prompt, connectionIds: workflowAccountIds(services, required as string[]) };
      const accounts = [...new Set(required as string[])].map((service) => { const account = services[service]!.accounts.find((item) => item.status.toUpperCase() === "ACTIVE")!; return { service, name: account.alias || account.id }; });
      return { binding, catalog: selected, planner: deps.planner(routine.botId), invoke, paginatedTools: paginated(selected), accounts };
    };
    return stage === "prepare" ? { binding: { owner, botId: routine.botId, prompt: routine.prompt, connectionIds: [] }, catalog, planner: deps.planner(routine.botId), invoke, paginatedTools: paginated(catalog), select } : select(catalog.map((tool) => tool.name));
  };
  const forAuth = (auth: RequestAuth, id: string, stage: "prepare" | "existing") => forOwner(deps.owner(auth), id, stage);
  return Object.assign(forAuth, { forOwner });
}
