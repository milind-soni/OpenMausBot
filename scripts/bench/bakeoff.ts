// The engine bake-off (Phase 3 part 5): the same tasks through N bots that
// differ only in engine, filed on the board so every run gets the harness's
// own gates and verifier, scored on tokens, cost, wall time, correctness,
// human interventions, policy denials and judge quality, averaged over
// trials. Prints one markdown table and, with --out, writes it.
//
//   node --experimental-strip-types scripts/bench/bakeoff.ts --url http://127.0.0.1:PORT --data-dir DIR \
//     --engines claude,codex [--trials 2] [--out docs/bench/scorecard/DATE-bakeoff.md]
//
// The harness must run with features.board on; bots are created on Auto.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Args { url: string; dataDir: string; engines: string[]; trials: number; out?: string; label: string }
function parseArgs(argv: string[]): Args {
  const a: Args = { url: "http://127.0.0.1:8799", dataDir: "", engines: ["claude"], trials: 1, label: "bakeoff" };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--url": a.url = v!; i += 1; break;
      case "--data-dir": a.dataDir = v!; i += 1; break;
      case "--engines": a.engines = v!.split(",").map((s) => s.trim()).filter(Boolean); i += 1; break;
      case "--trials": a.trials = Math.max(1, Number(v)); i += 1; break;
      case "--out": a.out = v!; i += 1; break;
      case "--label": a.label = v!; i += 1; break;
    }
  }
  if (!a.dataDir) throw new Error("--data-dir is required (the harness's data folder, for the usage ledger)");
  return a;
}
const args = parseArgs(process.argv.slice(2));

const api = async (method: string, path: string, body?: unknown): Promise<any> => {
  const res = await fetch(`${args.url}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json?.error ?? ""}`);
  return json;
};

interface Task { key: string; title: string; body: string; check: (ctx: { result: string; botSaid: string; cwd: string }) => boolean }
const TASKS: Task[] = [
  {
    key: "file",
    title: "Write hello.txt",
    body: "Create a file named hello.txt in your working folder containing exactly the two words: hello world",
    check: ({ cwd }) => existsSync(join(cwd, "hello.txt")) && readFileSync(join(cwd, "hello.txt"), "utf8").trim() === "hello world",
  },
  {
    key: "arith",
    title: "Multiply",
    body: "What is 17 times 23? Reply with the number only.",
    check: ({ botSaid, result }) => /\b391\b/.test(botSaid) || /\b391\b/.test(result),
  },
  {
    key: "tool",
    title: "Count the board",
    body: "Using your tools, count how many tasks are on the board in any status and reply with just that number.",
    check: ({ botSaid }) => /\b[1-9]\d*\b/.test(botSaid),
  },
];

interface Score {
  engine: string; model: string; task: string; trial: number;
  correct: boolean; judged: boolean | null; confidence: number | null; attempts: number;
  input: number; output: number; costUsd: number; wallMs: number; interventions: number; denials: number;
}
const scores: Score[] = [];

function ledgerRows(threadId: string): any[] {
  const now = new Date();
  const file = join(args.dataDir, "usage", `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.threadId === threadId && r.trigger?.kind !== "harness");
}

async function makeBot(engine: string, trial: number) {
  const catalog = (await api("GET", "/api/instances")).instances.find((i: any) => i.instanceId === engine);
  if (!catalog) throw new Error(`no engine ${engine}`);
  const model = catalog.models?.default as string;
  const cwd = mkdtempSync(join(tmpdir(), `omb-bakeoff-${engine}-`));
  mkdirSync(cwd, { recursive: true });
  const created = (await api("POST", "/api/bots", { name: `${engine} ${trial}` })).bot;
  await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: engine, model }, approvalMode: "auto", acknowledgeLocalAuto: true, cwd });
  return { id: created.id as string, model, cwd };
}

const taskById = async (id: string) => ((await api("GET", "/api/tasks")).tasks as any[]).find((t) => t.id === id);

async function runTask(engine: string, trial: number, bot: { id: string; model: string; cwd: string }, task: Task): Promise<void> {
  const filed = (await api("POST", "/api/tasks", { title: `${task.title} (${engine} ${trial})`, body: task.body, assigneeBotId: bot.id })).task;
  const started = Date.now();
  await api("PATCH", `/api/tasks/${filed.id}`, { status: "ready" });
  const deadline = Date.now() + 15 * 60_000;
  let t: any;
  let reviewedAt = 0;
  for (;;) {
    t = await taskById(filed.id);
    if (t.status === "review" && !reviewedAt) reviewedAt = Date.now();
    // settled: a verdict landed, or the task sat in review for a minute
    // without one (an engine with no one-shot call is never judged)
    const settled = (t.status === "review" && (t.verdict || Date.now() - reviewedAt > 60_000)) || t.status === "blocked" || t.status === "done";
    if (settled) break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  const wallMs = Date.now() - started;
  const messages = t.threadId ? ((await api("GET", `/api/threads/${t.threadId}/messages?limit=200`)).messages as any[]) : [];
  const botSaid = messages.filter((m) => m.role === "bot" && m.kind === "text" && m.text).map((m) => m.text).join("\n");
  const interventions = messages.filter((m) => m.kind === "options" && m.card && !m.card.fixedOptions).length;
  const rows = t.threadId ? ledgerRows(t.threadId) : [];
  const denials = rows.reduce((n, r) => n + (Array.isArray(r.denials) ? r.denials.length : 0), 0);
  const score: Score = {
    engine, model: bot.model, task: task.key, trial,
    correct: task.check({ result: String(t.result ?? ""), botSaid, cwd: bot.cwd }),
    judged: t.verdict ? Boolean(t.verdict.isComplete) : null,
    confidence: t.verdict ? Number(t.verdict.confidence) : null,
    attempts: Number(t.attempts ?? 0),
    input: rows.reduce((n, r) => n + (r.input ?? 0), 0),
    output: rows.reduce((n, r) => n + (r.output ?? 0), 0),
    costUsd: rows.reduce((n, r) => n + (r.costUsd ?? 0), 0),
    wallMs, interventions, denials,
  };
  scores.push(score);
  process.stderr.write(`${args.label} ${engine}#${trial} ${task.key}: ${t.status} attempts ${score.attempts} correct ${score.correct} judged ${score.judged} in ${score.input} out ${score.output} $${score.costUsd.toFixed(4)} ${wallMs} ms cards ${interventions}\n`);
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (xs: boolean[]) => (xs.length ? `${Math.round((xs.filter(Boolean).length / xs.length) * 100)}%` : "—");

function report(): string {
  const lines: string[] = [];
  lines.push(`# Engine bake-off — ${args.label} (${new Date().toISOString().slice(0, 10)})`, "");
  lines.push(`Same ${TASKS.length} tasks × ${args.trials} trial(s) per engine, filed on the board on bots that differ only in engine; every run judged by the harness's verifier. Averages per task; "correct" is the task's own deterministic check, "judged" is the verifier's verdict, "agree" is how often they match.`, "");
  lines.push("| Engine · model | Task | Correct | Judged complete | Agree | Attempts | In | Out | Cost | Wall s | Cards | Denials |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const engine of args.engines) {
    const model = scores.find((s) => s.engine === engine)?.model ?? "";
    for (const task of TASKS) {
      const rows = scores.filter((s) => s.engine === engine && s.task === task.key);
      if (!rows.length) continue;
      const judged = rows.filter((r) => r.judged !== null);
      lines.push(`| ${engine} · ${model} | ${task.key} | ${pct(rows.map((r) => r.correct))} | ${pct(judged.map((r) => r.judged === true))} | ${pct(judged.map((r) => r.judged === r.correct))} | ${avg(rows.map((r) => r.attempts)).toFixed(1)} | ${Math.round(avg(rows.map((r) => r.input))).toLocaleString()} | ${Math.round(avg(rows.map((r) => r.output))).toLocaleString()} | $${avg(rows.map((r) => r.costUsd)).toFixed(4)} | ${(avg(rows.map((r) => r.wallMs)) / 1000).toFixed(0)} | ${avg(rows.map((r) => r.interventions)).toFixed(1)} | ${avg(rows.map((r) => r.denials)).toFixed(1)} |`);
    }
    const all = scores.filter((s) => s.engine === engine);
    const judged = all.filter((r) => r.judged !== null);
    lines.push(`| **${engine} · all** | | **${pct(all.map((r) => r.correct))}** | ${pct(judged.map((r) => r.judged === true))} | ${pct(judged.map((r) => r.judged === r.correct))} | ${avg(all.map((r) => r.attempts)).toFixed(1)} | ${Math.round(avg(all.map((r) => r.input))).toLocaleString()} | ${Math.round(avg(all.map((r) => r.output))).toLocaleString()} | **$${avg(all.map((r) => r.costUsd)).toFixed(4)}** | ${(avg(all.map((r) => r.wallMs)) / 1000).toFixed(0)} | ${avg(all.map((r) => r.interventions)).toFixed(1)} | ${avg(all.map((r) => r.denials)).toFixed(1)} |`);
  }
  lines.push("", "Rule from the gap analysis §16: report the judge beside the number and average trials; a flaky engine cannot be picked from one run. Wall time includes the board's dispatch tick (up to 30 s).");
  return lines.join("\n");
}

async function main() {
  const board = await fetch(`${args.url}/api/tasks`);
  if (board.status === 404) throw new Error("the task board is off on this harness: set features.board");
  const bots = new Map<string, Array<{ id: string; model: string; cwd: string }>>();
  for (const engine of args.engines) {
    const list: Array<{ id: string; model: string; cwd: string }> = [];
    for (let trial = 1; trial <= args.trials; trial += 1) list.push(await makeBot(engine, trial));
    bots.set(engine, list);
  }
  // one bot per (engine, trial) so each trial starts cold; engines run in parallel, a bot's tasks in sequence
  await Promise.all(args.engines.flatMap((engine) => bots.get(engine)!.map(async (bot, index) => {
    for (const task of TASKS) await runTask(engine, index + 1, bot, task);
  })));
  const text = report();
  console.log(text);
  if (args.out) { writeFileSync(args.out, `${text}\n`); process.stderr.write(`wrote ${args.out}\n`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
