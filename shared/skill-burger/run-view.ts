// A Skill Burger run as its card shows it: the saved steps in order, each with how it went in this run, read from the
// step rows the run left in the chat. A decide step shows its cases, the steps of each case sit under it, and the cases
// this run didn't take are greyed. Shared so the card and its tests read runs the same way.
import { caseOf, type Workflow } from "./format.ts";
import { RUN_STEP_MARK, type LayerKind, type RunMessage } from "./layers.ts";

export type RowState = "waiting" | "running" | "done" | "failed" | "skipped" | "not_taken";

/** What a step's row can open to: each teammate's reply and the rounds it took, a check's verdict. */
export interface RowDetail {
  replies?: Array<{ name: string; ok: boolean; text: string }>;
  rounds?: number;
  check?: { passed: boolean; says: string; why?: string };
}

export interface RunRow {
  id: string;
  kind: LayerKind;
  app?: string;
  label: string;
  /** 1 for a step of a case, under its decide step. */
  depth: 0 | 1;
  /** A case's name, on the first step of each case. */
  caseHeading?: string;
  /** A decide step's cases, and the one this run took. */
  cases?: string[];
  chosen?: string;
  state: RowState;
  error?: string;
  /** Who a delegate step goes to. */
  who?: string[];
  detail?: RowDetail;
}

export interface RunView {
  run: string;
  name: string;
  rows: RunRow[];
  /** A case this run took that has no saved steps: the bot did it by judgement, and its steps can be added. */
  missing?: { decide: string; case: string };
}

interface StepSeen { state: RowState; case?: string; error?: string; detail?: RowDetail }

function parse(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The newest run in `messages` (the turn since the person's last ask), and each of its steps as its row says. */
export function latestRun(messages: readonly RunMessage[], live: ReadonlySet<string> = new Set()): { run: string; name: string; steps: Map<string, StepSeen> } | null {
  type Found = { run: string; name: string; steps: Map<string, StepSeen> };
  let found = null as Found | null;
  for (const message of messages) {
    if (message.role === "user" && message.kind === "text") { found = null; continue; }
    const input = message.kind === "activity" ? parse(message.tool?.input) : null;
    const run = input?.[RUN_STEP_MARK];
    if (typeof run !== "string" || typeof input?.step !== "string" || typeof input.name !== "string") continue;
    if (found?.run !== run) found = { run, name: input.name, steps: new Map() };
    const output = parse(message.tool?.output);
    const ended = typeof output?.state === "string" ? output.state as string : undefined;
    const state: RowState = ended === "done" || ended === "failed" || ended === "skipped" || ended === "not_taken" ? ended
      : message.tool?.ok === false ? "failed" : live.has(message.id) || message.tool?.ok === undefined ? "running" : "done";
    const detail = output?.detail && typeof output.detail === "object" && !Array.isArray(output.detail) ? output.detail as RowDetail : undefined;
    found.steps.set(input.step, { state, ...(typeof output?.case === "string" ? { case: output.case } : {}), ...(typeof output?.error === "string" ? { error: output.error } : {}), ...(detail ? { detail } : {}) });
  }
  return found;
}

/** The card's rows for `workflow` in the run `seen`; with no run, every step waits. */
export function runView(workflow: Workflow, seen: ReturnType<typeof latestRun>, name = seen?.name ?? ""): RunView {
  const steps = seen?.steps ?? new Map<string, StepSeen>();
  let lastCase = "";
  const rows: RunRow[] = workflow.steps.map((step) => {
    const on = caseOf(step);
    const heading = on && `${on.decide}:${on.case}` !== lastCase ? on.case : undefined;
    lastCase = on ? `${on.decide}:${on.case}` : "";
    const got = steps.get(step.id);
    return {
      id: step.id,
      kind: step.kind,
      ...(step.kind === "app" ? { app: step.app } : {}),
      label: step.label,
      depth: on ? 1 : 0,
      ...(heading ? { caseHeading: heading } : {}),
      ...(step.kind === "decide" ? { cases: step.cases, ...(got?.case ? { chosen: got.case } : {}) } : {}),
      state: got?.state ?? "waiting",
      ...(got?.error ? { error: got.error } : {}),
      ...(step.kind === "delegate" ? { who: step.tasks.map((task) => task.bot.name) } : {}),
      ...(got?.detail ? { detail: got.detail } : {}),
    };
  });
  const missing = workflow.steps.flatMap((step) => {
    const chosen = steps.get(step.id)?.case;
    if (step.kind !== "decide" || !chosen) return [];
    return workflow.steps.some((other) => { const on = caseOf(other); return on?.decide === step.id && on.case === chosen; }) ? [] : [{ decide: step.id, case: chosen }];
  })[0];
  return { run: seen?.run ?? "", name, rows, ...(missing ? { missing } : {}) };
}
