// The memory recall set (docs/bench/recall-set.json; gap analysis §11b,
// Phase 1 part 2): does a bot use what it was told or kept, in a NEW task,
// without tools? Runs every case against a harness started standalone
// (the packaged app refuses scripted sends) and prints pass/fail per case
// with the harness's recall counts from the usage ledger, so main and a
// branch can be compared by the same numbers.
//
//   node --experimental-strip-types scripts/bench/recall-set.ts \
//     --url http://127.0.0.1:PORT --data-dir DIR --label branch \
//     [--engine claude] [--set docs/bench/recall-set.json] [--only id,id] [--out FILE.json]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Args { url: string; dataDir: string; label: string; engine: string; set: string; only?: Set<string>; out?: string }
interface Case { id: string; kind: string; say?: string[]; memory?: string; topics?: Record<string, string>; log?: string; ask: string; expect: string; reject?: string }

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = { engine: "claude", label: "run", set: "docs/bench/recall-set.json" };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--url": a.url = v!.replace(/\/+$/, ""); i += 1; break;
      case "--data-dir": a.dataDir = v!; i += 1; break;
      case "--label": a.label = v!; i += 1; break;
      case "--engine": a.engine = v!; i += 1; break;
      case "--set": a.set = v!; i += 1; break;
      case "--only": a.only = new Set(v!.split(",")); i += 1; break;
      case "--out": a.out = v!; i += 1; break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (!a.url || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(a.url)) throw new Error("--url must be an explicit loopback harness URL");
  if (!a.dataDir) throw new Error("--data-dir is required (the harness's OMB_DATA_DIR)");
  return a as Args;
}

const args = parseArgs(process.argv.slice(2));
const api = async (method: string, path: string, body?: unknown): Promise<any> => {
  const res = await fetch(`${args.url}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}${json?.error ? `: ${json.error}` : ""}`);
  return json;
};

async function bot(name: string) {
  const created = (await api("POST", "/api/bots", { name })).bot;
  const catalog = (await api("GET", "/api/instances")).instances.find((i: any) => i.instanceId === args.engine);
  if (!catalog) throw new Error(`no engine ${args.engine}`);
  await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: args.engine, model: catalog.models?.default }, approvalMode: "auto", acknowledgeLocalAuto: true });
  return { id: created.id as string, threadId: created.threadId as string };
}

function ledgerRow(threadId: string, since: number): any | null {
  const now = new Date();
  const file = join(args.dataDir, "usage", `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
  if (!existsSync(file)) return null;
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return rows.filter((r) => r.threadId === threadId && r.trigger?.kind !== "harness" && Date.parse(r.at) >= since - 1_000).at(-1) ?? null;
}

async function turn(b: { id: string; threadId: string }, prompt: string): Promise<{ reply: string; steps: number; wallMs: number; row: any }> {
  const before = (await api("GET", "/api/bots?messages=200")).bots.find((x: any) => x.id === b.id);
  const seen = new Set((before.messages ?? []).map((m: any) => m.id));
  const answered = new Set<string>();
  const started = Date.now();
  await api("POST", `/api/bots/${b.id}/messages`, { text: prompt, threadId: b.threadId });
  let current: any;
  for (;;) {
    current = (await api("GET", "/api/bots?messages=200")).bots.find((x: any) => x.id === b.id);
    const fresh = (current.messages ?? []).filter((m: any) => !seen.has(m.id));
    if (!current.busy && fresh.some((m: any) => m.role === "bot" && m.kind === "text" && m.text)) break;
    for (const m of fresh) {
      const card = m.card;
      if (m.kind === "options" && card?.requestId && !card.answered && !answered.has(card.requestId)) {
        answered.add(card.requestId);
        await api("POST", `/api/bots/${b.id}/respond`, { threadId: b.threadId, requestId: card.requestId, behavior: "allow" }).catch(() => {});
      }
    }
    if (Date.now() - started > 300_000) throw new Error(`no reply within 5 minutes to: ${prompt}`);
    await new Promise((r) => setTimeout(r, 750));
  }
  const fresh = (current.messages ?? []).filter((m: any) => !seen.has(m.id));
  const reply = fresh.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text).map((m: any) => m.text).join("\n").trim();
  const steps = fresh.filter((m: any) => m.kind === "activity" && m.tool && !String(m.tool.name).startsWith("recalled ")).length;
  let row: any = null;
  for (let i = 0; i < 20 && !row; i += 1) {
    row = ledgerRow(b.threadId, started);
    if (!row) await new Promise((r) => setTimeout(r, 500));
  }
  return { reply, steps, wallMs: Date.now() - started, row };
}

function seedFiles(botId: string, c: Case) {
  const dir = join(args.dataDir, "workspaces", botId);
  mkdirSync(join(dir, "memory", "log"), { recursive: true });
  if (c.memory) writeFileSync(join(dir, "MEMORY.md"), c.memory);
  for (const [name, text] of Object.entries(c.topics ?? {})) writeFileSync(join(dir, "memory", name), text);
  if (c.log) writeFileSync(join(dir, "memory", "log", `${new Date().toISOString().slice(0, 10)}.md`), c.log);
}

interface Result { id: string; kind: string; pass: boolean; reply: string; steps: number; wallMs: number; input: number | null; recall: any }

async function main() {
  const set = JSON.parse(readFileSync(args.set, "utf8")) as { cases: Case[] };
  const cases = set.cases.filter((c) => !args.only || args.only.has(c.id));
  const results: Result[] = [];
  for (const c of cases) {
    const b = await bot(`Recall ${c.id} ${args.label}`);
    seedFiles(b.id, c);
    for (const say of c.say ?? []) await turn(b, say);
    const opened = (await api("POST", `/api/bots/${b.id}/tasks`, { title: `Ask ${c.id}` })).task;
    const asked = await turn({ id: b.id, threadId: opened.threadId }, c.ask);
    const pass = new RegExp(c.expect, "i").test(asked.reply) && !(c.reject && new RegExp(c.reject, "i").test(asked.reply));
    const result: Result = { id: c.id, kind: c.kind, pass, reply: asked.reply.slice(0, 160).replace(/\s+/g, " "), steps: asked.steps, wallMs: asked.wallMs, input: asked.row?.input ?? null, recall: asked.row?.recall ?? null };
    results.push(result);
    process.stderr.write(`${args.label} ${c.id}: ${pass ? "PASS" : "FAIL"} (${(asked.wallMs / 1000).toFixed(1)} s, steps ${asked.steps}, recall ${result.recall ? `${result.recall.notes}n/${result.recall.conversations}c/${result.recall.captures}x${result.recall.used ? ` used ${result.recall.used}` : ""}` : "—"}) ${result.reply}\n`);
  }
  const out = { label: args.label, url: args.url, at: new Date().toISOString(), engine: args.engine, results };
  if (args.out) writeFileSync(args.out, JSON.stringify(out, null, 2));
  console.log(`\n${args.label} (${args.engine}) — recall set`);
  console.log("| Case | Kind | Pass | Wall s | In | Steps | Recalled | Used | Reply |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    const recalled = r.recall ? `${r.recall.notes}n ${r.recall.conversations}c ${r.recall.captures}x` : "—";
    console.log(`| ${r.id} | ${r.kind} | ${r.pass ? "yes" : "NO"} | ${(r.wallMs / 1000).toFixed(1)} | ${r.input === null ? "—" : r.input.toLocaleString("en-US")} | ${r.steps} | ${recalled} | ${r.recall?.used ?? "—"} | ${r.reply.slice(0, 60)} |`);
  }
  const byKind = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const k = byKind.get(r.kind) ?? { pass: 0, total: 0 };
    k.total += 1; if (r.pass) k.pass += 1; byKind.set(r.kind, k);
  }
  console.log(`\npassed ${results.filter((r) => r.pass).length}/${results.length}; by kind: ${[...byKind].map(([k, v]) => `${k} ${v.pass}/${v.total}`).join(", ")}; asking turns with tools ${results.filter((r) => r.steps > 0).length}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
