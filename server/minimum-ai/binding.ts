import { createHash, timingSafeEqual } from "node:crypto";
import type { ConnectorServiceState } from "../composio.ts";
import type { WorkflowToolDescriptor } from "./planning.ts";

export interface WorkflowBindingInput { owner: string; botId: string; prompt: string; connectionIds: readonly string[]; schemaDigest?: string }

export function bindWorkflow(input: WorkflowBindingInput): string {
  if (!input.owner || !input.botId || !input.prompt.trim() || input.connectionIds.some((id) => !id)) throw new Error("A workflow must name its owner, bot and task");
  return createHash("sha256").update(JSON.stringify({ version: 1, owner: input.owner, botId: input.botId, prompt: input.prompt, connectionIds: [...new Set(input.connectionIds)].sort(), schemaDigest: input.schemaDigest ?? "" })).digest("hex");
}

export function workflowSchemaDigest(catalog: readonly WorkflowToolDescriptor[]): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
  const schemas = catalog.map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema: canonical(inputSchema), outputSchema: canonical(outputSchema) })).sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(schemas)).digest("hex");
}

export function assertWorkflowBinding(binding: string, input: WorkflowBindingInput): void {
  const expected = bindWorkflow(input);
  if (!/^[a-f0-9]{64}$/.test(binding) || !timingSafeEqual(Buffer.from(binding, "hex"), Buffer.from(expected, "hex"))) throw new Error("The automation or connected accounts changed; review the workflow again");
}

export function workflowAccountIds(services: Record<string, ConnectorServiceState>, required: readonly string[]): string[] {
  return [...new Set(required)].sort().map((slug) => {
    const service = services[slug];
    const active = service?.accounts.filter((account) => account.status.toUpperCase() === "ACTIVE" && account.id.trim()) ?? [];
    if (!service?.connected || active.length !== 1) throw new Error(`Connect exactly one identifiable account for ${slug} before using this workflow`);
    return `${slug}:${active[0]!.id}`;
  });
}
