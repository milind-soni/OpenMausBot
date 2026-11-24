// Runs a saved Skill Burger without the AI: each step exactly as it was recorded, in the place it ran (an app through the
// connectors gate, a command in the bot's own box or on its cloud computer, a page in its browser, a file in its folder),
// with values piped from earlier steps and args filled from the person's request. The AI does only what needs judgement:
// an AI step, a decide step that weighs something, a desktop's clicks, and a case nobody has saved steps for yet. The run
// pauses there and hands the step to the bot, which does it and resumes. A run stops at the first failed step and never
// tries a step with side effects twice; each step has a time limit and an output cap.
import { randomUUID } from "node:crypto";

import { caseOf, teammateNames, type Workflow, type WorkflowRef, type WorkflowStep } from "../../shared/skill-burger/format.ts";
import { redactSecretsInText } from "../../shared/redact.ts";
import { appMeta } from "../../shared/skill-burger/apps.ts";
import { collect, matchTeammates, missingPrompt, readReassignment, readReview, repliesText, reviewPrompt, sendRound, type DelegateExecutors, type DelegationState } from "./delegate-step.ts";

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
  /** What the card shows of it: each teammate's reply, a check's verdict. Small and bounded. */
  detail?: StepDetail;
}

/** What a step's row on the run card can open to: the replies of a delegation and its rounds, a check's verdict. */
export interface StepDetail {
  replies?: Array<{ name: string; ok: boolean; text: string }>;
  rounds?: number;
  waitingOn?: string[];
  check?: { passed: boolean; says: string; why?: string };
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
  /** A delegate step under way: who does each part, the hand-offs out, the replies so far. */
  delegation?: DelegationState & { step: string };
  createdAt: number;
}

/** What the run waits on: the bot's own step or answer, teammates' replies, or the bot fixing a failed step. */
export type HandedType = "ai_step" | "decide" | "missing_case" | "teammates" | "review" | "missing_bot" | "check" | "failed";

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
  /** Inputs the request didn't give, so the run used the values the burger was saved with. */
  defaults?: Array<{ name: string; value: unknown }>;
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
  /** `needs_connection`: a step needs an app this bot isn't connected to; nothing ran, and `apps` names them. */
  error?: { type: "step_failed" | "timeout" | "output_too_large" | "runtime_error" | "needs_connection"; message: string; step?: string; resumeToken?: string; apps?: string[] };
}

export type ExecResult = { ok: true; output: unknown } | { ok: false; error: string; tooLarge?: true };

export interface StepExecutors extends Partial<DelegateExecutors> {
  shell(input: { command: string; cwd?: string; env: Record<string, string>; stdin?: string; where: "bot" | "vm"; tool: string; signal: AbortSignal; maxBytes: number }): Promise<ExecResult>;
  app(input: { app: string; tool: string; args: Record<string, unknown>; account?: string; signal: AbortSignal; maxBytes: number }): Promise<ExecResult>;
  browser(input: { url: string; signal: AbortSignal }): Promise<ExecResult>;
  file(input: { path: string; content: string; signal: AbortSignal }): Promise<ExecResult>;
  /** The apps this bot is connected to (their slugs), or null when that can't be told. */
  connected?(): Promise<readonly string[] | null>;
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

/** A check's rule on a step's own output, or null when only the bot can tell. */
function checkRule(step: WorkflowStep): { says: string; rule?: { path?: string; op: string; value?: unknown } } | null {
  if (!step.check) return null;
  return step.check === true ? { says: "the result looks right for what the request asked" } : step.check;
}

const TEAMMATES_PROMPT = (names: string, token: string) => `${names} have the work now. End your turn: their replies resume you. Then call run_workflow with resume ${JSON.stringify(token)} and response "back".`;

/** A prompt's {input} names as this run's values: the request a judgement step was saved with, as asked this time. */
export function fillPrompt(prompt: string, args: Record<string, unknown>): string {
  return prompt.replace(/\{([a-z][a-z0-9_]{0,39})\}/g, (whole, name: string) => (Object.hasOwn(args, name) ? asText(args[name]) : whole));
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
  const hand = (step: WorkflowStep, type: HandedType, missing?: { decide: string; case: string }, extra: { prompt?: string; input?: string; delegation?: RunState["delegation"] } = {}): RunEnvelope => {
    if (type !== "teammates" && type !== "review") results[step.id] = { ...(type === "check" ? results[step.id] : {}), state: "handed", ...(missing ? { case: missing.case, output: { case: missing.case } } : {}) };
    if (type !== "missing_case") deps.events.started(id, name, step);
    const { delegation: _old, ...rest } = state as typeof state & { delegation?: unknown };
    deps.save({ ...rest, results, waiting: { step: step.id, type }, ...(extra.delegation ? { delegation: extra.delegation } : {}), createdAt: now() });
    const input = step.kind === "ai" || step.kind === "decide" ? step.input : undefined;
    const value = extra.input ?? (input ? resolve(input, args, results) : undefined);
    return envelope({
      status: "needs_input",
      requiresInput: {
        type, step: step.id, label: step.label, prompt: fillPrompt(extra.prompt ?? handedPrompt(step, type, missing), args), resumeToken: id,
        ...(value !== undefined ? { input: clip(redactSecretsInText(asText(value)), HANDED_INPUT_MAX) } : {}),
        ...(step.kind === "ai" && step.example ? { example: step.example } : {}),
        ...(step.kind === "decide" && type === "decide" ? { cases: step.cases } : {}),
      },
    });
  };
  /** A failed step stops the run, and the run can go on from it once the bot has fixed the cause. Nothing is retried by itself. */
  const fail = (step: WorkflowStep, type: NonNullable<RunEnvelope["error"]>["type"], message: string, detail?: StepDetail): RunEnvelope => {
    end(step, { state: "failed", error: message, ...(detail ? { detail } : {}) });
    deps.save({ ...state, results, waiting: { step: step.id, type: "failed" }, createdAt: now() });
    return envelope({ ok: false, error: { type, message: type === "timeout" ? message : `"${step.label}" failed: ${message}`, step: step.id, resumeToken: id } });
  };

  /** Sends a delegate step's first round, or hands the bot the parts whose teammate is gone. */
  const startDelegation = async (step: Extract<WorkflowStep, { kind: "delegate" }>, chosen: DelegationState["who"]): Promise<RunEnvelope> => {
    const exec = deps.exec;
    if (!exec.teammates || !exec.delegate || !exec.assignment) return fail(step, "step_failed", "this bot can't hand work to teammates here");
    const signal = deps.signal ?? new AbortController().signal;
    const roster = await exec.teammates(signal).catch(() => []);
    const { who, missing } = matchTeammates(step, roster, chosen);
    const delegation: NonNullable<RunState["delegation"]> = state.delegation?.step === step.id && state.delegation.pendingSend
      ? { ...state.delegation, who }
      : { step: step.id, round: 1, who, requests: [], replies: {}, pendingSend: {} };
    if (missing.length) return hand(step, "missing_bot", undefined, { prompt: missingPrompt(missing), delegation });
    const sent = await sendRound(step, delegation, (ref) => resolve(ref, args, results), exec as DelegateExecutors, signal, delegation.pendingSend?.fixes, delegation.requests);
    delegation.requests = sent.requests;
    if (!sent.ok) {
      state.delegation = delegation;
      return fail(step, "step_failed", clip(redactSecretsInText(sent.error), ERROR_MAX));
    }
    delete delegation.pendingSend;
    const names = [...new Set(sent.requests.map((request) => request.name))];
    results[step.id] = { state: "handed", detail: { waitingOn: names, rounds: delegation.round } };
    return hand(step, "teammates", undefined, { prompt: TEAMMATES_PROMPT(teammateNames(names.map((one) => ({ bot: { name: one } })), false), id), delegation });
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
    if (step.kind === "delegate") return startDelegation(step, state.delegation?.step === step.id ? state.delegation.who : {});

    deps.events.started(id, name, step);
    const limit = step.timeoutMs ?? STEP_TIMEOUT_MS;
    const outcome = await timed(limit, deps.signal, (signal) => execute(step, args, results, deps.exec, signal))
      .catch((error: unknown): ExecResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    if (deps.signal?.aborted) return envelope({ status: "cancelled" });
    if (outcome === "timeout") return fail(step, "timeout", `"${step.label}" took longer than ${Math.round(limit / 1000)} s and was stopped.`);
    if (!outcome.ok) return fail(step, outcome.tooLarge ? "output_too_large" : "step_failed", clip(redactSecretsInText(outcome.error), ERROR_MAX));
    const output = parsed(outcome.output);
    const check = checkRule(step);
    if (check?.rule) {
      if (!compare(valueAt(output, check.rule.path), check.rule.op, check.rule.value)) return fail(step, "step_failed", `its check didn't hold: ${check.says}`, { check: { passed: false, says: check.says } });
    } else if (check) {
      results[step.id] = { state: "done", output };
      return hand(step, "check", undefined, { prompt: `Check this step's result against: "${check.says}". Resume with "pass", or "fail: <why>".`, input: asText(output) });
    }
    end(step, { state: "done", output, ...(check?.rule ? { detail: { check: { passed: true, says: check.says } } } : {}) });
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

/** A new run of `workflow`, from its first step. The envelope names the inputs the request didn't give, so the bot can
 * say which saved values it used instead of reusing them silently. */
const squash = (slug: string) => slug.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The apps the steps every run takes need and this bot isn't connected to: asked for before anything runs, so a run
 * never stops halfway for a connection. A case's steps are checked by the connectors gate when the run gets there. */
export async function missingApps(workflow: Workflow, exec: StepExecutors): Promise<string[]> {
  const needed = [...new Set(workflow.steps.flatMap((step) => (step.kind === "app" && !step.when ? [step.app] : [])))];
  if (!needed.length || !exec.connected) return [];
  const connected = await exec.connected().catch(() => null);
  if (!connected) return [];
  const have = new Set(connected.map(squash));
  return needed.filter((app) => !have.has(squash(app)));
}

export async function startRun(input: { name: string; botId: string; threadId: string; sha256: string; workflow: Workflow; args?: Record<string, unknown> }, deps: RunDeps): Promise<RunEnvelope> {
  const missing = await missingApps(input.workflow, deps.exec);
  if (missing.length) {
    const names = missing.map((app) => appMeta(app).label);
    return { protocolVersion: 1, ok: false, run: randomUUID(), steps: [], error: { type: "needs_connection", apps: missing, message: `Nothing ran: this Skill Burger needs ${names.join(", ")}, which ${names.length > 1 ? "aren't" : "isn't"} connected for this bot.` } };
  }
  const given = input.args ?? {};
  const defaults = Object.entries(input.workflow.args).filter(([name, arg]) => !Object.hasOwn(given, name) && arg.default !== undefined).map(([name, arg]) => ({ name, value: arg.default }));
  const envelope = await runFrom({ id: randomUUID(), name: input.name, botId: input.botId, threadId: input.threadId, sha256: input.sha256, workflow: input.workflow, args: runArgs(input.workflow, input.args), results: {}, from: 0 }, deps);
  return defaults.length ? { ...envelope, defaults } : envelope;
}

const refused = (state: RunState, message: string, step?: string): RunEnvelope => ({ protocolVersion: 1, ok: false, run: state.id, steps: [], error: { type: "runtime_error", message, ...(step ? { step } : {}) } });

/** Goes on with a paused run once the bot has done the step it was handed: `response` is what it wrote, the case it
 * chose, its review of teammates' replies, or anything once it fixed what made a step fail. A decide step's answer must
 * be one of its cases. */
export async function resumeRun(state: RunState, response: string, deps: RunDeps): Promise<RunEnvelope> {
  const { workflow, results, waiting } = state;
  const index = workflow.steps.findIndex((step) => step.id === waiting.step);
  const step = workflow.steps[index];
  if (!step) return refused(state, "This run's saved steps changed; start it again.");
  const goOn = (from: number) => runFrom({ ...state, results, from }, deps);
  const ask = (type: HandedType, prompt: string, extra: Partial<RunState> = {}, input?: string): RunEnvelope => {
    deps.save({ ...state, results, ...extra, waiting: { step: step.id, type }, createdAt: Date.now() });
    return { protocolVersion: 1, ok: true, status: "needs_input", run: state.id, steps: [], requiresInput: { type, step: step.id, label: step.label, prompt, resumeToken: state.id, ...(input ? { input: clip(redactSecretsInText(input), HANDED_INPUT_MAX) } : {}) } };
  };
  if (waiting.type === "failed") {
    // The bot fixed what made this step fail: the run goes on from that step, the steps before it are not run again.
    return goOn(index);
  }
  if (waiting.type === "check") {
    const verdict = response.trim();
    if (/^pass\b/i.test(verdict)) {
      results[step.id] = { ...results[step.id], state: "done", detail: { check: { passed: true, says: checkRule(step)?.says ?? "" } } };
      deps.events.ended(state.id, state.name, step, results[step.id]!);
      return goOn(index + 1);
    }
    const why = verdict.replace(/^fail[:\s-]*/i, "").slice(0, ERROR_MAX) || "it didn't meet its check";
    results[step.id] = { state: "failed", error: why, detail: { check: { passed: false, says: checkRule(step)?.says ?? "", why } } };
    deps.events.ended(state.id, state.name, step, results[step.id]!);
    deps.save({ ...state, results, waiting: { step: step.id, type: "failed" }, createdAt: Date.now() });
    return { protocolVersion: 1, ok: false, run: state.id, steps: [], error: { type: "step_failed", message: `"${step.label}" didn't pass its check: ${why}`, step: step.id, resumeToken: state.id } };
  }
  if (step.kind === "delegate" && (waiting.type === "teammates" || waiting.type === "review" || waiting.type === "missing_bot")) {
    const delegation = state.delegation;
    const exec = deps.exec as DelegateExecutors;
    const signal = deps.signal ?? new AbortController().signal;
    if (!delegation || delegation.step !== step.id || !exec.assignment) return refused(state, "This run lost track of its teammates; start it again.", step.id);
    const fill = (ref: WorkflowRef) => resolve(ref, state.args, results);
    if (waiting.type === "missing_bot") {
      const roster = await exec.teammates(signal).catch(() => []);
      const { missing } = matchTeammates(step, roster, delegation.who);
      const picked = readReassignment(response, missing, roster);
      if ("error" in picked) return ask("missing_bot", `${picked.error} ${missingPrompt(missing)}`, { delegation });
      return runFrom({ ...state, results, from: index, delegation: { ...delegation, who: { ...delegation.who, ...picked } } }, deps);
    }
    const finish = (unmet: string[] = []) => {
      const replies = Object.values(delegation.replies);
      results[step.id] = {
        state: "done",
        output: { replies: Object.fromEntries(replies.map((reply) => [reply.name, reply.text])), text: repliesText(delegation.replies), rounds: delegation.round, ...(unmet.length ? { unmet } : {}) },
        detail: { rounds: delegation.round, replies: replies.map((reply) => ({ name: reply.name, ok: reply.ok, text: reply.text.slice(0, 600) })) },
      };
      deps.events.ended(state.id, state.name, step, results[step.id]!);
      const { delegation: _done, ...rest } = state;
      return runFrom({ ...rest, results, from: index + 1 }, deps);
    };
    if (waiting.type === "teammates") {
      const got = await collect(delegation, exec, signal);
      if ("waiting" in got) return ask("teammates", `Still waiting on ${got.waiting.join(", ")}. End your turn; their replies resume you. Then call run_workflow with resume ${JSON.stringify(state.id)} again.`, { delegation });
      delegation.replies = got.replies;
      const roundsLeft = (step.review?.rounds ?? 0) - (delegation.round - 1);
      if (roundsLeft > 0) return ask("review", reviewPrompt(step, delegation), { delegation }, repliesText(delegation.replies));
      return finish();
    }
    const redo = readReview(response, delegation);
    if (!redo) return ask("review", `Answer with JSON only. ${reviewPrompt(step, delegation)}`, { delegation }, repliesText(delegation.replies));
    const parts = Object.keys(redo);
    if (!parts.length) return finish();
    if (delegation.round - 1 >= (step.review?.rounds ?? 0)) return finish(parts);
    const next: NonNullable<RunState["delegation"]> = { ...delegation, round: delegation.round + 1, requests: [], pendingSend: { fixes: redo } };
    const sent = await sendRound(step, next, fill, exec, signal, redo);
    next.requests = sent.requests;
    if (!sent.ok) {
      results[step.id] = { state: "failed", error: clip(sent.error, ERROR_MAX) };
      deps.events.ended(state.id, state.name, step, results[step.id]!);
      deps.save({ ...state, results, delegation: next, waiting: { step: step.id, type: "failed" }, createdAt: Date.now() });
      return { protocolVersion: 1, ok: false, run: state.id, steps: [], error: { type: "step_failed", message: `"${step.label}" couldn't send the work back: ${clip(sent.error, ERROR_MAX)}`, step: step.id, resumeToken: state.id } };
    }
    delete next.pendingSend;
    const names = [...new Set(sent.requests.map((request) => request.name))];
    results[step.id] = { state: "handed", detail: { waitingOn: names, rounds: next.round } };
    return ask("teammates", TEAMMATES_PROMPT(names.join(", "), state.id), { delegation: next });
  }
  if (waiting.type === "decide" && step.kind === "decide") {
    const chosen = step.cases.find((one) => one.toLowerCase() === response.trim().replace(/^["']|["']$/g, "").toLowerCase());
    if (!chosen) {
      deps.save(state);
      return refused(state, `Answer with one of: ${step.cases.map((one) => JSON.stringify(one)).join(", ")}.`, step.id);
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
    const output = parsed(response);
    const check = checkRule(step);
    if (check?.rule && !compare(valueAt(output, check.rule.path), check.rule.op, check.rule.value)) {
      const why = `its check didn't hold: ${check.says}`;
      results[step.id] = { state: "failed", error: why, detail: { check: { passed: false, says: check.says } } };
      deps.events.ended(state.id, state.name, step, results[step.id]!);
      deps.save({ ...state, results, waiting: { step: step.id, type: "failed" }, createdAt: Date.now() });
      return { protocolVersion: 1, ok: false, run: state.id, steps: [], error: { type: "step_failed", message: `"${step.label}" failed: ${why}`, step: step.id, resumeToken: state.id } };
    }
    results[step.id] = { state: "done", output, ...(check?.rule ? { detail: { check: { passed: true, says: check.says } } } : {}) };
    if (check && !check.rule) return ask("check", fillPrompt(`Check this step's result against: "${check.says}". Resume with "pass", or "fail: <why>".`, state.args), {}, asText(output));
    deps.events.ended(state.id, state.name, step, results[step.id]!);
  }
  return goOn(index + 1);
}
