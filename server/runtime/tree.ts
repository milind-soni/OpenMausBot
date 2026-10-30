// "Since this turn began" is read from event ids (one global order), never timestamps: a clock can step back.
import type { RuntimeStore } from "./store.ts";
import { terminal, type Assignment, type Owner, type TurnEvidence } from "./types.ts";

export const CUT_TWICE = "Interrupted by another OpenMausBot restart after resuming once; not resumed again. Some of its steps may already have taken effect.";

export const INTERRUPTED_OUTWARD = "Interrupted by an OpenMausBot restart after it already";

const OUTWARD_SHOWN = 4;
const OUTWARD_LABEL_MAX = 48;

function describeOutward(label: string): string {
  // Tool slugs join words with underscores (word characters), so these match without \b.
  if (/\bgit\s+push\b/i.test(label)) return `pushed (${label})`;
  if (/\bgit\s+commit\b/i.test(label)) return `committed (${label})`;
  if (/pay|charge|refund|transfer/i.test(label)) return `made a payment (${label})`;
  if (/mail/i.test(label)) return `sent an email (${label})`;
  if (/send|message|reply/i.test(label)) return `sent a message (${label})`;
  if (/post|publish|tweet/i.test(label)) return `posted (${label})`;
  return `completed an outward action (${label})`;
}

export function outwardDetail(labels: readonly string[]): string {
  const seen = new Set<string>();
  for (const label of labels) {
    const short = clip(label.replace(/\s+/g, " ").trim(), OUTWARD_LABEL_MAX);
    if (short) seen.add(short);
  }
  const all = [...seen];
  const shown = all.slice(0, OUTWARD_SHOWN).map(describeOutward);
  const more = all.length > OUTWARD_SHOWN ? ` and ${all.length - OUTWARD_SHOWN} more` : "";
  return `${INTERRUPTED_OUTWARD} ${shown.join(", ")}${more}; not resumed, so nothing is done twice.`;
}

export const outwardInterrupted = (a: Assignment): boolean =>
  a.outcome === "interrupted" && (a.outcomeDetail?.startsWith(INTERRUPTED_OUTWARD) ?? false);

export const NO_PROGRESS_STRIKES = 2;
export const SAME_ERROR_STRIKES = 3;
const ERROR_TEXT_MAX = 200;
const STOP_TEXT_MAX = 300;

export type LoopGuard = NonNullable<Assignment["guard"]>;

export function nextGuard(previous: LoopGuard | undefined, evidence: TurnEvidence | undefined): LoopGuard {
  const before = previous?.stale ?? 0;
  const stale = evidence?.okToolCalls === undefined ? before : evidence.okToolCalls === 0 ? before + 1 : 0;
  const fresh = (evidence?.errors ?? []).map(text => clip(text.trim(), ERROR_TEXT_MAX)).filter(Boolean);
  const errors = [...(previous?.errors ?? []), ...fresh].slice(-SAME_ERROR_STRIKES);
  return { stale, errors };
}

export function loopStop(guard: LoopGuard, text: string): { reason: string; detail: string } | undefined {
  if (guard.stale >= NO_PROGRESS_STRIKES) {
    return { reason: `${guard.stale} continuations without a successful tool call`,
      detail: `Stopped after ${guard.stale} continuations without progress: ${clip(text.trim(), STOP_TEXT_MAX)}` };
  }
  const [first] = guard.errors;
  if (first !== undefined && guard.errors.length >= SAME_ERROR_STRIKES && guard.errors.every(error => error === first)) {
    return { reason: `the same error ${SAME_ERROR_STRIKES} times`, detail: `Stopped after ${SAME_ERROR_STRIKES} identical errors: ${first}` };
  }
  return undefined;
}

export const duration = (ms: number): string => ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;

export const clip = (text: string, max: number): string => text.length > max ? text.slice(0, max) : text;

export const isTerminal = (a: Assignment): boolean => terminal(a.status);

export const awaited = (children: readonly Assignment[]): Assignment[] => children.filter(c => c.reply !== "none");

/** Parked on a question the person answers in words; a card park waits on the card instead. */
export const asking = (a: Assignment): boolean => a.status === "needs_input" && !(a.cards && a.cards.length > 0);

export function path(store: RuntimeStore, n: Assignment): Assignment[] {
  const out: Assignment[] = [];
  const seen = new Set<string>();
  for (let cur: Assignment | undefined = n; cur; cur = cur.parentId ? store.get(cur.parentId) : undefined) {
    if (seen.has(cur.id)) throw new Error("Invalid assignment ancestry");
    seen.add(cur.id);
    out.unshift(cur);
  }
  return out;
}

/** Matches the "<status>: rerun <n>" detail restart reconciliation writes: a rerun anchors at the turn before the cut one. */
export function lastStartedId(store: RuntimeStore, id: string): number {
  const events = store.events(id);
  let cut = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === "restart_reconciled" && /: rerun /.test(event.detail ?? "")) cut += 1;
    else if (event.kind === "started") {
      if (cut > 0) { cut -= 1; continue; }
      return event.id;
    }
  }
  return 0;
}

export function continuations(store: RuntimeStore, id: string): number {
  return store.events(id).filter(e => e.kind === "continued").length;
}

export function childrenSince(store: RuntimeStore, n: Assignment): Assignment[] {
  const since = lastStartedId(store, n.id);
  return store.children(n.id).filter(c => (store.events(c.id)[0]?.id ?? 0) > since);
}

export function wakeOwner(n: Assignment): Owner {
  const owner: Owner = {};
  if (n.requester.botId !== undefined) owner.botId = n.requester.botId;
  if (n.requester.threadId !== undefined) owner.threadId = n.requester.threadId;
  if (n.requester.runId !== undefined) owner.runId = n.requester.runId;
  return owner;
}

export function ownsConversation(n: Assignment, owner: Owner): boolean {
  if (owner.threadId !== undefined) {
    return n.assignee.destination.threadId === owner.threadId && (owner.botId === undefined || n.assignee.botId === owner.botId);
  }
  if (owner.runId !== undefined) return !n.parentId && n.requester.runId === owner.runId;
  return false;
}

export function restartNote(n: Assignment, children: readonly Assignment[], nameOf: (child: Assignment) => string): string {
  if (!n.restart) return "";
  const own = n.restart === "rerun"
    ? "OpenMausBot restarted while your previous turn here was running and cut it off; this turn continues it. First check what that turn already did (files, commits, messages, anything sent or started) and verify anything uncertain, so nothing is done twice; then finish and report as usual. A restart alone is not a blocker."
    : n.restart === "cut" ? "OpenMausBot restarted before your previous turn here finished, after it sent work to teammates. Check what that turn already did before repeating any of it." : "";
  const cut = children.filter(child => child.restarts > 0 || outwardInterrupted(child)).map(child => `${nameOf(child)} (${
    outwardInterrupted(child) ? "cut after an outward action, not resumed: see its result"
      : child.outcome === "interrupted" ? "cut again while resuming, so not resumed a second time: it may be partly done"
      : child.status === "completed" ? "resumed once in place and told to check what it had already done"
      : `set to resume once but ended ${child.status} before finishing, so it may be partly done: see its result`})`);
  const teammates = cut.length ? `A restart cut these teammates' turns: ${cut.join("; ")}. Check their results as usual.` : "";
  return own || teammates ? `${[own, teammates].filter(Boolean).join(" ")}\n` : "";
}
