/**
 * Musterd → Kepler outbound notify.
 * Kepler cannot receive session_send from outside its process; this writes a durable
 * handoff file (and optional task-note drop) that a Kepler session can poll via inbox/notes.
 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface KeplerNotifyInput {
  botId: string;
  botName?: string;
  threadId: string;
  summary: string;
  urgency?: "low" | "normal" | "high";
  refs?: string[];
}

export interface KeplerNotifyResult {
  id: string;
  path: string;
  taskId: string | null;
}

function keplerDropDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MUSTERD_KEPLER_DROP_DIR?.trim();
  if (explicit) return explicit;
  const data = env.MUSTERD_DATA_DIR?.trim() || env.OMB_DATA_DIR?.trim() || join(homedir(), ".musterd");
  return join(data, "peers", "kepler");
}

/** Append one handoff for Kepler to pick up (`MUSTERD_KEPLER_TASK_ID` tags the owning Kepler task). */
export function keplerNotify(input: KeplerNotifyInput, env: NodeJS.ProcessEnv = process.env): KeplerNotifyResult {
  const summary = input.summary.trim();
  if (!summary) throw new Error("kepler_notify requires a non-empty summary");
  if (!input.botId.trim() || !input.threadId.trim()) throw new Error("kepler_notify requires botId and threadId");

  const dir = keplerDropDir(env);
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const taskId = env.MUSTERD_KEPLER_TASK_ID?.trim() || null;
  const payload = {
    id,
    at: new Date().toISOString(),
    taskId,
    botId: input.botId,
    botName: input.botName ?? null,
    threadId: input.threadId,
    summary,
    urgency: input.urgency ?? "normal",
    refs: input.refs ?? [],
  };
  const path = join(dir, `${id}.json`);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const inbox = join(dir, "inbox.jsonl");
  appendFileSync(inbox, `${JSON.stringify(payload)}\n`, "utf8");

  if (taskId) {
    const notesDir = join(dir, "task-notes");
    mkdirSync(notesDir, { recursive: true });
    const notePath = join(notesDir, `${taskId.replace(/[^a-zA-Z0-9:_-]/g, "_")}.md`);
    const block = `\n## ${payload.at} · ${input.botName || input.botId}\n\n${summary}\n\n- thread: \`${input.threadId}\`\n- notify: \`${id}\`\n${(input.refs ?? []).map((r) => `- ref: ${r}`).join("\n")}\n`;
    if (!existsSync(notePath)) writeFileSync(notePath, `# Kepler handoffs · ${taskId}\n${block}`, "utf8");
    else appendFileSync(notePath, block, "utf8");
  }

  return { id, path, taskId };
}

/** Newest N inbox lines (oldest first). */
export function readKeplerInbox(limit = 20, env: NodeJS.ProcessEnv = process.env): unknown[] {
  const inbox = join(keplerDropDir(env), "inbox.jsonl");
  if (!existsSync(inbox)) return [];
  const lines = readFileSync(inbox, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.slice(-Math.max(1, Math.min(limit, 100))).map((line) => {
    try { return JSON.parse(line); } catch { return { raw: line }; }
  });
}
