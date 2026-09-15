// Harness scorecard: a fixed set of small tasks a person can run by hand
// against any OpenMausBot harness (docs/verification/harness-scorecard.md),
// and this script runs the same set unattended so two builds can be
// compared by their numbers. It drives only routes every build has
// (bots, messages, tasks) and reads the usage ledger the harness writes on
// disk, so it works on main and on every phase branch alike.
//
//   node --experimental-strip-types scripts/bench/scorecard.ts \
//     --url http://127.0.0.1:PORT --data-dir DIR --label phase0 \
//     [--engine claude] [--switch-to codex] [--out FILE.json]
//
// Point it at a harness started standalone (`OMB_DATA_DIR=DIR OMB_PORT=PORT
// node --experimental-strip-types server/index.ts`): the packaged desktop
// app refuses scripted sends by design.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Args { url: string; dataDir: string; label: string; engine: string; switchTo?: string; out?: string }

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = { engine: "claude", label: "run" };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--url": a.url = v!.replace(/\/+$/, ""); i += 1; break;
      case "--data-dir": a.dataDir = v!; i += 1; break;
      case "--label": a.label = v!; i += 1; break;
      case "--engine": a.engine = v!; i += 1; break;
      case "--switch-to": a.switchTo = v!; i += 1; break;
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

interface TurnResult {
  task: string;
  turn: number;
  engine: string;
  prompt: string;
  reply: string;
  correct: boolean | null;
  wallMs: number;
  steps: number;
  input: number | null;
  output: number | null;
  cachedInput: number | null;
  costUsd: number | null;
  /** Phase 0 rows only; null on builds that do not record them. */
  durationMs: number | null;
  hookCoverage: string | null;
  replayed: boolean | null;
  stableChanged: string[] | null;
}

const results: TurnResult[] = [];

async function bot(name: string, instanceId: string) {
  const created = (await api("POST", "/api/bots", { name })).bot;
  const catalog = (await api("GET", "/api/instances")).instances.find((i: any) => i.instanceId === instanceId);
  if (!catalog) throw new Error(`no engine ${instanceId}`);
  const model = catalog.models?.default;
  // Auto approval, the way a person testing by hand would set the bot up;
  // a card the engine still raises is answered "allow" below, like a click.
  await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId, model }, approvalMode: "auto", acknowledgeLocalAuto: true });
  return { id: created.id as string, threadId: created.threadId as string, model: model as string };
}

function ledgerRow(threadId: string, since: number): any | null {
  const now = new Date();
  const file = join(args.dataDir, "usage", `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
  if (!existsSync(file)) return null;
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return rows.filter((r) => r.threadId === threadId && Date.parse(r.at) >= since - 1_000).at(-1) ?? null;
}

async function turn(task: string, n: number, b: { id: string; threadId: string }, engine: string, prompt: string, check?: (reply: string) => boolean): Promise<TurnResult> {
  const before = (await api("GET", "/api/bots?messages=200")).bots.find((x: any) => x.id === b.id);
  const seen = new Set((before.messages ?? []).map((m: any) => m.id));
  const answered = new Set<string>();
  const started = Date.now();
  await api("POST", `/api/bots/${b.id}/messages`, { text: prompt, threadId: b.threadId });
  let current: any;
  for (;;) {
    current = (await api("GET", "/api/bots?messages=200")).bots.find((x: any) => x.id === b.id);
    const fresh = (current.messages ?? []).filter((m: any) => !seen.has(m.id));
    const replied = fresh.some((m: any) => m.role === "bot" && m.kind === "text" && m.text);
    if (!current.busy && replied) break;
    // an approval card is what a person would click Allow on; do the same
    for (const m of fresh) {
      const card = m.card;
      if (m.kind === "options" && card?.requestId && !card.answered && !answered.has(card.requestId)) {
        answered.add(card.requestId);
        await api("POST", `/api/bots/${b.id}/respond`, { threadId: b.threadId, requestId: card.requestId, behavior: "allow" }).catch(() => {});
      }
    }
    if (Date.now() - started > 300_000) throw new Error(`${task} turn ${n}: no reply within 5 minutes`);
    await new Promise((r) => setTimeout(r, 750));
  }
  const wallMs = Date.now() - started;
  const fresh = (current.messages ?? []).filter((m: any) => !seen.has(m.id));
  const reply = fresh.filter((m: any) => m.role === "bot" && m.kind === "text" && m.text).map((m: any) => m.text).join("\n").trim();
  const steps = fresh.filter((m: any) => m.kind === "activity" && m.tool).length;
  let row: any = null;
  for (let i = 0; i < 20 && !row; i += 1) {
    row = ledgerRow(b.threadId, started);
    if (!row) await new Promise((r) => setTimeout(r, 500));
  }
  const result: TurnResult = {
    task, turn: n, engine, prompt, reply: reply.slice(0, 200), correct: check ? check(reply) : null, wallMs, steps,
    input: row?.input ?? null, output: row?.output ?? null, cachedInput: row?.cachedInput ?? null, costUsd: row?.costUsd ?? null,
    durationMs: row?.durationMs ?? null, hookCoverage: row?.hookCoverage ?? null,
    replayed: row?.promptShape?.replayed ?? null, stableChanged: row?.promptShape?.stableChanged ?? null,
  };
  results.push(result);
  process.stderr.write(`${args.label} ${task} #${n} ${engine}: ${wallMs} ms, in ${result.input} out ${result.output} cached ${result.cachedInput}, steps ${steps}${result.correct === null ? "" : result.correct ? ", correct" : ", WRONG"}\n`);
  return result;
}

const has = (needle: string) => (reply: string) => reply.toLowerCase().includes(needle);

async function main() {
  const engine = args.engine;
  // T1 — one turn that writes a file and runs a command (tool use, evidence)
  const t1 = await bot(`Score T1 ${args.label}`, engine);
  await turn("T1 file-task", 1, t1, engine,
    "Create a file called scorecard.txt in your working folder containing exactly three lines: alpha, beta, gamma. Then list the folder with ls. Reply in one short sentence.",
    has("scorecard"));
  // T2 — three short follow-ups on one thread (warm thread: cache, latency, process reuse)
  const t2 = await bot(`Score T2 ${args.label}`, engine);
  await turn("T2 follow-ups", 1, t2, engine, "What is 17 + 25? Reply with the number only.", has("42"));
  await turn("T2 follow-ups", 2, t2, engine, "Add 10 to that. Reply with the number only.", has("52"));
  await turn("T2 follow-ups", 3, t2, engine, "Subtract 2 from that. Reply with the number only.", has("50"));
  // T3 — a big tool result (200 lines) the harness has to carry
  const t3 = await bot(`Score T3 ${args.label}`, engine);
  await turn("T3 big-output", 1, t3, engine,
    "Using one shell loop, write a file named log.txt with 200 lines of the form 'line N' (N from 1 to 200). Then print the whole file with cat. Then tell me how many lines it has, in one short sentence.",
    has("200"));
  // T4 — a different engine takes over T1's thread and must know what happened
  if (args.switchTo) {
    const catalog = (await api("GET", "/api/instances")).instances.find((i: any) => i.instanceId === args.switchTo);
    await api("PATCH", `/api/bots/${t1.id}/tasks/${t1.threadId}`, { modelSelection: { instanceId: args.switchTo, model: catalog.models?.default } });
    await turn("T4 engine-switch", 1, t1, args.switchTo,
      "Which file did you create earlier in this conversation, and what were its three lines? Answer in one short sentence without running any tools.",
      has("alpha"));
  }
  const out = { label: args.label, url: args.url, at: new Date().toISOString(), engine, switchTo: args.switchTo ?? null, results };
  if (args.out) writeFileSync(args.out, JSON.stringify(out, null, 2));
  const fmt = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-US"));
  console.log(`\n${args.label} (${engine}${args.switchTo ? ` → ${args.switchTo}` : ""})`);
  console.log("| Task | Turn | Engine | Wall s | In | Out | Cached | Cost $ | Steps | Correct | Evidence |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    console.log(`| ${r.task} | ${r.turn} | ${r.engine} | ${(r.wallMs / 1000).toFixed(1)} | ${fmt(r.input)} | ${fmt(r.output)} | ${fmt(r.cachedInput)} | ${r.costUsd === null ? "—" : r.costUsd.toFixed(3)} | ${r.steps} | ${r.correct === null ? "—" : r.correct ? "yes" : "no"} | ${r.hookCoverage ?? "—"} |`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
