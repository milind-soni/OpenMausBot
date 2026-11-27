import { SAVE_RUN_AS_SKILL_LINE } from "../../shared/learn-request";
import type { Message } from "@/state/store";
import { t } from "./i18n";
import { parseRunCommand } from "../../shared/run-command";

export type RunStep = {
  id: string;
  command: string;
  label: string;
  status: "running" | "passed" | "failed" | "unverified";
  dryRun: boolean;
  verified: boolean;
};
/** @deprecated Use RunStep. */
export type VerifyStep = RunStep;

export { nameIsCommand } from "../../shared/tool-name";

/** The driver's summary, never the name: server status chips quote commands in their name. */
export function commandOf(m: Message): string | undefined {
  return m.kind === "activity" ? m.tool?.summary || undefined : undefined;
}

export { parseControlCommand, parseRunCommand } from "../../shared/run-command";


function askIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role === "user" && m.kind === "text" && m.text?.trim()) return i;
  }
  return -1;
}

export function askText(messages: Message[]): string | undefined {
  const index = askIndex(messages);
  if (index < 0) return undefined;
  const line = messages[index].text!.trim().split(/\r?\n/, 1)[0].trim();
  return line ? line.slice(0, 300) : undefined;
}

export function runSteps(messages: Message[], liveTools: ReadonlySet<string> = new Set()): RunStep[] {
  const steps: RunStep[] = [];
  for (const m of messages.slice(askIndex(messages) + 1)) {
    const command = commandOf(m);
    const parsed = command ? parseRunCommand(command) : undefined;
    if (!command || !parsed) continue;
    const ok = m.tool?.ok;
    steps.push({ id: m.id, command, ...parsed, status: ok === undefined ? (liveTools.has(m.id) ? "running" : "unverified") : ok ? "passed" : "failed" });
  }
  return steps;
}
/** @deprecated Use runSteps. */
export const verifySteps = runSteps;

export function showRun(steps: RunStep[]): boolean {
  return steps.some((step) => step.verified) || steps.length >= 2;
}

export function runSummary(steps: RunStep[]): {
  total: number;
  verified: number;
  passed: number;
  failed: number;
  running: number;
  unverified: number;
  dryRuns: number;
  label: string;
} {
  const counts = { total: steps.length, verified: 0, passed: 0, failed: 0, running: 0, unverified: 0, dryRuns: 0 };
  for (const step of steps) {
    if (step.verified) counts.verified += 1;
    if (step.dryRun && ["passed", "failed"].includes(step.status)) counts.dryRuns += 1;
    else counts[step.status] += 1;
  }
  const label = [
    counts.total === 1 ? t("chat.verify.stepsOne") : t("chat.verify.stepsMany", { count: counts.total }),
    counts.verified > 0 && t("chat.verify.verifiedCount", { count: counts.verified }),
    counts.failed > 0 && t("chat.verify.failed", { count: counts.failed }),
    counts.running > 0 && t("chat.verify.running", { count: counts.running }),
    counts.unverified > 0 && t("chat.verify.unverified", { count: counts.unverified }),
    counts.dryRuns === 1 ? t("chat.verify.dryRunOne") : counts.dryRuns > 1 && t("chat.verify.dryRunMany", { count: counts.dryRuns }),
  ].filter(Boolean).join(" · ");
  return { ...counts, label };
}
/** @deprecated Use runSummary. */
export const verifySummary = runSummary;

export type RunSkill = "pending" | "saved" | null;
export function runSkill(messages: Message[], steps: RunStep[]): RunSkill {
  const first = steps[0];
  if (!first) return null;
  const start = messages.findIndex((m) => m.id === first.id);
  if (start < 0) return null;
  const card = messages.slice(start + 1).findLast((m) => m.kind === "options" && m.card?.skillRequest !== undefined)?.card;
  if (!card || card.undone) return null;
  if (card.answered === "allow") return "saved";
  return card.answered || card.dismissed || card.expired ? null : "pending";
}

const MARK = { passed: "✓", failed: "✗", running: "…", unverified: "?" } as const;

const stepLine = (step: RunStep) =>
  `${step.dryRun ? "[dry run]" : MARK[step.status]} ${step.label} — ${step.command}${step.verified ? " (verified)" : ""}`;

export function skillPrompt(steps: RunStep[], ask?: string): string {
  const lines = steps.some((step) => step.verified)
    ? [
      "Create a verification skill from the run below.",
      ...(ask ? [`Goal: ${ask}`] : []),
      "Do not re-run these steps; their results are in this thread. Use the passing ones as the recipe with their exact commands and note the failed ones as gotchas.",
    ]
    : [
      SAVE_RUN_AS_SKILL_LINE,
      `Goal: ${ask ?? "the run below"}`,
      "Keep the exact commands and note the failed ones as gotchas. Do not re-run anything.",
    ];
  return [...lines, "", ...steps.map(stepLine), "", ""].join("\n");
}
