// Synthetic local data only. Never import config before isolating data.
//   node --experimental-strip-types scripts/bench-today.ts [messages=50000] [days=30]
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const directory = mkdtempSync(join(tmpdir(), "omb-today-bench-"));
process.env.HOME = directory;
process.env.USERPROFILE = directory;
process.env.OMB_DATA_DIR = join(directory, "data");
const messageDb = await import("../server/message-db.ts");
const { todayReport } = await import("../server/today.ts");

const total = Number(process.argv[2] ?? 50_000);
const days = Number(process.argv[3] ?? 30);
const now = Date.now();
const start = now - days * 86_400_000;
const pad = (n: number) => "x".repeat(n);
const tools = ["Bash", "Read", "Edit", "WebSearch", "mcp__composio__GMAIL_FETCH_EMAILS", "mcp__composio__GMAIL_SEND_EMAIL",
  "mcp__composio__GMAIL_CREATE_EMAIL_DRAFT", "mcp__composio__SLACK_SEND_MESSAGE", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", "mcp__composio__NOTION_CREATE_PAGE"];
const bots = Array.from({ length: 12 }, (_, i) => ({ id: `bot-${i}`, threadId: `main-${i}`, tasks: [] as Array<{ threadId: string }>, modelSelection: { instanceId: i % 2 ? "codex" : "claude" } }));
const threads = new Map<string, Array<Record<string, unknown>>>();
let seeded = 0;
for (let turn = 0; seeded < total; turn++) {
  const bot = bots[turn % bots.length]!;
  const threadId = turn % 3 === 0 ? `task-${turn}` : bot.threadId;
  if (threadId !== bot.threadId) bot.tasks.push({ threadId });
  const at = start + Math.floor((((turn * 7919) % 1_000_003) / 1_000_003) * (now - start));
  const turnId = `turn-${turn}`;
  const rows: Array<Record<string, unknown>> = [{ id: `u-${turn}`, role: "user", kind: "text", text: `Handle the inbox ${pad(150)}`, at }];
  const calls = 3 + (turn % 5);
  for (let j = 0; j < calls; j++) {
    const name = tools[(turn + j) % tools.length]!;
    const ok = (turn + j) % 17 !== 0;
    const input = name.includes("MULTI") ? JSON.stringify({ tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { q: pad(200) } }, { tool_slug: "SLACK_SEND_MESSAGE", arguments: { text: pad(300) } }] }, null, 2)
      : JSON.stringify({ command: pad(600) });
    rows.push({ id: `a-${turn}-${j}`, role: "bot", kind: "activity", at: at + 1_000 * (j + 1), turnId, tool: { name, ok, input, output: ok ? pad(1_800) : `Error: 401 Unauthorized ${pad(200)}`, itemId: `i-${turn}-${j}` } });
  }
  if (turn % 40 === 0) rows.push({ id: `e-${turn}`, role: "bot", kind: "activity", at: at + 1_000 * (calls + 1), turnSucceeded: false, tool: { name: "error: You've hit your usage limit. Try again at 3pm.", ok: false } });
  if (turn % 50 === 0) rows.push({ id: `o-${turn}`, role: "bot", kind: "options", at: at + 1_000 * (calls + 2), card: { title: "Which list?", subtitle: "", options: ["A", "B"], requestType: "question", requestId: `q-${turn}` } });
  rows.push({ id: `t-${turn}`, role: "bot", kind: "text", text: `Done. ${pad(700)}`, at: at + 1_000 * (calls + 3), turnId, turnTerminal: true, turnSucceeded: true });
  rows.push({ id: `d-${turn}`, role: "bot", kind: "digest", at: at + 1_000 * (calls + 4), turnId, turnSucceeded: turn % 40 !== 0, requestMessageId: `u-${turn}`, text: pad(300),
    digest: { turnId, botId: bot.id, threadId, at: at + 1_000 * (calls + 4), durationMs: 9_000, tools: [], memory: [], reply: "Handled the inbox and sent two replies.", hookCoverage: "preview" } });
  threads.set(threadId, [...(threads.get(threadId) ?? []), ...rows]);
  seeded += rows.length;
}
try {
  for (const [threadId, messages] of threads) messageDb.importThread(threadId, messages as never, String(messages.at(-1)?.id ?? ""));
  const raw = new DatabaseSync(join(process.env.OMB_DATA_DIR, "messages.db"));
  console.log(JSON.stringify({ bytes: (raw.prepare("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()").get() as { bytes: number }).bytes }));
  const sources = { bots, groups: [], routines: null, engines: [], parked: [] };
  const viewer = { admin: true, thread: () => true, routine: () => true };
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const week = new Date(midnight);
  week.setDate(week.getDate() - 6);
  const measure = (label: string, since: number) => {
    todayReport(sources, viewer, since, now);
    const samples: number[] = [];
    for (let i = 0; i < 15; i++) {
      const at = performance.now();
      todayReport(sources, viewer, since, now);
      samples.push(performance.now() - at);
    }
    samples.sort((a, b) => a - b);
    console.log(JSON.stringify({ label, messages: seeded, medianMs: Number(samples[7]!.toFixed(1)), maxMs: Number(samples.at(-1)!.toFixed(1)) }));
  };
  measure("today", midnight.getTime());
  measure("last 7 days", week.getTime());
  raw.close();
} finally {
  messageDb.closeMessageDb();
  rmSync(directory, { recursive: true, force: true });
}
