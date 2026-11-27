// The real scheduler, chat and renderer in a disposable home, with the scripted fake engine: an automation set up in
// chat runs every minute for five minutes and reports into the one chat, and its fourth run asks a question there.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const RUNS = 5;
const NAME = "Inbox watch";
const header = `Scheduled routine ${JSON.stringify(NAME)} — do this now:`;
const QUESTION = "Which Acme account should I check?";

const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
let ui: MountedPreview | undefined;
let broker: Socket | undefined;
const evidence: unknown[] = [];
const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url }, observe: (call) => { if (call.method !== "GET") evidence.push(call); } });
const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
const say = (line: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...line }));
async function until<T>(check: () => T | Promise<T>, timeoutMs = 120_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Fixture timed out; see ${fixture.info.logPath}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
let botId = "";
let main = "";
let routineId = "";
try {
  const { bot } = await control(["new-bot", "--name", "Pepper"]);
  botId = bot.id;
  main = bot.activeTaskId;
  await api("PATCH", "/api/config", { language: "en" });
  await api("PUT", "/api/config", { profile: { name: "Automations verification" } });
  const gate = join(fixture.info.dataDir, "fourth-run-gate");
  const reply = (text: string, key: string, extra: Record<string, unknown> = {}) => ({ key, match: [header], reply: text, ...extra });
  writeFileSync(join(fixture.info.dataDir, "room-plan.json"), JSON.stringify({ [botId]: { script: [
    { key: "setup", match: ["Watch my inbox"], reply: "Done: I'll look every minute and only write here when something needs you.", steps: [{ tool: "create_trigger", arguments: {
      when: "schedule", name: NAME, instructions: "Look through my inbox for anything from Acme. Tell me only what needs me.",
      schedule: { type: "cron", expression: "* * * * *", timeZone: "UTC" },
    } }] },
    { key: "thanks", match: ["Thanks"], reply: "You're welcome. I'll keep watching and say something only when it matters." },
    reply("Checked 3 new emails, none from Acme.\nNOTHING NEW", "run-1"),
    reply("Acme wrote: they need the March invoice by Friday. I saved their note to your Acme folder.", "run-2"),
    reply("NOTHING NEW", "run-3"),
    reply("Checked the Work account: two new orders from Acme are waiting in Shopify.", "run-4", { gateFile: gate }),
    reply("Nothing else from Acme.\nNOTHING NEW", "run-5"),
    { ...reply("NOTHING NEW", "later"), repeat: true },
  ] } }));
  ui = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__automations.html", title: "Isolated OpenMaus Automations", logLevel: "silent" });
  say({ ...fixture.info, previewUrl: ui.previewUrl, botId, mainThreadId: main });

  await control(["send", "--bot", botId, "--task", main, "--text", "Watch my inbox and tell me when Acme writes."]);
  await control(["wait", "--bot", botId, "--task", main, "--timeout", "30"]);
  routineId = await until(async () => ((await api("GET", "/api/routines")).routines as any[]).find((routine) => routine.name === NAME)?.id);
  say({ step: "automation set up from chat", routineId });

  const runsOf = async () => ((await api("GET", "/api/routines")).runs as any[]).filter((run) => run.routineId === routineId).reverse();
  for (let index = 1; index <= RUNS; index++) {
    const run = await until(async () => (await runsOf())[index - 1], 150_000);
    say({ step: `run ${index} started`, runId: run.id, scheduledFor: new Date(run.scheduledFor).toISOString() });
    if (index === 4) {
      const started = await until(async () => {
        const current = (await runsOf())[3];
        if (current?.status !== "running" || !existsSync(fixture.fixtureDumpPath)) return null;
        const launch = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
        return launch.mcpConfig?.mcpServers?.agents?.env?.OMB_THREAD_ID === current.threadId ? launch.mcpConfig.mcpServers.ogb.args.at(-1) as string : null;
      });
      broker = connect(started);
      broker.on("error", () => {});
      await new Promise<void>((resolve, reject) => { broker!.once("connect", resolve); broker!.once("error", reject); });
      broker.write(JSON.stringify({ t: "ask", kind: "question", id: "acme-account", tool: "AskUserQuestion",
        input: { questions: [{ question: QUESTION, header: "Account", options: [{ label: "Work" }, { label: "Personal" }] }] } }) + "\n");
      say({ step: "run 4 asks in the chat; answer it there", question: QUESTION });
      await until(async () => ((await api("GET", `/api/threads/${main}/messages?limit=200`)).messages as any[])
        .find((message) => message.automation && message.card?.requestId === "acme-account")?.card?.answered, 600_000);
      say({ step: "answered in the chat" });
      writeFileSync(gate, "answered");
    }
    const done = await until(async () => {
      const current = (await runsOf())[index - 1];
      return current && ["completed", "failed"].includes(current.status) && current.report ? current : null;
    }, 150_000);
    say({ step: `run ${index} finished`, status: done.status, report: done.report });
  }
  await api("PATCH", `/api/routines/${routineId}`, { enabled: false });
  say({ step: `paused after ${RUNS} runs` });
  await parkUntilSignal();
} finally {
  broker?.destroy();
  const routines = await api("GET", "/api/routines").catch(() => null);
  const chat = main ? await api("GET", `/api/threads/${main}/messages?limit=200`).catch(() => null) : null;
  const bots = await api("GET", "/api/bots?messages=0").catch(() => null);
  writeFileSync(`${fixture.info.logPath}.automation-reports.json`, JSON.stringify({ evidence, botId, main, routineId, routines, chat, bots }, null, 2));
  await ui?.close();
  await fixture.close();
}
