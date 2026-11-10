import type { WorkflowToolDescriptor } from "./planning.ts";

export function workflowToolCatalog(frame: unknown, permitted: (name: string) => boolean, allowEmpty = false): WorkflowToolDescriptor[] {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("Connected tools are unavailable");
  const result = (frame as { result?: unknown }).result;
  if (!result || typeof result !== "object" || !Array.isArray((result as { tools?: unknown }).tools)) throw new Error("Connected tools are unavailable");
  const tools = (result as { tools: unknown[] }).tools;
  const catalog: WorkflowToolDescriptor[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    const { name, description, inputSchema, outputSchema } = tool as Record<string, unknown>;
    if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || name.startsWith("COMPOSIO_") || seen.has(name) || !permitted(name)) continue;
    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) continue;
    seen.add(name);
    catalog.push({ name, ...(typeof description === "string" ? { description: description.slice(0, 2000) } : {}), inputSchema, ...(outputSchema && typeof outputSchema === "object" && !Array.isArray(outputSchema) ? { outputSchema } : {}) });
    if (catalog.length > 100 || JSON.stringify(catalog).length > 200_000) throw new Error("Too many connected tool schemas to prepare a workflow safely");
  }
  if (!catalog.length && !allowEmpty) throw new Error("No granted connected tools with schemas are available");
  return catalog;
}

export function workflowSearchCatalog(data: unknown, permitted: (name: string) => boolean, allowEmpty = false): WorkflowToolDescriptor[] {
  if (data && typeof data === "object" && "successful" in data && (data as { successful: unknown }).successful !== true) throw new Error("Connected tool search failed");
  const found: unknown[] = [];
  let visited = 0;
  function visit(value: unknown, depth: number) {
    if (++visited > 10_000 || depth > 20) throw new Error("Connected tool search response is too complex");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    const record = value as Record<string, unknown>;
    const name = record.tool_slug ?? record.slug ?? record.name;
    const inputSchema = record.input_schema ?? record.inputSchema ?? record.input_parameters;
    if (name && inputSchema && (record.hasFullSchema === true || (record.hasFullSchema !== false && !record.schemaRef))) found.push({ name, inputSchema, outputSchema: record.output_schema ?? record.outputSchema ?? record.output_parameters, description: record.description });
    for (const child of Object.values(record)) visit(child, depth + 1);
  }
  visit(data, 0);
  return workflowToolCatalog({ result: { tools: found } }, permitted, allowEmpty);
}

export function workflowSchemaReferences(data: unknown, permitted: (name: string) => boolean): string[] {
  const names = new Set<string>();
  let visited = 0;
  function visit(value: unknown, depth: number) {
    if (++visited > 10_000 || depth > 20) throw new Error("Connected tool search response is too complex");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
    const record = value as Record<string, unknown>;
    const name = record.tool_slug ?? record.slug;
    if (typeof name === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(name) && !name.startsWith("COMPOSIO_") && permitted(name) && (record.hasFullSchema === false || (record.schemaRef && record.hasFullSchema !== true))) names.add(name);
    for (const child of Object.values(record)) visit(child, depth + 1);
  }
  visit(data, 0);
  if (names.size > 100) throw new Error("Too many connected tool schemas to prepare a workflow safely");
  return [...names];
}
