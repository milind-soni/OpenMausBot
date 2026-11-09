import { z } from "zod";
import { proposeWorkflow } from "./approval.ts";
import { safeBrowserFill, type BrowserListQuery, type BrowserStep, type RecordedBrowserStep } from "./browser-replay.ts";
import type { WorkflowToolDescriptor } from "./planning.ts";
import type { ToolInvoker, Workflow } from "./workflow.ts";

const address = z.string().max(4096).superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.href !== value || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { ctx.addIssue({ code: "custom", message: "Browser page address is invalid or contains private parameters" }); }
});
const open = z.object({ url: address }).strict();
const click = z.object({ origin: z.string().max(4096), url: address, role: z.string().min(1).max(100), name: z.string().min(1).max(512) }).strict().superRefine((value, ctx) => {
  try { if (new URL(value.url).origin !== value.origin) throw new Error(); }
  catch { ctx.addIssue({ code: "custom", message: "Browser page and origin differ" }); }
});
const list = z.object({ origin: z.string().max(4096), url: address, role: z.string().min(1).max(100), prefix: z.string().min(1).max(512) }).strict().superRefine((value, ctx) => {
  try { if (new URL(value.url).origin !== value.origin) throw new Error(); }
  catch { ctx.addIssue({ code: "custom", message: "Browser page and origin differ" }); }
});
const fill = z.object({ origin: z.string().max(4096), url: address, role: z.string().min(1).max(100), name: z.string().min(1).max(512), value: z.string().max(4096) }).strict().superRefine((value, ctx) => {
  try { if (new URL(value.url).origin !== value.origin || !safeBrowserFill({ kind: "fill", ...value })) throw new Error(); }
  catch { ctx.addIssue({ code: "custom", message: "The form field is sensitive or unsupported" }); }
});
export type BrowserOperation = BrowserStep | ({ kind: "list" } & BrowserListQuery);
const input = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const text = { type: "string", minLength: 1, maxLength: 4096 };
export const browserWorkflowCatalog: readonly WorkflowToolDescriptor[] = [
  { name: "MINAI_BROWSER_OPEN", description: "Open the approved browser page", inputSchema: input({ url: text }, ["url"]) },
  { name: "MINAI_BROWSER_CLICK", description: "Click a uniquely named element on the approved page", inputSchema: input({ origin: text, url: text, role: { ...text, maxLength: 100 }, name: { ...text, maxLength: 512 } }, ["origin", "url", "role", "name"]) },
  { name: "MINAI_BROWSER_FILL", description: "Set a non-secret text field to an approved value", inputSchema: input({ origin: text, url: text, role: { ...text, maxLength: 100 }, name: { ...text, maxLength: 512 }, value: { type: "string", maxLength: 4096 } }, ["origin", "url", "role", "name", "value"]) },
  { name: "MINAI_BROWSER_LIST", description: "Find current uniquely named elements matching a literal prefix", inputSchema: input({ origin: text, url: text, role: { ...text, maxLength: 100 }, prefix: { ...text, maxLength: 512 } }, ["origin", "url", "role", "prefix"]), outputSchema: { type: "object", properties: { items: { type: "array", items: input({ origin: text, url: text, role: text, name: text }, ["origin", "url", "role", "name"]) } }, required: ["items"] } },
];
const allowed = new Set(browserWorkflowCatalog.map((tool) => tool.name));

/** A completed first-run trace can be shown and approved using the existing workflow representation. */
export function browserWorkflowFromRecording(steps: readonly RecordedBrowserStep[]): Workflow {
  if (!steps.length || steps.length > 50) throw new Error("The browser recording is incomplete or too long");
  const calls = steps.map((step, index) => {
    if ("kind" in step && step.kind === "open") return { kind: "call", id: `browser_${index + 1}`, tool: "MINAI_BROWSER_OPEN", input: open.parse({ url: step.url }) };
    if ("kind" in step && step.kind === "fill") return { kind: "call", id: `browser_${index + 1}`, tool: "MINAI_BROWSER_FILL", input: fill.parse({ origin: step.origin, url: step.url, role: step.role, name: step.name, value: step.value }) };
    return { kind: "call", id: `browser_${index + 1}`, tool: "MINAI_BROWSER_CLICK", input: click.parse({ origin: step.origin, url: step.url, role: step.role, name: step.name }) };
  });
  if (!steps.some((step) => !("kind" in step) || step.kind === "fill")) throw new Error("No browser click or fill was recorded; a reusable action cannot be confirmed");
  return proposeWorkflow({ version: 1, steps: calls }, allowed).plan;
}

/** The caller must apply the host's browser permission and turn-resource gates. */
export function browserWorkflowInvoker(perform: (step: BrowserOperation, signal: AbortSignal) => Promise<unknown>): ToolInvoker {
  return async (tool, inputValue, signal) => {
    const step = tool === "MINAI_BROWSER_OPEN" ? { kind: "open" as const, ...open.parse(inputValue) }
      : tool === "MINAI_BROWSER_CLICK" ? click.parse(inputValue)
      : tool === "MINAI_BROWSER_FILL" ? { kind: "fill" as const, ...fill.parse(inputValue) }
      : tool === "MINAI_BROWSER_LIST" ? { kind: "list" as const, ...list.parse(inputValue) } : null;
    if (!step) throw new Error("Unsupported browser workflow tool");
    signal.throwIfAborted();
    const result = await perform(step, signal);
    return "kind" in step && step.kind === "list" ? { items: result } : { ok: true };
  };
}
