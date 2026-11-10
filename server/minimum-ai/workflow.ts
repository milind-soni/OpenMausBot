import { z } from "zod";

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const path = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/).max(256);
const ref = z.object({ $ref: path }).strict();
type Value = string | number | boolean | null | { $ref: string } | Value[] | { [key: string]: Value };
const value: z.ZodType<Value> = z.lazy(() => z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null(), ref, z.array(value).max(100), z.record(z.string().max(100), value)]));
const pagination = z.object({ cursorArg: id, nextPath: path, itemsPath: path, hasMorePath: path.optional(), maxPages: z.number().int().min(1).max(20) }).strict();
const call = z.object({ kind: z.literal("call"), id, tool: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), input: z.record(z.string().max(100), value), pagination: pagination.optional() }).strict();
const condition = z.union([z.object({ path, equals: z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]) }).strict(), z.object({ path, startsWith: z.string().min(1).max(4096) }).strict()]);
type Condition = z.infer<typeof condition>;
const each = z.object({ kind: z.literal("each"), id, from: path, where: condition.optional(), steps: z.array(call).min(1).max(20) }).strict();
const branch = z.object({ kind: z.literal("if"), id, where: condition, steps: z.array(call).min(1).max(20), otherwise: z.array(call).min(1).max(20).optional() }).strict();
const schema = z.object({ version: z.literal(1), steps: z.array(z.union([call, each, branch])).min(1).max(50), output: value.optional() }).strict();
export type Workflow = z.infer<typeof schema>;
export type ToolInvoker = (tool: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
export type WorkflowResult = { status: "completed" | "failed"; completed: string[]; unexercised?: string[]; failedStep?: string; error?: string; partial?: boolean; output?: unknown };

export function workflowToolNames(plan: Workflow): string[] {
  return [...new Set(plan.steps.flatMap((step) => step.kind === "call" ? [step.tool] : [...step.steps, ...(step.kind === "if" ? step.otherwise ?? [] : [])].map((call) => call.tool)))];
}

export function parseWorkflow(input: unknown): Workflow {
  const plan = schema.parse(input);
  const checkRefs = (entry: unknown): void => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) { for (const child of entry) checkRefs(child); return; }
    const record = entry as Record<string, unknown>;
    if (Object.hasOwn(record, "$ref")) { ref.parse(record); return; }
    for (const child of Object.values(record)) checkRefs(child);
  };
  const names = new Set<string>();
  checkRefs(plan.output);
  for (const step of plan.steps) {
    for (const part of step.kind === "call" ? [step] : [step, ...step.steps, ...(step.kind === "if" ? step.otherwise ?? [] : [])]) {
      if (names.has(part.id) || part.id === "item") throw new Error("Workflow step identifiers must be unique");
      names.add(part.id);
      if (part.kind === "call") {
        checkRefs(part.input);
        if (part.pagination && new Set([part.pagination.itemsPath, part.pagination.nextPath, ...(part.pagination.hasMorePath ? [part.pagination.hasMorePath] : [])]).size !== (part.pagination.hasMorePath ? 3 : 2)) throw new Error("Workflow pagination paths must be different");
      }
    }
  }
  return plan;
}

function readPath(context: Record<string, unknown>, path: string): unknown {
  let current: unknown = context;
  for (const part of path.split(".")) {
    if (part === "__proto__" || part === "prototype" || part === "constructor" || !current || typeof current !== "object" || !Object.hasOwn(current, part)) throw new Error("Workflow reference is unavailable");
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function optionalFinalPath(context: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  const last = parts.pop()!;
  if (["__proto__", "prototype", "constructor"].includes(last)) throw new Error("Workflow reference is unavailable");
  const parent = parts.length ? readPath(context, parts.join(".")) : context;
  if (!parent || typeof parent !== "object") throw new Error("Workflow reference is unavailable");
  return Object.hasOwn(parent, last) ? (parent as Record<string, unknown>)[last] : undefined;
}

function resolve(value: Value, context: Record<string, unknown>, depth = 0): unknown {
  if (depth > 20) throw new Error("Workflow input is too deeply nested");
  if (Array.isArray(value)) return value.map((item) => resolve(item, context, depth + 1));
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && "$ref" in value && typeof value.$ref === "string") return readPath(context, value.$ref);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, context, depth + 1)]));
  }
  return value;
}

function matches(context: Record<string, unknown>, condition: Condition): boolean {
  const actual = readPath(context, condition.path);
  if ("startsWith" in condition) {
    if (typeof actual !== "string") throw new Error("Workflow condition has an unexpected value type");
    return actual.startsWith(condition.startsWith);
  }
  if (condition.equals === null) return actual === null;
  if (actual === null || typeof actual !== typeof condition.equals) throw new Error("Workflow condition has an unexpected value type");
  return actual === condition.equals;
}

export async function executeWorkflow(plan: Workflow, invoke: ToolInvoker, signal: AbortSignal = new AbortController().signal): Promise<WorkflowResult> {
  const checked = parseWorkflow(plan);
  const completed: string[] = [];
  const context: Record<string, unknown> = Object.create(null);
  let active = "";
  let operations = 0;
  const runCall = async (step: z.infer<typeof call>, local: Record<string, unknown>) => {
    active = step.id;
    if (signal.aborted) throw new Error("Workflow cancelled");
    if (++operations > 500) throw new Error("Workflow operation limit exceeded");
    const args = resolve(step.input, local) as Record<string, unknown>;
    let result = await invoke(step.tool, args, signal);
    if (signal.aborted) { completed.push(step.id); throw new Error("Workflow cancelled after a tool response"); }
    if (step.pagination) {
      const { cursorArg, nextPath, itemsPath, hasMorePath, maxPages } = step.pagination;
      const root = (data: unknown) => ({ response: data });
      const items = readPath(root(result), `response.${itemsPath}`);
      if (!Array.isArray(items)) throw new Error("Paginated response requires a list");
      const all = [...items];
      if (all.length > 500) throw new Error("Workflow item limit exceeded");
      const first = structuredClone(result) as Record<string, unknown>;
      const seen = new Set<string>();
      let next = optionalFinalPath(root(result), `response.${nextPath}`);
      const checkMore = (data: unknown, cursor: unknown) => {
        if (!hasMorePath) return;
        const more = readPath(root(data), `response.${hasMorePath}`);
        if (typeof more !== "boolean" || (more && (cursor === null || cursor === undefined || cursor === "")) || (!more && cursor !== null && cursor !== undefined && cursor !== "")) throw new Error("Workflow pagination metadata is inconsistent");
      };
      checkMore(result, next);
      let pages = 1;
      while (next !== null && next !== undefined && next !== "") {
        if (typeof next !== "string" || seen.has(next)) throw new Error("Invalid or repeated pagination cursor");
        if (pages >= maxPages || all.length > 500) throw new Error("Workflow pagination limit exceeded");
        seen.add(next);
        if (signal.aborted) throw new Error("Workflow cancelled");
        if (++operations > 500) throw new Error("Workflow operation limit exceeded");
        result = await invoke(step.tool, { ...args, [cursorArg]: next }, signal);
        if (signal.aborted) throw new Error("Workflow cancelled");
        const page = readPath(root(result), `response.${itemsPath}`);
        if (!Array.isArray(page)) throw new Error("Paginated response requires a list");
        all.push(...page);
        if (all.length > 500) throw new Error("Workflow item limit exceeded");
        next = optionalFinalPath(root(result), `response.${nextPath}`);
        checkMore(result, next);
        pages++;
      }
      const writePath = (path: string, value: unknown) => {
        const fields = path.split(".");
        const key = fields.pop()!;
        const parent = fields.length ? readPath({ response: first }, `response.${fields.join(".")}`) : first;
        if (!parent || typeof parent !== "object" || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid pagination result path");
        (parent as Record<string, unknown>)[key] = value;
      };
      writePath(itemsPath, all);
      writePath(nextPath, next ?? null);
      if (hasMorePath) writePath(hasMorePath, false);
      result = first;
    }
    context[step.id] = result;
    local[step.id] = result;
    completed.push(step.id);
  };
  try {
    for (const step of checked.steps) {
      active = step.id;
      if (signal.aborted) throw new Error("Workflow cancelled");
      if (step.kind === "call") { await runCall(step, context); continue; }
      if (step.kind === "if") {
        const selected = matches(context, step.where) ? step.steps : step.otherwise ?? [];
        for (const child of selected) await runCall(child, context);
        continue;
      }
      const items = readPath(context, step.from);
      if (!Array.isArray(items)) throw new Error("Workflow loop requires a list");
      if (items.length > 500) throw new Error("Workflow item limit exceeded");
      for (const item of items) {
        const local = { ...context, item };
        if (step.where && !matches(local, step.where)) continue;
        for (const child of step.steps) await runCall(child, local);
      }
    }
    const output = checked.output === undefined ? undefined : resolve(checked.output, context);
    const calls = checked.steps.flatMap((step) => step.kind === "call" ? [step] : [...step.steps, ...(step.kind === "if" ? step.otherwise ?? [] : [])]);
    const unexercised = calls.filter((step) => !completed.includes(step.id)).map((step) => step.id);
    return { status: "completed", completed, ...(unexercised.length ? { unexercised } : {}), ...(output === undefined ? {} : { output }) };
  } catch (error) {
    return { status: "failed", completed, failedStep: active, ...(operations > 0 ? { partial: true } : {}), error: error instanceof Error ? error.message : "Workflow failed" };
  }
}
