// Seeds a fixture data folder for scripts/bench-desktop.ts before its server starts: many bots in departments, two
// threads each, a few unread, and one long conversation of markdown, code, tables, images and tool rows. Runs only in
// a child whose OMB_DATA_DIR and HOME are the fixture's own folder; prints the ids the bench needs as JSON.
//   OMB_DATA_DIR=... node --experimental-strip-types scripts/testing/bench-desktop-seed.ts BOTS THREADS MESSAGES
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = process.env.OMB_DATA_DIR;
if (!dataDir || !dataDir.includes("openmausbot-bench-")) throw new Error("bench-desktop-seed runs only on a bench fixture folder");
const [bots = 150, threads = 300, messages = 2000] = process.argv.slice(2).map(Number);

const { Store } = await import("../../server/store.ts");
const { ATTACHMENTS_DIR } = await import("../../server/attachments.ts");
type Message = import("../../server/store.ts").Message;

const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
const SECTIONS = ["Sales", "Support", "Engineering", "Research", "Operations", "Marketing", "Finance", "People"];
const start = Date.now() - 30 * 24 * 3600_000;
let clock = start;
const tick = (ms = 45_000) => (clock += ms);
let serial = 0;
const id = (prefix: string) => `${prefix}-${(serial += 1).toString(36).padStart(6, "0")}`;

mkdirSync(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });
const image = join(ATTACHMENTS_DIR, "bench-image.png");
copyFileSync(fileURLToPath(new URL("../../public/app-icon-192.png", import.meta.url)), image);

const CODE = Array.from({ length: 18 }, (_, i) => `  const value${i} = await load("item-${i}", { retries: ${i % 3}, timeoutMs: ${(i + 1) * 250} });`).join("\n");
const TABLE = ["| Region | Q1 | Q2 | Q3 | Change |", "|---|---:|---:|---:|---|",
  ...Array.from({ length: 6 }, (_, i) => `| Region ${i + 1} | ${1200 + i * 37} | ${1300 + i * 41} | ${1410 + i * 29} | +${(i * 1.7).toFixed(1)}% |`)].join("\n");
function botText(turn: number): string {
  const parts = [
    `## Update ${turn}`,
    `Here is what I found while looking into **item ${turn}**. The short version: the numbers moved, the [report](https://example.com/report/${turn}) is ready, and two follow-ups need you.`,
    `- First, the \`sync\` job finished in ${turn % 17 + 3} minutes.\n- Second, three records were skipped because their owner was missing.\n- Third, the draft reply is in your inbox.`,
  ];
  if (turn % 4 === 0) parts.push(`\`\`\`ts\nexport async function step${turn}() {\n${CODE}\n  return value0;\n}\n\`\`\``);
  if (turn % 6 === 0) parts.push(TABLE);
  if (turn % 9 === 0) parts.push(`> Note: ${"this paragraph is quoted from the source so you can check it. ".repeat(4)}`);
  parts.push(`Next I will ${turn % 2 ? "check the remaining accounts" : "send the summary"} unless you say otherwise.`);
  return parts.join("\n\n");
}
const TOOLS = ["Bash", "Read", "Grep", "WebFetch", "Edit"];

function conversation(count: number): Message[] {
  const rows: Message[] = [];
  let parentId: string | null = null;
  const push = (message: Omit<Message, "id" | "at" | "parentId">) => {
    const row = { ...message, id: id("m"), at: tick(), parentId } as Message;
    rows.push(row);
    parentId = row.id;
  };
  for (let turn = 1; rows.length < count; turn += 1) {
    const turnId = id("turn");
    push({ role: "user", kind: "text", text: turn % 5 === 0 ? `Can you look at item ${turn}? Also check whether last week's numbers still hold, and draft a reply for the team.` : `Item ${turn} please` });
    for (let call = 0; call < 1 + (turn % 3) && rows.length < count - 1; call += 1) {
      const name = TOOLS[(turn + call) % TOOLS.length]!;
      push({ role: "bot", kind: "activity", turnId, tool: { name, ok: true, summary: `${name} item-${turn}`, input: `{"query":"item-${turn}"}`, output: "ok" } } as Omit<Message, "id" | "at" | "parentId">);
    }
    if (rows.length >= count) break;
    push({
      role: "bot", kind: "text", turnId, text: botText(turn), turnTerminal: true, turnCompletedAt: clock,
      ...(turn % 11 === 0 ? { attachments: [{ kind: "image" as const, path: image, mime: "image/png", name: `chart-${turn}.png` }] } : {}),
    } as Omit<Message, "id" | "at" | "parentId">);
  }
  return rows.slice(0, count);
}

const created: Array<{ id: string; threadId: string; name: string }> = [];
for (let index = 0; index < bots - 1; index += 1) {
  const bot = store.createBot({ name: `Bot ${String(index + 1).padStart(3, "0")}`, section: SECTIONS[index % SECTIONS.length]!, description: `Helps with ${SECTIONS[index % SECTIONS.length]!.toLowerCase()} work.` }, { seedMessages: false });
  created.push({ id: bot.id, threadId: bot.threadId, name: bot.name });
}
const big = store.createBot({ name: "Long Talk", section: SECTIONS[0]!, description: "Holds the long conversation." }, { seedMessages: false });

const extraThreads = Math.max(0, threads - bots);
let otherSideThreadId = "";
for (let index = 0; index < extraThreads; index += 1) {
  const owner = created[index % created.length]!;
  const task = store.createTask(owner.id, `Side thread ${index + 1}`, false);
  if (!task) continue;
  if (index === 0) otherSideThreadId = task.threadId;
  const rows = conversation(3);
  store.importTranscript(task.threadId, rows, rows.at(-1)!.id);
}
for (const [index, bot] of created.entries()) {
  const rows = conversation(3);
  store.importTranscript(bot.threadId, rows, rows.at(-1)!.id);
  if (index % 15 === 0) store.patchTask(bot.id, bot.threadId, { unread: true });
}
const longRows = conversation(messages);
store.importTranscript(big.threadId, longRows, longRows.at(-1)!.id);

process.stdout.write(`${JSON.stringify({
  bigBotId: big.id,
  bigThreadId: big.threadId,
  bigLastMessageId: longRows.at(-1)!.id,
  bigMessages: longRows.length,
  otherBotId: created[0]!.id,
  otherThreadId: created[0]!.threadId,
  otherSideThreadId,
  bots: store.bots.length,
  threads: store.bots.reduce((sum, bot) => sum + (bot.tasks?.length ?? 0), 0),
  unread: store.bots.filter((bot) => bot.tasks?.some((task) => task.unread)).length,
})}\n`);
