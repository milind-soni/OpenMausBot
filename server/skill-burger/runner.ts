// Runs a saved Skill Burger without the AI: each step exactly as it was recorded, in the place it ran (an app through the
// connectors gate, a command in the bot's own box or on its cloud computer, a page in its browser, a file in its folder),
// with values piped from earlier steps and args filled from the person's request. The AI does only what needs judgement:
// an AI step, a decide step that weighs something, a desktop's clicks, and a case nobody has saved steps for yet. The run
// pauses there and hands the step to the bot, which does it and resumes. A run stops at the first failed step and never
// tries a step with side effects twice; each step has a time limit and an output cap.
import { randomUUID } from "node:crypto";

import { caseOf, type Workflow, type WorkflowRef, type WorkflowStep } from "../../shared/skill-burger/format.ts";
import { redactSecretsInText } from "../../shared/redact.ts";

export const STEP_TIMEOUT_MS = 60_000;
export const RUN_TIMEOUT_MS = 15 * 60_000;
export const OUTPUT_MAX_BYTES = 512 * 1024;
/** What an AI step is shown of the value piped into it. */
const HANDED_INPUT_MAX = 8_000;
const ERROR_MAX = 400;

/** What a step left for later steps, and how it went. */
export interface StepResult {
  state: "done" | "failed" | "skipped" | "not_taken" | "handed";
  output?: unknown;
  /** A decide step's chosen case. */
  case?: string;
  error?: string;
}

/** A paused run: everything a resume needs, kept on the server and found by its id. */
export interface RunState {
  id: string;
  name: string;
  botId: string;
  threadId: string;
  sha256: string;
  workflow: Workflow;
  args: Record<string, unknown>;
  results: Record<string, StepResult>;
  /** The step the bot was handed, and where the run goes on from. */
  waiting: { step: string; type: HandedType };
  createdAt: number;
}

export type HandedType = "ai_step" | "decide" | "missing_case";

/** The run's answer, in the statuses of the workflow tools agents already know: ok, needs_input or cancelled; a failed
 * step is ok:false with the step named. */
export interface RunEnvelope {
  protocolVersion: 1;
  ok: boolean;
  status?: "ok" | "needs_input" | "cancelled";
  run: string;
  /** Each step's state, in order, for the bot and the card. */
  steps: Array<{ id: string; label: string; state: StepResult["state"]; case?: string }>;
  output?: unknown;
  requiresInput?: {
    type: HandedType;
    step: string;
    label: string;
    prompt: string;
    input?: string;
    example?: string;
    cases?: string[];
    resumeToken: string;
  };
  error?: { type: "step_failed" | "timeout" | "output_too_large" | "runtime_error"; message: string; step?: string };
}

export type ExecResult = { ok: true; output: unknown } | { ok: false; error: string; tooLarge?: true };

export interface StepExecutors {
  shell(input: { command: string; cwd?: string; env: Record<string, string>; stdin?: string; where: "bot" | "vm"; tool: string; signal: AbortSignal; maxBytes: number }): Promise<ExecResult>;
  app(input: { app: string; tool: string; args: Record<string, unknown>; account?: string; signal: AbortSignal; maxBytes: number }): Promise<ExecResult>;
  browser(input: { url: string; signal: AbortSignal }): Promise<ExecResult>;
  file(input: { path: string; content: string; signal: AbortSignal }): Promise<ExecResult>;
}

/** Each step's start and end, as the chat shows any tool call: the card reads these to cook and stack the run's layers. */
export interface StepEvents {
  started(run: string, name: string, step: WorkflowStep): void;
  ended(run: string, name: string, step: WorkflowStep, result: StepResult): void;
}

export interface RunDeps {
  exec: StepExecutors;
  events: StepEvents;
  save(state: RunState): void;
  now?: () => number;
  signal?: AbortSignal;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The value at a dotted path ("data.items.0.id") of `value`. */
export function valueAt(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current = value;
  for (const part of path.split(".")) {
    if (Array.isArray(current)) current = current[Number(part)];
    else if (isRecord(current)) current = current[part];
    else return undefined;
  }
  return current;
}

const isRef = (value: unknown): value is WorkflowRef => isRecord(value) && (typeof value.$arg === "string" || typeof value.$step === "string") && Object.keys(value).every((key) => key === "$arg" || key === "$step" || key === "path");

/** `node` with every reference filled in: args from the run's args, steps from what earlier steps left. */
export function resolve(node: unknown, args: Record<string, unknown>, results: Record<string, StepResult>): unknown {
  if (isRef(node)) return "$arg" in node ? args[node.$arg] : valueAt(results[node.$step]?.output, node.path);
  if (Array.isArray(node)) return node.map((item) => resolve(item, args, results));
  if (isRecord(node)) return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolve(value, args, results)]));
  return node;
}

const asText = (value: unknown): string => (value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value));

function compare(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case "exists": return left !== undefined && left !== null && left !== "" && !(Array.isArray(left) && left.length === 0);
    case "eq": return asText(left) === asText(right);
    case "ne": return asText(left) !== asText(right);
    case "gt": return Number(left) > Number(right);
    case "lt": return Number(left) < Number(right);
    default: return false;
  }
}

type Condition = NonNullable<WorkflowStep["when"]>;
const holds = (when: Condition, results: Record<string, StepResult>) => compare(valueAt(results[when.$step]?.output, when.path), when.op, when.value);

/** The args a run uses: the defaults it was saved with, then what the bot filled in from the request. */
export function runArgs(workflow: Workflow, given: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, arg] of Object.entries(workflow.args)) if (arg.default !== undefined) out[name] = arg.default;
  for (const [name, value] of Object.entries(given)) if (Object.hasOwn(workflow.args, name)) out[name] = value;
  return out;
}

/** OMB_ARG_<NAME> for each arg, so a command reads its inputs without any text being spliced into it. */
export function argEnv(args: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(args).map(([name, value]) => [`OMB_ARG_${name.toUpperCase()}`, asText(value)]));
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function parsed(output: unknown): unknown {
  if (typeof output !== "string") return output;
  const trimmed = output.trim();
  if (!/^[[{]/.test(trimmed)) return output;
  try { return JSON.parse(trimmed); } catch { return output; }
}

/** Waits for `run` up to `ms`, aborting what it was given when the time is up. */
async function timed(ms: number, outer: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<ExecResult>): Promise<ExecResult | "timeout"> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  outer?.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<"timeout">((done) => { timer = setTimeout(() => { controller.abort(); done("timeout"); }, ms); }),
    ]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", stop);
  }
}

function handedPrompt(step: WorkflowStep, type: HandedType, missing?: { decide: string; case: string }): string {
  if (type === "missing_case") return `The run reached the "${missing!.case}" case of "${step.label}", which has no saved steps yet. Do that part yourself, by judgement, then resume the run with a one-line note of what you did.`;
  if (step.kind === "decide") return `${step.prompt ?? `Decide: ${step.label}`} Answer with exactly one of: ${step.cases.map((one) => JSON.stringify(one)).join(", ")}.`;
  if (step.kind === "ai") return `${step.prompt} Resume the run with what you wrote as the response.`;
  const where = step.where === "yourComputer" ? " on the person's own computer" : step.where === "vm" ? " on the cloud computer" : "";
  return `Do this step yourself${where}: ${step.label}. Look before acting, then resume the run with a one-line note of what you did.`;
}

/** Runs `workflow` from `from` until it ends, fails, or hands a step to the bot. */
export async function runFrom(state: Omit<RunState, "waiting" | "createdAt"> & { from: number }, deps: RunDeps): Promise<RunEnvelope> {
  const { id, name, workflow, args, results } = state;
  const now = deps.now ?? Date.now;
  const started = now();
  const envelope = (extra: Partial<RunEnvelope>): RunEnvelope => ({
    protocolVersion: 1, ok: true, run: id,
    steps: workflow.steps.filter((step) => results[step.id]).map((step) => ({ id: step.id, label: step.label, state: results[step.id]!.state, ...(results[step.id]!.case ? { case: results[step.id]!.case } : {}) })),
    ...extra,
  });
  const end = (step: WorkflowStep, result: StepResult) => {
    results[step.id] = result;
    deps.events.ended(id, name, step, result);
  };
  const hand = (step: WorkflowStep, type: HandedType, missing?: { decide: string; case: string }): RunEnvelope => {
    results[step.id] = { state: "handed", ...(missing ? { case: missing.case, output: { case: missing.case } } : {}) };
    if (type !== "missing_case") deps.events.started(id, name, step);
    deps.save({ ...state, results, waiting: { step: step.id, type }, createdAt: now() });
    const input = step.kind === "ai" || step.kind === "decide" ? step.input : undefined;
    const value = input ? resolve(input, args, results) : undefined;
    return envelope({
      status: "needs_input",
      requiresInput: {
        type, step: step.id, label: step.label, prompt: handedPrompt(step, type, missing), resumeToken: id,
        ...(value !== undefined ? { input: clip(redactSecretsInText(asText(value)), HANDED_INPUT_MAX) } : {}),
        ...(step.kind === "ai" && step.example ? { example: step.example } : {}),
        ...(step.kind === "decide" && type === "decide" ? { cases: step.cases } : {}),
      },
    });
  };

  for (let index = state.from; index < workflow.steps.length; index += 1) {
    const step = workflow.steps[index]!;
    if (deps.signal?.aborted) return envelope({ status: "cancelled" });
    if (now() - started > RUN_TIMEOUT_MS) return envelope({ ok: false, error: { type: "timeout", message: "The run went past its time limit.", step: step.id } });
    if (step.when && !holds(step.when, results)) {
      end(step, { state: caseOf(step) ? "not_taken" : "skipped" });
      continue;
    }
    if (step.kind === "decide") {
      const ruled = step.rules?.find((rule) => compare(valueAt(results[rule.$step]?.output, rule.path), rule.op, rule.value))?.case ?? (step.rules?.length ? step.otherwise : undefined);
      if (!ruled) return hand(step, "decide");
      deps.events.started(id, name, step);
      end(step, { state: "done", case: ruled, output: { case: ruled } });
      const missing = takeCase(workflow, index, ruled);
      if (missing) return hand(step, "missing_case", { decide: step.id, case: ruled });
      continue;
    }
    if (step.kind === "ai" || step.where === "yourComputer") return hand(step, "ai_step");

    deps.events.started(id, name, step);
    const limit = step.timeoutMs ?? STEP_TIMEOUT_MS;
    const outcome = await timed(limit, deps.signal, (signal) => execute(step, args, results, deps.exec, signal));
    if (outcome === "timeout") {
      end(step, { state: "failed", error: "timed out" });
      return envelope({ ok: false, error: { type: "timeout", message: `"${step.label}" took longer than ${Math.round(limit / 1000)} s and was stopped.`, step: step.id } });
    }
    if (!outcome.ok) {
      const message = clip(redactSecretsInText(outcome.error), ERROR_MAX);
      end(step, { state: "failed", error: message });
      return envelope({ ok: false, error: { type: outcome.tooLarge ? "output_too_large" : "step_failed", message: `"${step.label}" failed: ${message}`, step: step.id } });
    }
    end(step, { state: "done", output: parsed(outcome.output) });
  }
  const last = [...workflow.steps].reverse().find((step) => results[step.id]?.state === "done" && results[step.id]?.output !== undefined);
  return envelope({ status: "ok", ...(last ? { output: results[last.id]!.output } : {}) });
}

/** The case's steps after a decide step at `index`, or the case itself when nobody saved any. */
function takeCase(workflow: Workflow, index: number, chosen: string): boolean {
  const decide = workflow.steps[index]!.id;
  return !workflow.steps.slice(index + 1).some((step) => { const on = caseOf(step); return on?.decide === decide && on.case === chosen; });
}

async function execute(step: WorkflowStep, args: Record<string, unknown>, results: Record<string, StepResult>, exec: StepExecutors, signal: AbortSignal): Promise<ExecResult> {
  switch (step.kind) {
    case "shell": {
      const stdin = step.stdin ? asText(resolve(step.stdin, args, results)) : undefined;
      const where = step.where === "vm" ? "vm" : "bot";
      return exec.shell({ command: step.run, ...(step.cwd ? { cwd: step.cwd } : {}), env: argEnv(args), ...(stdin !== undefined ? { stdin } : {}), where, tool: where === "vm" ? "vm" : "shell", signal, maxBytes: OUTPUT_MAX_BYTES });
    }
    case "app":
      return exec.app({ app: step.app, tool: step.tool, args: resolve(step.args, args, results) as Record<string, unknown>, ...(step.account ? { account: step.account } : {}), signal, maxBytes: OUTPUT_MAX_BYTES });
    case "browser": {
      const url = asText(resolve(step.url, args, results));
      return /^https?:\/\//i.test(url) ? exec.browser({ url, signal }) : { ok: false, error: `not a web address: ${clip(url, 80)}` };
    }
    case "file":
      return exec.file({ path: step.path, content: asText(resolve(step.content, args, results)), signal });
    default:
      return { ok: false, error: "this step can't run on its own" };
  }
}

/** A new run of `workflow`, from its first step. */
export function startRun(input: { name: string; botId: string; threadId: string; sha256: string; workflow: Workflow; args?: Record<string, unknown> }, deps: RunDeps): Promise<RunEnvelope> {
  return runFrom({ id: randomUUID(), name: input.name, botId: input.botId, threadId: input.threadId, sha256: input.sha256, workflow: input.workflow, args: runArgs(input.workflow, input.args), results: {}, from: 0 }, deps);
}

/** Goes on with a paused run once the bot has done the step it was handed: `response` is what it wrote, or the case it
 * chose. A decide step's answer must be one of its cases. */
export function resumeRun(state: RunState, response: string, deps: RunDeps): Promise<RunEnvelope> | RunEnvelope {
  const { workflow, results, waiting } = state;
  const index = workflow.steps.findIndex((step) => step.id === waiting.step);
  const step = workflow.steps[index];
  if (!step) return { protocolVersion: 1, ok: false, run: state.id, steps: [], error: { type: "runtime_error", message: "This run's saved steps changed; start it again." } };
  if (waiting.type === "decide" && step.kind === "decide") {
    const chosen = step.cases.find((one) => one.toLowerCase() === response.trim().replace(/^["']|["']$/g, "").toLowerCase());
    if (!chosen) {
      deps.save(state);
      return { protocolVersion: 1, ok: false, run: state.id, steps: [], error: { type: "runtime_error", message: `Answer with one of: ${step.cases.map((one) => JSON.stringify(one)).join(", ")}.`, step: step.id } };
    }
    results[step.id] = { state: "done", case: chosen, output: { case: chosen } };
    deps.events.ended(state.id, state.name, step, results[step.id]!);
    if (takeCase(workflow, index, chosen)) {
      results[step.id] = { state: "handed", case: chosen, output: { case: chosen } };
      deps.save({ ...state, results, waiting: { step: step.id, type: "missing_case" }, createdAt: Date.now() });
      return {
        protocolVersion: 1, ok: true, status: "needs_input", run: state.id, steps: [],
        requiresInput: { type: "missing_case", step: step.id, label: step.label, prompt: handedPrompt(step, "missing_case", { decide: step.id, case: chosen }), resumeToken: state.id },
      };
    }
  } else if (waiting.type === "missing_case") {
    const chosen = results[step.id]?.case;
    results[step.id] = { state: "done", ...(chosen ? { case: chosen, output: { case: chosen } } : {}) };
  } else {
    results[step.id] = { state: "done", output: parsed(response) };
    deps.events.ended(state.id, state.name, step, results[step.id]!);
  }
  return runFrom({ ...state, results, from: index + 1 }, deps);
}
