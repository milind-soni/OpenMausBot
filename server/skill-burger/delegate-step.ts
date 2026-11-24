// A saved Skill Burger's delegate step, run the way the bot ran it: each teammate gets its own message through the same
// coordinate_bots door (sent as this turn, so every hand-off rule and limit applies), all at once; the run pauses while
// they work, and their replies resume the bot as any hand-off's do. If a reply falls short of its done-when, the bot says
// which and why, and only those go back, for at most the step's review rounds. A teammate that is gone is matched by name
// or role, else the bot picks who does its part (asking the person if it can't tell).
import type { WorkflowRef, WorkflowStep, WorkflowText } from "../../shared/skill-burger/format.ts";
import { teammateNames } from "../../shared/skill-burger/format.ts";

type DelegateStep = Extract<WorkflowStep, { kind: "delegate" }>;
export type Teammate = { id: string; name: string; title?: string };
export type Settled = { status: string; result: string };

/** Where a delegation is between pauses: who each part went to, the hand-offs out now, and the replies so far. */
export interface DelegationState {
  round: number;
  /** A saved teammate's name → who does its part now; null when the bot left that part out. */
  who: Record<string, { id: string; name: string } | null>;
  requests: Array<{ part: string; botId: string; name: string; requestId: string }>;
  replies: Record<string, { name: string; ok: boolean; text: string; round: number }>;
}

export interface DelegateExecutors {
  /** The teammates this bot can hand work to now. */
  teammates(signal: AbortSignal): Promise<Teammate[]>;
  /** One coordinate_bots call as this turn: its receipts, or why it was refused. */
  delegate(input: { botIds: string[]; message: string; doneWhen?: string; rework?: boolean; consult?: boolean; signal: AbortSignal }): Promise<{ ok: true; receipts: Array<{ botId: string; name: string; requestId: string }> } | { ok: false; error: string }>;
  /** A hand-off's status and result, once it can be read. */
  assignment(id: string, signal: AbortSignal): Promise<Settled | null>;
}

const SETTLED = new Set(["completed", "failed", "cancelled", "done"]);
const REPLY_MAX = 3_000;
const REPLIES_MAX = 9_000;
const norm = (value: string) => value.trim().toLowerCase().replace(/^@/, "");

/** `text` with its gaps filled: args and earlier steps' outputs, as plain words. */
export function textOf(value: WorkflowText, fill: (ref: WorkflowRef) => unknown): string {
  if (typeof value === "string") return value;
  return value.map((part) => {
    if (typeof part === "string") return part;
    const got = fill(part);
    return got === undefined || got === null ? "" : typeof got === "string" ? got : JSON.stringify(got);
  }).join("");
}

/** Who does each saved part now: the same bot by id, else by name, else the one teammate with the same role. A part
 * the bot already reassigned keeps its choice. Unmatched parts are returned as missing. */
export function matchTeammates(step: DelegateStep, roster: readonly Teammate[], chosen: DelegationState["who"] = {}): { who: DelegationState["who"]; missing: DelegateStep["tasks"] } {
  const who: DelegationState["who"] = { ...chosen };
  const missing: DelegateStep["tasks"] = [];
  for (const task of step.tasks) {
    if (task.bot.name in who) continue;
    const byId = task.bot.id ? roster.find((bot) => bot.id === task.bot.id) : undefined;
    const byName = roster.filter((bot) => norm(bot.name) === norm(task.bot.name));
    const byRole = task.bot.role ? roster.filter((bot) => bot.title && norm(bot.title) === norm(task.bot.role!)) : [];
    const found = byId ?? (byName.length === 1 ? byName[0] : undefined) ?? (byRole.length === 1 ? byRole[0] : undefined);
    if (found) who[task.bot.name] = { id: found.id, name: found.name };
    else missing.push(task);
  }
  return { who, missing };
}

/** The bot's answer for parts whose teammate is gone: "Ada" for one part, or "Kiwi=Ada, Rio=skip" for several. */
export function readReassignment(response: string, missing: DelegateStep["tasks"], roster: readonly Teammate[]): DelegationState["who"] | { error: string } {
  const out: DelegationState["who"] = {};
  const pairs = /[=:]/.test(response) ? response.split(/[,;\n]+/).map((pair) => pair.split(/[=:]/).map((side) => side.trim())) : [[missing[0]?.bot.name ?? "", response.trim()]];
  for (const [part = "", pick = ""] of pairs) {
    const task = missing.find((one) => norm(one.bot.name) === norm(part));
    if (!task) continue;
    if (/^(?:skip|none|no one|nobody)$/i.test(pick)) { out[task.bot.name] = null; continue; }
    const bot = roster.find((one) => norm(one.name) === norm(pick) || one.id === pick);
    if (!bot) return { error: `${pick} isn't one of your teammates. Answer with a name from list_bots, or "skip".` };
    out[task.bot.name] = { id: bot.id, name: bot.name };
  }
  const left = missing.filter((task) => !(task.bot.name in out));
  return left.length ? { error: `Say who does ${teammateNames(left, false)}'s part ("${left[0]!.bot.name}=<teammate>", or "skip").` } : out;
}

/** The handed prompt for parts whose teammate is gone. */
export function missingPrompt(missing: DelegateStep["tasks"]): string {
  const parts = missing.map((task) => `${task.bot.name}${task.bot.role ? ` (${task.bot.role})` : ""}`).join(", ");
  return `${parts} ${missing.length > 1 ? "aren't" : "isn't"} one of your teammates any more. Pick who does ${missing.length > 1 ? "each" : "that"} part from list_bots and resume with ${missing.length > 1 ? '"Name=Teammate, …"' : "their name"}, or "skip" to leave it out. If you can't tell who fits, ask the person once, then resume.`;
}

/** Sends the round's work: each part's message to whoever does it now, one call per distinct message (at most four
 * teammates a call). Returns the hand-offs, or why a call was refused. */
export async function sendRound(step: DelegateStep, state: DelegationState, fill: (ref: WorkflowRef) => unknown, exec: DelegateExecutors, signal: AbortSignal,
  fixes?: Record<string, string>): Promise<{ ok: true; requests: DelegationState["requests"] } | { ok: false; error: string }> {
  const calls = new Map<string, { parts: string[]; botIds: string[]; message: string; doneWhen?: string }>();
  for (const task of step.tasks) {
    const to = state.who[task.bot.name];
    if (!to || (fixes && !(task.bot.name in fixes))) continue;
    const base = textOf(task.message, fill);
    const message = fixes ? `${fixes[task.bot.name]}\n\nThe work, as first asked:\n${base}` : base;
    const key = `${message}\u0000${task.doneWhen ?? ""}`;
    const call = calls.get(key) ?? { parts: [], botIds: [], message, ...(task.doneWhen ? { doneWhen: task.doneWhen } : {}) };
    if (!call.botIds.includes(to.id)) { call.parts.push(task.bot.name); call.botIds.push(to.id); }
    calls.set(key, call);
  }
  const requests: DelegationState["requests"] = [];
  for (const call of calls.values()) {
    for (let at = 0; at < call.botIds.length; at += 4) {
      const botIds = call.botIds.slice(at, at + 4);
      const sent = await exec.delegate({ botIds, message: call.message, ...(call.doneWhen ? { doneWhen: call.doneWhen } : {}), ...(fixes ? { rework: true } : {}), ...(step.consult ? { consult: true } : {}), signal });
      if (!sent.ok) return sent;
      for (const [index, botId] of botIds.entries()) {
        const receipt = sent.receipts.find((one) => one.botId === botId);
        if (receipt?.requestId) requests.push({ part: call.parts[at + index]!, botId, name: receipt.name, requestId: receipt.requestId });
      }
    }
  }
  return requests.length ? { ok: true, requests } : { ok: false, error: "no teammate took the work" };
}

/** The replies, once every hand-off of the round has settled; the names still working while some haven't. */
export async function collect(state: DelegationState, exec: DelegateExecutors, signal: AbortSignal): Promise<{ waiting: string[] } | { replies: DelegationState["replies"] }> {
  const replies = { ...state.replies };
  const waiting: string[] = [];
  for (const request of state.requests) {
    const got = await exec.assignment(request.requestId, signal);
    if (!got || !SETTLED.has(got.status)) { waiting.push(request.name); continue; }
    replies[request.part] = { name: request.name, ok: got.status === "completed" || got.status === "done", text: got.result.slice(0, REPLY_MAX * 4), round: state.round };
  }
  return waiting.length ? { waiting } : { replies };
}

/** The replies as the review prompt and later steps read them. */
export function repliesText(replies: DelegationState["replies"]): string {
  const each = Math.max(600, Math.floor(REPLIES_MAX / Math.max(1, Object.keys(replies).length)));
  return Object.entries(replies).map(([part, reply]) => `## ${reply.name}${reply.name !== part ? ` (for ${part})` : ""}${reply.ok ? "" : " (did not finish)"}\n${reply.text.slice(0, Math.min(each, REPLY_MAX))}`).join("\n\n");
}

export function reviewPrompt(step: DelegateStep, state: DelegationState): string {
  const done = step.tasks.map((task) => (task.doneWhen ? `${task.bot.name}: ${task.doneWhen.replace(/[.\s]+$/, "")}` : "")).filter(Boolean);
  const left = (step.review?.rounds ?? 0) - (state.round - 1);
  return [
    `Check each teammate's reply${done.length ? ` against what done means:\n${done.join("\n")}` : " for whether it does what was asked"}`,
    step.review?.example ? `When this workflow was saved, the extra round asked: ${step.review.example.replace(/\s+/g, " ").slice(0, 600)}` : "",
    `Answer with JSON only: {"redo": {"<teammate>": "what to fix or check again"}} for replies that fall short, or {"redo": {}} when all are done. ${left} more round${left === 1 ? "" : "s"} allowed.`,
  ].filter(Boolean).join("\n");
}

/** The bot's review answer: who goes back with what. Null when it isn't that JSON. */
export function readReview(response: string, state: DelegationState): Record<string, string> | null {
  const json = /\{[\s\S]*\}/.exec(response)?.[0];
  if (!json) return /^\s*(?:done|all done|pass|ok)\b/i.test(response) ? {} : null;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  const redo = parsed && typeof parsed === "object" ? (parsed as { redo?: unknown }).redo : undefined;
  if (!redo || typeof redo !== "object" || Array.isArray(redo)) return null;
  const out: Record<string, string> = {};
  for (const [name, fix] of Object.entries(redo as Record<string, unknown>)) {
    const part = Object.entries(state.replies).find(([key, reply]) => norm(key) === norm(name) || norm(reply.name) === norm(name))?.[0];
    if (part && typeof fix === "string" && fix.trim()) out[part] = fix.trim().slice(0, 2_000);
  }
  return out;
}
