// Synthetic bots and threads only, in OMB_DATA_DIR, which must be set to an empty temporary folder before this starts.
// Counts how many bots each save of bots.json serializes, and what one setting save and a round of turns write, for the
// checkout at <repo>, so two checkouts can be compared with the same script:
//   OMB_DATA_DIR=$(mktemp -d) node --experimental-strip-types scripts/bench-bots-serialize.ts <repo> 200x200
import { randomUUID } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (!process.env.OMB_DATA_DIR) throw new Error("Set OMB_DATA_DIR to an empty temporary folder first: the store saves there.");
const [repo, shape] = process.argv.slice(2) as [string, string];
const [nBots, nThreads] = shape.split("x").map(Number) as [number, number];
const { Store } = await import(join(repo, "server/store.ts"));
const batch = await import(join(repo, "server/save-batch.ts"));
const selection = () => ({ instanceId: "claude", model: "synthetic" });
const seed = new Store(selection);
const first = seed.createBot({ name: "Bench 0" }, { seedMessages: false });
const file = join(process.env.OMB_DATA_DIR!, "bots.json");
const template = JSON.parse(JSON.stringify(seed.bot(first.id)));
const rows = Array.from({ length: nBots }, (_, b) => ({ ...template, id: randomUUID(), threadId: `thread-${b}-0`, name: `Bench ${b}`,
  tasks: Array.from({ length: nThreads }, (_, t) => ({ ...template.tasks[0], id: randomUUID(), threadId: `thread-${b}-${t}`,
    title: `Synthetic thread ${t} with a title of ordinary length`, resumeCursors: { claude: { sessionId: randomUUID() } },
    usage: { input: 120_000 + t, output: 4_000 + t, cachedInput: 90_000, costUsd: null, turns: 12, lastTurn: { input: 900, output: 80, costUsd: null } } })) }));
writeFileSync(file, JSON.stringify(rows));
const store = new Store(selection);
const ids = new Set(rows.map((r) => r.id));
let serialized = 0;
const real = JSON.stringify;
JSON.stringify = function (value: unknown, ...rest: unknown[]) {
  if (Array.isArray(value)) { for (const v of value) if (v && typeof v === "object" && ids.has((v as { id: string }).id)) serialized++; }
  else if (value && typeof value === "object" && ids.has((value as { id: string }).id) && "soul" in (value as object)) serialized++;
  return (real as (...a: unknown[]) => string)(value, ...rest);
} as typeof JSON.stringify;
let writes = 0, bytes = 0, inode = statSync(file).ino;
const counted = () => { const s = statSync(file); if (s.ino !== inode) { writes++; bytes += s.size; inode = s.ino; } };
store.patchBot(rows[0]!.id, { title: "warm" }); counted();
const ms: number[] = []; let ser = 0; writes = 0; bytes = 0;
for (let i = 0; i < 9; i++) { serialized = 0; const a = performance.now(); store.patchBot(rows[i % nBots]!.id, { title: `Durable change ${i}` }); ms.push(performance.now() - a); ser += serialized; counted(); }
const oneSetting = { medianMs: Number(ms.sort((a, b) => a - b)[4]!.toFixed(1)), botsSerializedPerSave: ser / 9, bytesWrittenPerSave: Math.round(bytes / writes) };
const TURNS = 34;
const oneTurn = (turn: number) => {
  const botId = rows[turn % nBots]!.id, threadId = `thread-${turn % nBots}-1`;
  batch.batchSaves(() => { store.setTaskAskedAt(botId, threadId, Date.now()); store.patchTask(botId, threadId, { unread: false }); }); counted();
  store.markTaskDispatched(botId, threadId, "claude"); counted();
  store.setHandedMessages(botId, threadId, "claude", { session: { sessionId: `session-${turn % nBots}` }, lastMessageId: `m-${turn}-${Date.now()}` }); counted();
  batch.batchSaves(() => store.setResumeCursor(botId, "claude", { sessionId: `session-${turn % nBots}` }, threadId)); counted();
  batch.batchSaves(() => { store.addTaskUsage(botId, threadId, { input: 900, output: 80, costUsd: null }); store.patchTask(botId, threadId, { lastContextModel: "claude:synthetic" }); store.patchTask(botId, threadId, { unread: true }, { turnEnd: true }); }); counted();
};
for (let t = 0; t < TURNS; t++) oneTurn(t);
batch.flushLaterSaves(); counted();
writes = 0; bytes = 0; serialized = 0;
let busy = 0;
const start = performance.now();
for (let t = 0; t < TURNS; t++) { const a = performance.now(); oneTurn(t); busy += performance.now() - a; await new Promise((r) => setImmediate(r)); counted(); }
await new Promise((r) => setTimeout(r, 1200)); counted();
const b0 = performance.now(); batch.flushLaterSaves(); busy += performance.now() - b0; counted();
console.log(real({ shape, botsJsonMb: Number((statSync(file).size / 1e6).toFixed(1)), oneSetting,
  round: { turns: TURNS, wholeFileWrites: writes, writesPerTurn: Number((writes / TURNS).toFixed(2)), botsSerialized: serialized, botsSerializedPerTurn: Number((serialized / TURNS).toFixed(1)), mbWritten: Number((bytes / 1e6).toFixed(1)), blockedMs: Math.round(busy), wallMs: Math.round(performance.now() - start) } }));
