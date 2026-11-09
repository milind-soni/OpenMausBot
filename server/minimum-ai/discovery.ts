import { parseMcpResponse } from "../connector-tools-list.ts";
import { workflowSchemaReferences, workflowSearchCatalog } from "./catalog.ts";
import type { WorkflowConnectorDeps } from "./connector.ts";
import type { WorkflowToolDescriptor } from "./planning.ts";

export async function refreshWorkflowSchemas(catalog: readonly WorkflowToolDescriptor[], relay: WorkflowConnectorDeps["relay"], signal: AbortSignal): Promise<WorkflowToolDescriptor[]> {
  const names = new Set(catalog.map((tool) => tool.name));
  if (!names.size || names.size > 100 || [...names].some((name) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || name.startsWith("COMPOSIO_"))) throw new Error("Saved workflow tool names are invalid");
  const initial = await relay({ jsonrpc: "2.0", id: "minimum-ai-refresh-init", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "openmausbot-minimum-ai", version: "1" } } }, undefined, signal);
  if (initial.status !== 200) throw new Error("Connected apps initialization failed");
  const session = initial.transportSessionId;
  const ready = await relay({ jsonrpc: "2.0", method: "notifications/initialized" }, session, signal);
  if (ready.status < 200 || ready.status >= 300) throw new Error("Connected apps setup failed");
  const answer = await relay({ jsonrpc: "2.0", id: "minimum-ai-refresh", method: "tools/call", params: { name: "COMPOSIO_GET_TOOL_SCHEMAS", arguments: { tool_slugs: [...names], include: ["input_schema", "output_schema"] } } }, session, signal);
  if (answer.status !== 200) throw new Error("Connected tool schemas are unavailable");
  const refreshed = workflowSearchCatalog(discoveryData(answer.bytes, "minimum-ai-refresh"), (name) => names.has(name));
  if (refreshed.length !== names.size) throw new Error("Some workflow tool schemas are unavailable");
  return refreshed;
}

export async function discoverWorkflowTools(goal: string, relay: WorkflowConnectorDeps["relay"], permitted: (name: string) => boolean, signal: AbortSignal) {
  if (!goal.trim() || goal.length > 10_000) throw new Error("A valid automation description is required");
  const initial = await relay({ jsonrpc: "2.0", id: "minimum-ai-discovery-init", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "openmausbot-minimum-ai", version: "1" } } }, undefined, signal);
  if (initial.status !== 200) throw new Error("Connected apps initialization failed");
  const session = initial.transportSessionId;
  const ready = await relay({ jsonrpc: "2.0", method: "notifications/initialized" }, session, signal);
  if (ready.status < 200 || ready.status >= 300) throw new Error("Connected apps setup failed");
  const response = await relay({ jsonrpc: "2.0", id: "minimum-ai-search", method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: { queries: [{ use_case: goal }], session: { generate_id: true } } } }, session, signal);
  if (response.status !== 200) throw new Error("Connected tool search failed");
  const data = discoveryData(response.bytes, "minimum-ai-search");
  const references = workflowSchemaReferences(data, permitted);
  const inline = workflowSearchCatalog(data, permitted, true);
  const names = [...new Set([...references, ...inline.map((tool) => tool.name)])];
  if (!names.length || names.length > 100) throw new Error("No granted connected tools with schemas are available");
  const nested = (data as { data?: { session?: { id?: unknown }; session_id?: unknown } })?.data;
  const sessionId = nested?.session?.id ?? nested?.session_id;
  const schemas = await relay({ jsonrpc: "2.0", id: "minimum-ai-schemas", method: "tools/call", params: { name: "COMPOSIO_GET_TOOL_SCHEMAS", arguments: { tool_slugs: names, include: ["input_schema", "output_schema"], ...(typeof sessionId === "string" && sessionId.length <= 200 ? { session_id: sessionId } : {}) } } }, session, signal);
  if (schemas.status !== 200) throw new Error("Connected tool schemas are unavailable");
  const selected = new Set(names);
  const resolved = workflowSearchCatalog(discoveryData(schemas.bytes, "minimum-ai-schemas"), (name) => selected.has(name) && permitted(name));
  if (resolved.length !== names.length) throw new Error("Some connected tool schemas are unavailable");
  return resolved;
}

function discoveryData(bytes: Uint8Array, id: string): unknown {
  const frame = parseMcpResponse(new TextDecoder().decode(bytes), id);
  const result = frame?.result as { isError?: unknown; content?: unknown } | undefined;
  if (frame?.error || result?.isError || !Array.isArray(result?.content)) throw new Error("Connected tool discovery failed");
  for (const part of result.content) {
    if (!part || typeof part !== "object" || typeof (part as { text?: unknown }).text !== "string") continue;
    try {
      const data: unknown = JSON.parse((part as { text: string }).text);
      if (data && typeof data === "object" && "successful" in data && (data as { successful: unknown }).successful !== true) throw new Error("Connected tool discovery failed");
      return data;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  throw new Error("Connected tool discovery returned an unsupported response");
}
