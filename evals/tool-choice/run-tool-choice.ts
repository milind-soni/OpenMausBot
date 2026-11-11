// Which tool does a real model pick, from a tool list as it is shipped? Real requests that went wrong, one thread each on one
// bot, so a change to the list (the agents tool bridge, a shorter description, a removed built-in) is judged on evidence.
//
//   OMB_EVAL_LIVE=1 OMB_EVAL_LIVE_INSTANCE='{"instanceId":"claude","driver":"claudeAgent","model":"claude-sonnet-5","config":{"cli":"/path/to/claude"},"environmentFrom":["HOME","USER"]}' \
//     node --experimental-strip-types evals/tool-choice/run-tool-choice.ts --only trigger-on-new-mail,what-did-we-decide
//
// Each case is one real model turn on your account: never in CI, closed unless OMB_EVAL_LIVE=1. For the bridge, add
// OMB_AGENTS_TOOL_BRIDGE=1 OMB_EVAL_LIVE_PASS_ENV=OMB_AGENTS_TOOL_BRIDGE. Everything else is a temporary data folder.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLiveInstance } from "../live/run-live.ts";
import { spawnLiveServer } from "../live/live-server.ts";
import { scoreCase, summarize, type CaseScore, type ToolChoiceCase } from "./score.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Row { id: string; score: CaseScore; calls: string[]; reply: string; costUsd?: number; inputTokens?: number; done: boolean }

async function main(): Promise<void> {
  if (process.env.OMB_EVAL_LIVE !== "1") {
    console.log("tool-choice eval: skipped (set OMB_EVAL_LIVE=1; each case is one real model turn)");
    return;
  }
  const argument = (name: string) => { const at = process.argv.indexOf(name); return at === -1 ? undefined : process.argv[at + 1]; };
  const only = argument("--only")?.split(",");
  const cases = (JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8")) as ToolChoiceCase[]).filter((item) => !only || only.includes(item.id));
  const instance = loadLiveInstance(process.env);
  const pass = (process.env.OMB_EVAL_LIVE_PASS_ENV ?? "").split(/[:,]/).map((name) => name.trim()).filter(Boolean);
  const session = await spawnLiveServer(process.env, instance, pass);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(session.url + path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const parsed = await response.json().catch(() => null) as any;
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(parsed)}`);
    return parsed;
  };
  const day = new Date().toISOString().slice(0, 10);
  const spent = async () => {
    const usage = await call("GET", `/api/usage?from=${day}&to=${day}`);
    const totals = usage.total ?? usage.totals ?? {};
    return { cost: Number(totals.costUsd ?? 0), input: Number(totals.input ?? 0) + Number(totals.cachedInput ?? 0) };
  };
  const rows: Row[] = [];
  try {
    const { bot } = await call("POST", "/api/bots", { name: "Helper", modelSelection: { instanceId: instance.instanceId, model: instance.model } });
    for (const item of cases) {
      const before = await spent();
      const { task } = await call("POST", `/api/bots/${bot.id}/tasks`, { title: item.id, select: false });
      await call("POST", `/api/bots/${bot.id}/messages`, { text: item.text, threadId: task.threadId });
      const deadline = Date.now() + 180_000;
      let messages: any[] = [], done = false;
      while (Date.now() < deadline && !done) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        messages = (await call("GET", `/api/threads/${task.threadId}/messages`)).messages ?? [];
        const state = (await call("GET", "/api/bots?messages=0")).bots.find((entry: any) => entry.id === bot.id);
        done = !state?.busy && messages.some((message) => message.role === "bot" && message.kind === "text" && (message.text ?? "").trim());
      }
      const calls = messages.filter((message) => message.kind === "activity" && message.tool?.name).map((message) => String(message.tool.name));
      const after = await spent();
      const row: Row = { id: item.id, score: scoreCase(item, calls), calls, done, costUsd: Number((after.cost - before.cost).toFixed(4)), inputTokens: after.input - before.input,
        reply: String(messages.filter((message) => message.role === "bot" && message.kind === "text").at(-1)?.text ?? "").slice(0, 200) };
      rows.push(row);
      console.log(`${row.score.pass ? "pass" : "MISS"} ${item.id}: ${row.score.chosen ?? "no tool"}${row.score.searched ? " (looked up)" : ""} $${row.costUsd} [${calls.join(", ")}]`);
    }
  } finally {
    await session.close();
  }
  const report = { summary: summarize(rows), bridge: process.env.OMB_AGENTS_TOOL_BRIDGE ?? "off", rows };
  console.log(JSON.stringify(report.summary));
  const out = argument("--out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(report, null, 1));
  }
}

await main();
