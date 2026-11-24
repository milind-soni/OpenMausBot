// A finished run as the card explains it before it is saved: the goal, the inputs it found, each step in plain words
// with who did it, what each teammate was asked and sent back, what "done" meant, the tries it took, and whether the
// step repeats exactly or is the bot's to redo with judgement. Built on the server from the same draft a save writes,
// so the step ids the person unticks are the ids that are saved. The person's choices (steps left out, inputs renamed
// or given another value) are applied here too, the same way the save applies them.
import { textLine, type Workflow, type WorkflowStep } from "./format.ts";
import { askOf, type BurgerLayer, type LayerKind, type RunMessage } from "./layers.ts";

const ASKED_MAX = 1_200;
const BACK_MAX = 1_500;
const OUTCOME_MAX = 1_500;
const ARG_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export interface DraftStepView {
  id: string;
  kind: LayerKind;
  app?: string;
  label: string;
  /** Repeats exactly as saved; false when the bot redoes it with judgement. */
  exact: boolean;
  who?: Array<{ name: string; role?: string }>;
  /** What each teammate was asked, with the inputs' values filled in. */
  asked?: Array<{ who: string; text: string }>;
  /** What came back in this run: shown, never saved. */
  back?: Array<{ who: string; text: string; ok: boolean; round: number }>;
  /** Rounds this run took, and how many extra the saved step allows. */
  rounds?: number;
  reviewRounds?: number;
  doneWhen?: string;
  /** The command, address, file or app action, in a line. */
  detail?: string;
  /** Failed tries of it this run folded away. */
  tries?: number;
  /** Steps whose output this one uses: leaving one of those out leaves this one out too. */
  needs: string[];
}

export interface DraftView {
  goal: string;
  inputs: Array<{ name: string; value: string; label?: string }>;
  steps: DraftStepView[];
  /** What the bot told the person at the end. */
  outcome?: string;
}

export interface DraftChoices {
  /** Steps to leave out. */
  skip?: string[];
  /** An input's new name, or another saved value. */
  inputs?: Record<string, { name?: string; value?: string }>;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The steps whose output `node` uses. */
function refsIn(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((item) => refsIn(item, into));
  else if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (typeof record.$step === "string") into.add(record.$step);
    for (const [key, value] of Object.entries(record)) if (key !== "id") refsIn(value, into);
  }
  return into;
}

const needsOf = (step: WorkflowStep) => [...refsIn({ ...step, id: undefined })].filter((id) => id !== step.id);

function detailOf(step: WorkflowStep): string | undefined {
  switch (step.kind) {
    case "shell": return step.run.split("\n").find((line) => line.trim() && !/^cd\s/.test(line.trim()))?.trim().slice(0, 200);
    case "app": return step.tool;
    case "browser": return typeof step.url === "string" ? step.url : `{${"$arg" in step.url ? step.url.$arg : step.url.$step}}`;
    case "file": return step.path;
    default: return undefined;
  }
}

/** The text of a message with each input shown as its value. */
function filled(value: Parameters<typeof textLine>[0], args: Workflow["args"]): string {
  return typeof value === "string" ? value : value.map((part) => (typeof part === "string" ? part : "$arg" in part ? String(args[part.$arg]?.default ?? `{${part.$arg}}`) : `{${part.$step}}`)).join("");
}

/** The card's view of `workflow`, drafted from `layers` (the run's finished layers, in order) of `messages`. */
export function draftView(workflow: Workflow, layers: readonly BurgerLayer[], messages: readonly RunMessage[]): DraftView {
  const layerOf = (id: string) => layers[Number(/^s(\d+)/.exec(id)?.[1] ?? 0) - 1];
  const steps = workflow.steps.map((step): DraftStepView => {
    const layer = layerOf(step.id);
    const base: DraftStepView = {
      id: step.id, kind: step.kind, label: step.label, exact: step.kind !== "ai" && !(step.kind === "decide" && !step.rules?.length), needs: needsOf(step),
      ...(step.kind === "app" ? { app: step.app } : {}), ...(detailOf(step) ? { detail: detailOf(step) } : {}),
      ...(layer?.tries && !step.id.endsWith("_write") ? { tries: layer.tries } : {}),
    };
    if (step.kind !== "delegate") return base;
    const delegation = layer?.delegation;
    const done = [...new Set(step.tasks.map((task) => task.doneWhen).filter((one): one is string => Boolean(one)))];
    return {
      ...base,
      who: step.tasks.map((task) => ({ name: task.bot.name, ...(task.bot.role ? { role: task.bot.role } : {}) })),
      asked: step.tasks.map((task) => ({ who: task.bot.name, text: clip(filled(task.message, workflow.args), ASKED_MAX) })),
      ...(delegation ? { back: delegation.replies.map((reply) => ({ who: reply.name, text: clip(reply.text, BACK_MAX), ok: reply.ok, round: reply.round })), rounds: delegation.rounds.length } : {}),
      ...(step.review ? { reviewRounds: step.review.rounds } : {}),
      ...(done.length ? { doneWhen: done.join(" / ") } : {}),
    };
  });
  const lastText = [...messages].reverse().find((message) => message.role === "bot" && message.kind === "text" && !message.roomRequest && message.text?.trim());
  const inputs = Object.entries(workflow.args).map(([name, arg]) => ({ name, value: typeof arg.default === "string" ? arg.default : JSON.stringify(arg.default ?? ""), ...(arg.label ? { label: arg.label } : {}) }));
  return { goal: workflow.summary || askOf(messages) || "", inputs, steps, ...(lastText ? { outcome: clip(lastText.text!.trim(), OUTCOME_MAX) } : {}) };
}

/** Every step that uses `id`'s output, directly or through another. */
export function dependents(steps: ReadonlyArray<{ id: string; needs: readonly string[] }>, id: string): string[] {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of steps) if (!out.has(step.id) && step.needs.some((need) => need === id || out.has(need))) { out.add(step.id); grew = true; }
  }
  return [...out];
}

/** Renames an arg everywhere it is used: references and the OMB_ARG_ variables in commands. */
function renameArg(steps: WorkflowStep[], from: string, to: string): WorkflowStep[] {
  const env = new RegExp(`OMB_ARG_${from.toUpperCase()}(?![A-Z0-9_])`, "g");
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    if (record.$arg === from && Object.keys(record).length === 1) return { $arg: to };
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, walk(value)]));
  };
  return steps.map((step) => {
    const renamed = walk(step) as WorkflowStep;
    return renamed.kind === "shell" ? { ...renamed, run: renamed.run.replace(env, `OMB_ARG_${to.toUpperCase()}`) } : renamed;
  });
}

/** `workflow` with the person's choices made, or what is wrong with them. */
export function applyChoices(workflow: Workflow, choices: DraftChoices | undefined): Workflow | { error: string } {
  if (!choices) return workflow;
  const skip = new Set(choices.skip ?? []);
  let steps = workflow.steps.filter((step) => !skip.has(step.id) && !(step.id.endsWith("_write") && skip.has(step.id.replace(/_write$/, ""))));
  if (!steps.length) return { error: "Keep at least one step." };
  const kept = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    const missing = needsOf(step).find((id) => !kept.has(id) && workflow.steps.some((one) => one.id === id));
    if (missing) return { error: `"${step.label}" uses what "${workflow.steps.find((one) => one.id === missing)!.label}" returns; leave both out or keep both.` };
  }
  const args: Workflow["args"] = {};
  const used = (name: string) => JSON.stringify(steps).includes(`"$arg":"${name}"`) || JSON.stringify(steps).includes(`{${name}}`) || steps.some((step) => step.kind === "shell" && new RegExp(`OMB_ARG_${name.toUpperCase()}(?![A-Z0-9_])`).test(step.run));
  for (const [name, arg] of Object.entries(workflow.args)) {
    const choice: { name?: string; value?: string } | undefined = choices.inputs?.[name];
    const to = choice?.name?.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_") || name;
    if (!ARG_NAME.test(to)) return { error: `"${choice?.name}" can't be an input's name: use letters, numbers and _ only, starting with a letter.` };
    if (to !== name && (to in args || (to in workflow.args && !(choices.inputs?.[to]?.name)))) return { error: `There is already an input named ${to}.` };
    if (to !== name) steps = renameArg(steps, name, to);
    if (!used(to)) continue;
    args[to] = { ...arg, ...(choice?.value !== undefined ? { default: choice.value } : {}) };
  }
  return { ...workflow, args, steps };
}
