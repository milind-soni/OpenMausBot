import { proposeWorkflow, type WorkflowProposal } from "./approval.ts";
import type { SideJobs } from "../side-jobs.ts";
import { redactSecretsInText } from "../redact.ts";
import { workflowToolNames } from "./workflow.ts";

export interface WorkflowToolDescriptor { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown }
export type WorkflowPlanner = (goal: string, tools: readonly WorkflowToolDescriptor[]) => Promise<unknown>;

/** The connector unwraps Composio's successful/data/error envelope before a workflow sees a result. */
function resultSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const root = schema as Record<string, unknown>;
  const props = root.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return schema;
  const { data, successful, error } = props as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data) || !successful || !error) return schema;
  return { ...(data as Record<string, unknown>), ...(root.$defs ? { $defs: root.$defs } : {}), ...(root.definitions ? { definitions: root.definitions } : {}), ...(root.$schema ? { $schema: root.$schema } : {}) };
}

export function botWorkflowPlanner(jobs: SideJobs, botId: string): WorkflowPlanner {
  return textWorkflowPlanner(async (prompt) => {
    const model = jobs.text("minimum-ai-plan", botId);
    if (!model) throw new Error("This bot has no text-only model available for workflow setup");
    return model.generateText(prompt, { timeoutMs: 120_000 });
  });
}

export function textWorkflowPlanner(generate: (prompt: string) => Promise<string>): WorkflowPlanner {
  return async (goal, tools) => {
    const prompt = `Convert the requested automation into a reusable JSON workflow. You cannot run tools. Return only JSON, with no markdown. If the task cannot be expressed safely using the listed tools and the format below, return {"unsupported":"reason"}.
Task: ${JSON.stringify(goal)}
Available tools and input schemas: ${JSON.stringify(tools)}
Format: {"version":1,"steps":[STEP,...],"output":OPTIONAL_VALUE}. A STEP is {"kind":"call","id":"unique_name","tool":"TOOL_NAME","input":{...}}, or {"kind":"each","id":"unique_name","from":"list_step.path_to_array","where":{"path":"item.field","equals":"value"},"steps":[CALL,...]}, or {"kind":"if","id":"unique_name","where":{"path":"step.field","equals":true},"steps":[CALL,...],"otherwise":[CALL,...]}. otherwise is optional on if, and where is optional on each. A condition may use {"path":"item.name","startsWith":"literal prefix"} instead of equals when a literal, case-sensitive prefix identifies the intended items. CALL is a call step. A read-only call can also include "pagination":{"cursorArg":"argument_name","nextPath":"next_cursor","itemsPath":"results","maxPages":20}; paths are relative to the tool response and must omit the prefix response. When the response has a boolean more-pages field, include "hasMorePath":"has_more" with its exact path; inconsistent pagination must stop. All pages are merged at itemsPath before later steps. To use a prior result or loop item in an input, use {"$ref":"step.field"} or {"$ref":"item.field"}. The optional output can use references to return the requested data, for example {"$ref":"inbox.messages"}. Paths access the tool response. Do not invent IDs, credentials, tool names, response fields, or fixed data that changes between runs. Use dynamic references for results. Never include secrets. Do not propose pagination unless you know the exact response paths and cursor argument. For tasks requiring all results, a bounded pagination step is safe: it stops with an error before later steps if more pages remain at the limit. Return unsupported only if complete pagination cannot be determined from the available schemas. The workflow will be reviewed and tested separately.`;
    const output = await generate(prompt);
    if (output.length > 200_000) throw new Error("Workflow proposal is too large");
    let parsed: unknown;
    const trimmed = output.trim();
    const json = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)?.[1] ?? trimmed;
    try { parsed = JSON.parse(json); } catch { throw new Error("The model did not return a valid workflow"); }
    if (parsed && typeof parsed === "object" && "unsupported" in parsed) {
      const reason = typeof parsed.unsupported === "string" ? redactSecretsInText(parsed.unsupported.replace(/\s+/g, " ").trim()).slice(0, 300) : "";
      throw new Error(`This task cannot be converted to a supported workflow${reason ? `: ${reason}` : ""}`);
    }
    return parsed;
  };
}

export async function prepareWorkflow(goal: string, allowed: ReadonlySet<string>, planner: WorkflowPlanner, paginatedTools: ReadonlySet<string> = new Set(), catalog?: readonly WorkflowToolDescriptor[]): Promise<WorkflowProposal> {
  const description = goal.trim();
  if (!description || description.length > 10_000) throw new Error("A valid automation description is required");
  if (redactSecretsInText(description) !== description) throw new Error("Remove credentials from the automation description before preparing a workflow");
  if (allowed.size === 0) throw new Error("No connected tools are available");
  const tools: readonly WorkflowToolDescriptor[] = catalog ? catalog.filter((tool) => allowed.has(tool.name)) : [...allowed].map((name) => ({ name }));
  if (!tools.length) throw new Error("No granted tool schemas are available");
  const proposal = await planner(description, tools.map((tool) => ({ ...tool, ...(tool.outputSchema ? { outputSchema: resultSchema(tool.outputSchema) } : {}) })));
  const workflow = proposeWorkflow(proposal, new Set(tools.map((tool) => tool.name)), paginatedTools);
  if (/\bpermanent(?:ly)?\b/i.test(description) && /\bdelet(?:e|ion|ing)\b/i.test(description) && workflowToolNames(workflow.plan).some((name) => name === "NOTION_DELETE_BLOCK" || name === "NOTION_ARCHIVE_NOTION_PAGE")) {
    throw new Error("These Notion tools move pages to trash; they cannot permanently delete them. Change the task or use a tool that supports permanent deletion.");
  }
  return workflow;
}
