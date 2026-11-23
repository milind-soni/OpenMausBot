// A saved burger: a workflow skill is SKILL.md (numbered steps any bot can follow) plus workflow.json (the exact steps,
// values and args a runner repeats without the AI). References are JSON values, never text templates: {"$arg": name}
// and {"$step": id, "path": "a.0.b"}. A shell step reads its args from OMB_ARG_<NAME> environment variables.
import { z } from "zod";

import { appMeta } from "./apps.ts";

export const WORKFLOW_FILE = "workflow.json";
export const WORKFLOW_TAG = "workflow";
export const WORKFLOW_MAX_STEPS = 40;
export const WORKFLOW_MAX_BYTES = 256 * 1024;
export const SUMMARY_MAX = 160;

const ref = z.union([
  z.object({ $arg: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/) }).strict(),
  z.object({ $step: z.string().regex(/^[a-z0-9_]{1,40}$/), path: z.string().max(200).optional() }).strict(),
]);
export type WorkflowRef = z.infer<typeof ref>;

const condition = z.object({
  $step: z.string(), path: z.string().max(200).optional(), op: z.enum(["eq", "ne", "gt", "lt", "exists"]), value: z.unknown().optional(),
}).strict();

const common = {
  id: z.string().regex(/^[a-z0-9_]{1,40}$/),
  label: z.string().min(1).max(120),
  when: condition.optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  /** Pause for the person before this step. Off unless someone turns it on. */
  check: z.boolean().optional(),
  /** Where it ran, so a replay runs it in the same place: an app, the browser, the bot's computer, a cloud computer (VM), the person's computer. */
  where: z.enum(["app", "browser", "bot", "vm", "yourComputer"]).optional(),
};

/** A case's name: a few plain words, as the person or the bot would say them ("support", "a refund"). */
export const caseName = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N}][\p{L}\p{N} '&-]*$/u);

/** One rule of a decide step: when an earlier step's output matches, the run takes `case`. */
const caseRule = condition.extend({ case: caseName });

const PLACE: Record<string, string> = { vm: "on the cloud computer", yourComputer: "on the person's own computer", browser: "in the browser" };

export const workflowStepSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("shell"), run: z.string().min(1).max(20_000), cwd: z.string().max(1_000).optional(), stdin: ref.optional() }).strict(),
  z.object({ ...common, kind: z.literal("app"), app: z.string().min(1).max(64), tool: z.string().min(1).max(200), args: z.record(z.string(), z.unknown()), account: z.string().max(200).optional() }).strict(),
  z.object({ ...common, kind: z.literal("browser"), action: z.literal("open"), url: z.union([z.string().url(), ref]) }).strict(),
  z.object({ ...common, kind: z.literal("file"), path: z.string().min(1).max(1_000), content: z.union([z.string(), ref]) }).strict(),
  z.object({
    ...common, kind: z.literal("ai"), deterministic: z.literal(false), prompt: z.string().min(1).max(4_000),
    input: ref.optional(), example: z.string().max(4_000).optional(),
  }).strict(),
  // A fork: rules on an earlier step's output pick a case, or the AI picks one by judgement. Steps for a case carry
  // `when: {"$step": <decide id>, "path": "case", "op": "eq", "value": <case>}`; the run takes only that case's steps.
  z.object({
    ...common, kind: z.literal("decide"), cases: z.array(caseName).min(1).max(8),
    rules: z.array(caseRule).max(16).optional(), otherwise: caseName.optional(),
    prompt: z.string().min(1).max(2_000).optional(), input: ref.optional(),
  }).strict(),
]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowSchema = z.object({
  version: z.literal(1),
  summary: z.string().min(1).max(SUMMARY_MAX),
  args: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.object({ default: z.unknown().optional(), label: z.string().max(80).optional() }).strict()),
  steps: z.array(workflowStepSchema).min(1).max(WORKFLOW_MAX_STEPS),
}).strict().superRefine((workflow, issue) => {
  const seen = new Map<string, WorkflowStep>();
  for (const step of workflow.steps) {
    if (seen.has(step.id)) issue.addIssue({ code: "custom", message: `step id ${step.id} is used twice` });
    if (step.kind === "decide" && !step.rules?.length && !step.prompt) issue.addIssue({ code: "custom", message: `decide step ${step.id} needs rules or a prompt` });
    const fork = caseOf(step);
    if (fork) {
      const decide = seen.get(fork.decide);
      if (decide?.kind !== "decide") issue.addIssue({ code: "custom", message: `step ${step.id} follows a case of ${fork.decide}, which is no earlier decide step` });
      else if (!decide.cases.includes(fork.case)) issue.addIssue({ code: "custom", message: `step ${step.id} follows case "${fork.case}", which ${fork.decide} doesn't have` });
    }
    seen.set(step.id, step);
  }
});
export type Workflow = z.infer<typeof workflowSchema>;

/** The decide step and case a step belongs to, read from its `when`; null for a step every run takes. */
export function caseOf(step: Pick<WorkflowStep, "when">): { decide: string; case: string } | null {
  const when = step.when;
  if (!when || when.path !== "case" || when.op !== "eq" || typeof when.value !== "string") return null;
  return { decide: when.$step, case: when.value };
}

/** The `when` that puts a step on one case of a decide step. */
export const onCase = (decide: string, name: string) => ({ $step: decide, path: "case", op: "eq" as const, value: name });

/** A skill name from the summary's first words: lowercase, hyphens, unique among `taken`. */
export function workflowSkillName(summary: string, taken: ReadonlySet<string>): string {
  const words = summary.toLowerCase().replace(/['’]/gu, "").normalize("NFKD").replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/[^a-z0-9\s-]/g, "").split(/[\s-]+/).filter(Boolean);
  const stem = words.slice(0, 6).join("-").slice(0, 48).replace(/-+$/, "") || "saved-workflow";
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n += 1) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

const yamlScalar = (value: string) => JSON.stringify(value.replace(/\s+/g, " ").trim());

function stepLine(step: WorkflowStep, args: Workflow["args"]): string {
  if (step.kind === "decide") return `Decide: ${step.label} (${step.cases.map((one) => `"${one}"`).join(", ")})${step.prompt ? " (your judgement)" : ""}`;
  const where = step.kind === "app" ? appMeta(step.app).label : step.kind === "ai" ? "AI" : step.kind === "shell" ? "Command" : step.kind === "file" ? "File" : "Browser";
  const used = Object.keys(args).filter((name) => JSON.stringify(step).includes(`"$arg":"${name}"`) || (step.kind === "shell" && step.run.includes(`OMB_ARG_${name.toUpperCase()}`)));
  const detail = used.map((name) => `${args[name]!.label ?? name}: ${name}${args[name]!.default === undefined ? "" : `, default ${JSON.stringify(args[name]!.default)}`}`);
  const what = step.kind === "shell" ? ` \`${step.run.split("\n", 1)[0]!.slice(0, 120)}\`` : step.kind === "app" ? ` (${step.tool})` : "";
  const place = step.where && PLACE[step.where] && !(step.kind === "browser" && step.where === "browser") ? ` ${PLACE[step.where]}` : "";
  const fork = caseOf(step);
  return `${fork ? `[only when ${fork.decide} is "${fork.case}"] ` : ""}${where}${place}: ${step.label}${what}${detail.length ? ` (${detail.join("; ")})` : ""}${step.kind === "ai" ? " (your judgement)" : ""}`;
}

/** SKILL.md for a saved burger: the steps in words, so a bot can follow them even where nothing replays workflow.json. */
export function renderWorkflowSkillMd(name: string, workflow: Workflow): string {
  const title = workflow.summary.replace(/[.!?]+$/, "");
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${yamlScalar(workflow.summary)}`,
    `tags: ${WORKFLOW_TAG}`,
    "---",
    "",
    `# ${title}`,
    "",
    `A workflow saved from a run in chat. Run it with the run_workflow tool (name "${name}"), putting values from the request in its args. Where that tool isn't available, do these steps in order with the values in ${WORKFLOW_FILE} beside this file; a step marked as your judgement is yours to do well, the rest repeat exactly.`,
    "",
    ...workflow.steps.map((step, index) => `${index + 1}. ${stepLine(step, workflow.args)}`),
    "",
  ];
  return lines.join("\n");
}
