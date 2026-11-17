import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function handoffDir(): string {
  return resolve(process.env.OMB_DATA_DIR || join(homedir(), ".openmausbot"), "handoffs");
}

export interface HandoffInput {
  threadId: string;
  turnId: string;
  model?: string;
  usage?: { input: number; output: number };
  hasUsage?: boolean;
  failure?: string;
  toolCalls: number;
  task: string;
  updates?: string[];
  messages: Array<{
    role: string;
    content?: unknown;
    tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  }>;
}

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
    L.push("## Current task", "```", input.task.slice(0, 8000), "```", "");
    if (input.updates?.length) {
      L.push("## Updates delivered during this turn (in order)", "");
      for (const update of input.updates) L.push("```", update.slice(0, 8000), "```", "");
    }
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
        try { verdict = JSON.parse(String(m.content)).ok ? "ok" : "FAILED"; } catch {}
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

/** Matched from the start of the failure, so a provider's error text ("HTTP 429: Rate limit reached") never reads as a spent budget. */
const CAP_STOP = /^(?:stopped after \d+ [a-z ]+ without a final answer|model-call limit reached)/i;

/** Only a spent budget continues: a provider error would fail the same way again, and a denied tool would be retried unattended. */
export function classifyContinuable(_stopReason: string | null | undefined, failure: string | undefined): "cap" | null {
  return failure && CAP_STOP.test(failure) ? "cap" : null;
}
