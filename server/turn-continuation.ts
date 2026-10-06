import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RuntimeEvent } from "./contracts.ts";
import type { Store } from "./store.ts";

/**
 * Automatic continuity: when a turn ends without a final answer and the work
 * is resumable (budget cap or tool errors), persist a structured handoff and
 * let the harness start a `Continue:` thread on the same bot — transparent to
 * the bot, which just sees a normal new thread seeded with the handoff.
 *
 * The handoff is written by the driver that has the full transcript in hand;
 * the continuation is driven by a bus subscriber in the harness (index.ts).
 */

/** Resolve the handoff directory the same way the server resolves its data
 * dir (server/cli.ts): OMB_DATA_DIR wins, else ~/.openmausbot. */
export function handoffDir(): string {
  return join(process.env.OMB_DATA_DIR || join(homedir(), ".openmausbot"), "handoffs");
}

export interface HandoffInput {
  threadId: string;
  turnId: string;
  model?: string;
  usage?: { input: number; output: number };
  hasUsage?: boolean;
  failure?: string;
  toolCalls: number;
  messages: Array<{
    role: string;
    content?: unknown;
    tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  }>;
}

/** Persist a structured markdown handoff for a turn that ended without a
 * final answer. Returns the file path, or null when the write fails. */
export function writeTurnHandoff(input: HandoffInput): string | null {
  try {
    const dir = handoffDir();
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `cap-${String(input.threadId).slice(0, 8)}-${String(input.turnId).slice(0, 8)}-${stamp}.md`);
    const L: string[] = [];
    L.push("# Handoff - turn ended without a final answer", "");
    L.push(`- Thread: ${input.threadId}`);
    L.push(`- Turn: ${input.turnId}`);
    L.push(`- Model: ${input.model ?? "unknown"}`);
    L.push(`- Tool calls used: ${input.toolCalls}`);
    if (input.hasUsage && input.usage) L.push(`- Tokens this turn: ${input.usage.input} in / ${input.usage.output} out`);
    L.push(`- Stop reason: ${input.failure ?? "unknown"}`);
    L.push(`- Written at: ${new Date().toISOString()}`, "");
    L.push("## Original task (first user message)", "```");
    const firstUser = input.messages.find((m) => m.role === "user");
    const firstText = firstUser && typeof firstUser.content === "string"
      ? firstUser.content
      : JSON.stringify(firstUser?.content ?? null);
    L.push(String(firstText).slice(0, 8000), "```", "");
    L.push("## Work performed (tool calls in order)", "");
    let n = 0;
    for (const m of input.messages) {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          n += 1;
          const args = String(tc.function?.arguments ?? "").replace(/\s+/g, " ").slice(0, 300);
          L.push(`${n}. ${tc.function?.name ?? "tool"} - ${args}`);
        }
      } else if (m.role === "tool") {
        let verdict = "?";
        try { verdict = JSON.parse(String(m.content)).ok ? "ok" : "FAILED"; } catch { /* keep "?" */ }
        L.push(`   result ${verdict}: ${String(m.content ?? "").replace(/\s+/g, " ").slice(0, 220)}`);
      }
    }
    if (n === 0) L.push("(none recorded)");
    L.push("", "## Last assistant text", "");
    let last: string | null = null;
    for (let i = input.messages.length - 1; i >= 0; i -= 1) {
      const c = input.messages[i].content;
      if (input.messages[i].role === "assistant" && typeof c === "string" && c.trim()) { last = c; break; }
    }
    L.push(last ? last.slice(0, 6000) : "(none)", "");
    L.push("## Instructions for whoever continues this task", "");
    L.push("1. Read this file completely.");
    L.push("2. Re-verify the current state of every file, branch, and PR mentioned above before acting - it may be stale.");
    L.push("3. Continue from the first unfinished step. Do not redo completed work.");
    L.push("4. If you get close to your own turn budget, append your progress to this file before stopping.");
    writeFileSync(file, L.join("\n"), { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

/** Provider config errors are not resumable: looping on them burns budget and
 * masks the real fix (change the model or the tool set). Everything else that
 * stops a turn without a final answer is a candidate for auto-continuation. */
const NOT_RESUMABLE = /not a multimodal model|unknown model|does not support|tool arguments do not match/i;

/** Classify a terminal turn as resumable. Returns the reason for the
 * continuation (`cap` = budget exhausted), or null when the turn must not be
 * auto-continued. A tool error is never continued: it includes a person's or
 * the approval policy's denial, and a new unattended thread would retry what
 * was refused. */
export function classifyContinuable(_stopReason: string | null | undefined, failure: string | undefined): "cap" | null {
  if (!failure) return null;
  if (NOT_RESUMABLE.test(failure)) return null;
  if (/limit reached|stopped after \d+ steps|without a final answer/i.test(failure)) return "cap";
  return null;
}

export interface CapContinuationDeps {
  store: Pick<Store, "botByThread" | "taskByThread" | "createTask" | "appendMessage">;
  startTurn: (botId: string, text: string, opts?: { threadId?: string; unattended?: boolean }) => Promise<unknown>;
  now?: () => number;
  /** External conversations retain their own exact task/request identity. */
  canContinue?: (threadId: string) => boolean;
}

const CONTINUE_TITLE = /^Continue: /;
const MAX_PER_BOT_PER_HOUR = 5;
const WINDOW_MS = 3600e3;

/** Bus subscriber: on `cap.exhausted`, create a `Continue:` task on the same
 * bot and start a turn seeded with the handoff. Bounded — at most five
 * continuations per bot per hour, never a continuation of a continuation, and
 * never the same source thread twice. A failure escalates with an activity
 * message carrying the handoff path instead of silently recursing. */
export function makeCapContinuationSubscriber(deps: CapContinuationDeps): (event: RuntimeEvent) => void {
  const state = new Map<string, { last: number; count: number; continued: Set<string> }>();
  return (event: RuntimeEvent) => {
    if (event.type !== "cap.exhausted" || !event.handoffPath) return;
    if (deps.canContinue && !deps.canContinue(event.threadId)) return;
    void (async () => {
      const bot = deps.store.botByThread(event.threadId);
      if (!bot) return;
      const now = deps.now ? deps.now() : Date.now();
      let rec = state.get(bot.id);
      if (!rec || now - rec.last > WINDOW_MS || rec.continued.size > 100) {
        rec = { last: now, count: 0, continued: new Set() };
        state.set(bot.id, rec);
      }
      if (rec.count >= MAX_PER_BOT_PER_HOUR || rec.continued.has(event.threadId)) return;
      const deadTask = deps.store.taskByThread(bot.id, event.threadId);
      if (!deadTask) return;
      if (CONTINUE_TITLE.test(deadTask.title ?? "")) return;
      const approvalMode = deadTask.approvalMode === "ask" || deadTask.approvalMode === "full" ? deadTask.approvalMode : undefined;
      const contTask = deps.store.createTask(
        bot.id, `Continue: ${(deadTask.title ?? "task").slice(0, 90)}`, true,
        deadTask.projectId, undefined, approvalMode, deadTask.modelSelection,
      );
      if (!contTask) return;
      rec.count += 1;
      rec.last = now;
      rec.continued.add(event.threadId);
      const prompt = `[Auto-continuation] The task "${deadTask.title}" stopped because its turn ended without a final answer (${event.reason}). A handoff file with the full state was written to ${event.handoffPath}. Read that file first, re-verify the current state of anything it mentions, then continue the task from where it stopped. Do not redo completed work. If you cannot finish, append your progress to the handoff file and say exactly what is blocking.`;
      try {
        await deps.startTurn(bot.id, prompt, { threadId: contTask.threadId, unattended: true });
        deps.store.appendMessage(event.threadId, {
          role: "bot", kind: "activity",
          tool: { name: `Turn ended without a final answer — work continues in a new task (handoff: ${event.handoffPath})`, ok: true },
          threadRef: { botId: bot.id, threadId: contTask.threadId, title: contTask.title },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[cap-continuation] failed:", msg);
        try {
          deps.store.appendMessage(event.threadId, {
            role: "bot", kind: "activity",
            tool: { name: `Turn ended without a final answer — auto-continuation failed (${String(msg).slice(0, 200)}). Handoff: ${event.handoffPath}. Start a new thread that reads it to continue.`, ok: false },
          });
        } catch { /* the escalation message itself failed; nothing else to do */ }
      }
    })();
  };
}
