// Automations report into the bot's chat, end to end: the real server and Claude driver, the scripted fake engine
// answering each turn by what it was sent, and the permission broker reached the way the CLI's proxy reaches it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { AUTOMATION_REPLY_PROMPT } from "./system-prompt.ts";
import { launchRestartableServer } from "./testing/restartable-server.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

let fixture: VerificationServer | undefined;
let events: SseRecorder | undefined;
let broker: Socket | undefined;
afterEach(async () => {
  broker?.destroy();
  events?.close();
  if (fixture) {
    console.info(JSON.stringify({ logPath: fixture.info.logPath }));
    await fixture.close();
  }
  fixture = events = broker = undefined;
});

type ScriptEntry = {
  key: string; match: string[]; reply: string; repeat?: boolean; gateFile?: string; expectContextIncludes?: string[]; fail?: boolean;
  steps?: Array<{ tool: string; arguments: Record<string, unknown> }>;
};

async function server(env: NodeJS.ProcessEnv = {}) {
  fixture = await launchVerificationServer({ ...process.env, ...env }, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, status?: number) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    if (status === undefined) expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    else expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const { bot } = await cli("new-bot", "--name", "Pepper");
  const main = bot.activeTaskId as string;
  const planPath = join(dataDir, "room-plan.json");
  const script = (entries: ScriptEntry[], others: Record<string, ScriptEntry[]> = {}) => writeFileSync(planPath, JSON.stringify(
    Object.fromEntries(Object.entries({ [bot.id]: entries, ...others }).map(([id, each]) => [id, { script: each }]))));
  events = await openSse(`${url}/api/events`, { origin: url });
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[];
  const lines = async (threadId = main) => (await messages(threadId)).filter((message) => message.automation);
  const runs = async () => (await api("GET", "/api/routines")).runs as any[];
  const run = async (id: string) => (await runs()).find((candidate) => candidate.id === id);
  const routine = async (name: string) => (await api("POST", "/api/routines", {
    name, prompt: `Do the ${name} check.`, botId: bot.id, enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
  }, 201)).routine.id as string;
  const runNow = async (routineId: string) => (await api("POST", `/api/routines/${routineId}/run`, undefined, 201)).run.id as string;
  const settled = (id: string, status = "completed") => expect.poll(async () => (await run(id))?.status, { timeout: 30_000 }).toBe(status);
  const reported = (id: string, state: string) => expect.poll(async () => (await run(id))?.report?.state, { timeout: 30_000 }).toBe(state);
  const savedBot = async () => (await api("GET", "/api/bots")).bots.find((candidate: any) => candidate.id === bot.id);
  const notified = () => events!.frames.filter((frame) => frame.kind === "notify").map((frame) => frame.notification as { kind: string; threadId: string; body: string });
  const header = (name: string) => `Routine ${JSON.stringify(name)} — do this now:`;
  /** Rows about these conversations in the workspace Chief's incidents and escalations conversations. */
  const chiefRows = async (...threadIds: string[]) => (await Promise.all((await api("GET", "/api/bots")).bots
    .flatMap((each: any) => (each.tasks ?? []).filter((task: any) => task.title === "Team incidents" || task.title === "Team escalations"))
    .map(async (task: any) => (await messages(task.threadId)).filter((message) => threadIds.includes(message.threadRef?.threadId))))).flat();
  /** Whether the turn the script answered with `key` was told that only its last reply leaves the run. */
  const toldOnlyReplyLeaves = (key: string) => {
    const turns = readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { planKey?: string; system?: string; prompt?: unknown });
    const turn = turns.find((candidate) => candidate.planKey === key);
    expect(turn, `no turn answered with ${key}`).toBeTruthy();
    return `${turn!.system}\n${JSON.stringify(turn!.prompt)}`.includes(AUTOMATION_REPLY_PROMPT.trim());
  };
  return { url, dataDir, api, cli, bot, main, script, messages, lines, runs, run, routine, runNow, settled, reported, savedBot, notified, header, chiefRows, toldOnlyReplyLeaves };
}

/** The run's permission broker, reached the way the CLI's proxy reaches it; what it answers lands in the returned list. */
async function brokerOf(s: Awaited<ReturnType<typeof server>>, threadId: string): Promise<any[]> {
  const dump = join(s.dataDir, "fake-claude-dump.json");
  await expect.poll(() => {
    try { return JSON.parse(readFileSync(dump, "utf8")).mcpConfig?.mcpServers?.agents?.env?.OMB_THREAD_ID === threadId; } catch { return false; }
  }, { timeout: 20_000 }).toBe(true);
  const socketPath = JSON.parse(readFileSync(dump, "utf8")).mcpConfig.mcpServers.ogb.args.at(-1);
  const socket = broker = connect(socketPath);
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const answers: any[] = [];
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString();
    for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
      answers.push(JSON.parse(buffered.slice(0, at)));
      buffered = buffered.slice(at + 1);
    }
  });
  return answers;
}

it("reports each run into the main chat as the bot's own line, writes nothing for a quiet run, and keeps every run one click away", async () => {
  const s = await server();
  s.script([
    { key: "first", match: [s.header("Inbox watch")], reply: "Checked 14 emails.\nNOTHING NEW" },
    { key: "second", match: [s.header("Inbox watch")], reply: "Acme replied: they need the invoice by Friday." },
    { key: "third", match: [s.header("Inbox watch")], reply: "NOTHING NEW" },
  ]);
  const routineId = await s.routine("Inbox watch");
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) {
    const id = await s.runNow(routineId);
    await s.settled(id);
    await s.reported(id, index === 1 ? "posted" : "quiet");
    ids.push(id);
  }
  const all = await Promise.all(ids.map(s.run));
  const lines = await s.lines();
  expect(lines).toEqual([expect.objectContaining({
    role: "bot", kind: "text", text: "Acme replied: they need the invoice by Friday.",
    automation: expect.objectContaining({ name: "Inbox watch", runId: ids[1], executionThreadId: all[1].threadId, trigger: "manual" }),
  })]);
  expect(all[1].report).toEqual({ state: "posted", threadId: s.main, messageId: lines[0].id });
  expect((await s.messages(s.main)).some((message) => message.kind === "routine.run")).toBe(false);
  const saved = await s.savedBot();
  for (const each of all) {
    expect(each.resultsThreadId).toBe(s.main);
    expect(saved.tasks.find((task: any) => task.threadId === each.threadId)).toMatchObject({ routineRunId: each.id, unread: false });
  }
  expect(saved.tasks.find((task: any) => task.threadId === s.main).unread).toBe(true);
  const done = s.notified().filter((notification) => notification.kind === "done");
  expect(done).toEqual([expect.objectContaining({ threadId: s.main, body: "Inbox watch: Acme replied: they need the invoice by Friday." })]);
  for (const key of ["first", "second", "third"]) expect(s.toldOnlyReplyLeaves(key)).toBe(true);
  const transcript = await s.messages(all[1].threadId);
  expect(transcript.find((message) => message.role === "user")?.text).toContain(s.header("Inbox watch"));
  expect(transcript.findLast((message) => message.role === "bot" && message.kind === "text")?.text).toBe("Acme replied: they need the invoice by Friday.");
}, 120_000);

it("opens a file a run linked in its report from the chat it reported to", async () => {
  const s = await server();
  s.script([
    { key: "run", match: [s.header("Weekly report")], reply: "Wrote [the summary](summary.md)." },
    { key: "person", match: ["Where is the summary?"], reply: "It is [here](summary.md)." },
  ]);
  const id = await s.runNow(await s.routine("Weekly report"));
  await s.reported(id, "posted");
  const { threadId } = await s.run(id);
  writeFileSync(join(s.dataDir, "task-workspaces", s.bot.id, threadId, "summary.md"), "Three new orders.");
  const [report] = await s.lines();
  const open = (thread: string, messageId: string) => fetch(`${s.url}/api/threads/${thread}/messages/${messageId}/file`, {
    method: "POST", headers: { "content-type": "application/json", origin: s.url }, body: JSON.stringify({ path: "summary.md" }),
  });
  const opened = await open(s.main, report.id);
  expect(opened.status).toBe(200);
  expect(await opened.text()).toBe("Three new orders.");
  await s.cli("send", "--bot", s.bot.id, "--task", s.main, "--text", "Where is the summary?");
  await s.cli("wait", "--bot", s.bot.id, "--task", s.main, "--timeout", "20");
  const own = (await s.messages(s.main)).findLast((message) => message.role === "bot" && message.kind === "text" && !message.automation);
  expect(own.text).toBe("It is [here](summary.md).");
  expect((await open(s.main, own.id)).status).toBeGreaterThanOrEqual(400);
}, 120_000);

it("holds a report while the person's own turn runs in the main chat, never delays that turn, and writes it once right after", async () => {
  const s = await server();
  const gate = join(s.dataDir, "finish-person-turn");
  s.script([
    { key: "person", match: ["Draft the weekly update."], reply: "Here is the weekly update draft.", gateFile: gate },
    { key: "run", match: [s.header("Inbox watch")], reply: "Acme replied." },
  ]);
  const routineId = await s.routine("Inbox watch");
  await s.cli("send", "--bot", s.bot.id, "--task", s.main, "--text", "Draft the weekly update.");
  await expect.poll(async () => (await s.savedBot()).tasks.find((task: any) => task.threadId === s.main)?.busy, { timeout: 20_000 }).toBe(true);
  const id = await s.runNow(routineId);
  await s.settled(id);
  await s.reported(id, "pending");
  expect(await s.lines()).toEqual([]);
  expect((await s.savedBot()).tasks.find((task: any) => task.threadId === s.main)?.busy).toBe(true);
  writeFileSync(gate, "done");
  await s.reported(id, "posted");
  const transcript = (await s.messages(s.main)).filter((message) => message.role === "user" || message.kind === "text");
  expect(transcript.slice(-3).map((message) => [message.role, message.text, Boolean(message.automation)])).toEqual([
    ["user", "Draft the weekly update.", false],
    ["bot", "Here is the weekly update draft.", false],
    ["bot", "Acme replied.", true],
  ]);
  await s.cli("wait", "--bot", s.bot.id, "--task", s.main, "--timeout", "20");
  expect(await s.lines()).toHaveLength(1);
  expect(s.notified().filter((notification) => notification.kind === "done" && notification.body.startsWith("Inbox watch:"))).toHaveLength(1);
}, 120_000);

it("copies a question a run waits on into the main chat, and the answer given there carries the run on", async () => {
  const s = await server();
  const gate = join(s.dataDir, "finish-run");
  s.script([{ key: "run", match: [s.header("Inbox watch")], reply: "Used the Work account: two new orders.", gateFile: gate }]);
  const routineId = await s.routine("Inbox watch");
  const id = await s.runNow(routineId);
  await s.settled(id, "running");
  const { threadId } = await s.run(id);
  const answers = await brokerOf(s, threadId);
  broker!.write(JSON.stringify({ t: "ask", kind: "question", id: "which-account", tool: "ask_user", input: { question: "Which account should I check?" } }) + "\n");
  await s.settled(id, "waiting");
  await expect.poll(async () => (await s.messages(s.main)).find((message) => message.kind === "options")?.card?.requestId, { timeout: 20_000 }).toBeTruthy();
  const copy = (await s.messages(s.main)).find((message) => message.kind === "options");
  expect(copy.automation).toMatchObject({ runId: id, needsYou: true, executionThreadId: threadId, name: "Inbox watch" });
  const original = (await s.messages(threadId)).find((message) => message.card?.requestId === copy.card.requestId);
  expect(original).toBeTruthy();
  expect(s.notified().some((notification) => notification.kind === "question" && notification.threadId === s.main)).toBe(true);

  await s.api("POST", `/api/threads/${s.main}/respond`, { requestId: copy.card.requestId, behavior: "answer", message: "Work" });
  await expect.poll(() => answers.find((answer) => answer.id === "which-account"), { timeout: 20_000 }).toMatchObject({ t: "answer", behavior: "answer", message: "Work", source: "user" });
  await s.settled(id, "running");
  await expect.poll(async () => (await s.messages(s.main)).find((message) => message.id === copy.id)?.card?.answered, { timeout: 20_000 }).toBeTruthy();
  expect((await s.messages(threadId)).find((message) => message.id === original.id)?.card?.answered).toBeTruthy();
  writeFileSync(gate, "done");
  await s.reported(id, "posted");
  expect((await s.lines()).map((line) => [line.kind, line.text ?? line.card?.subtitle])).toEqual([
    ["options", copy.card.subtitle],
    ["text", "Used the Work account: two new orders."],
  ]);
}, 120_000);

it("asks the person in the main chat when a run needs them, and their answer there reaches the bot with that report in hand", async () => {
  const s = await server();
  s.script([
    { key: "run", match: [s.header("Acme replies")], reply: "I drafted a reply to Acme's invoice question.\nNEEDS INPUT: Should I send it?" },
    { key: "answer", match: ["Yes, send it."], reply: "Sent.", expectContextIncludes: ["Your automation", "Acme replies", "Should I send it?"] },
  ]);
  const id = await s.runNow(await s.routine("Acme replies"));
  await s.settled(id);
  await s.reported(id, "posted");
  expect(await s.lines()).toEqual([expect.objectContaining({
    kind: "text", text: "I drafted a reply to Acme's invoice question.\nShould I send it?",
    automation: expect.objectContaining({ needsYou: true, name: "Acme replies" }),
  })]);
  expect(s.notified().filter((notification) => notification.threadId === s.main).map((notification) => [notification.kind, notification.body]))
    .toContainEqual(["question", "Acme replies: Should I send it?"]);
  await s.cli("send", "--bot", s.bot.id, "--task", s.main, "--text", "Yes, send it.");
  await s.cli("wait", "--bot", s.bot.id, "--task", s.main, "--timeout", "20");
  expect((await s.messages(s.main)).findLast((message) => message.role === "bot" && message.kind === "text")?.text).toBe("Sent.");
}, 120_000);

it("takes a 👍 on a run's question in the chat as the answer, with that report in hand", async () => {
  const s = await server();
  s.script([
    { key: "run", match: [s.header("Acme replies")], reply: "I drafted a reply to Acme's invoice question.\nNEEDS INPUT: Should I send it?" },
    { key: "answer", match: ["reacted 👍"], reply: "Sent.", expectContextIncludes: ["Your automation", "Acme replies", "Should I send it?"] },
  ]);
  const id = await s.runNow(await s.routine("Acme replies"));
  await s.reported(id, "posted");
  const [question] = await s.lines();
  expect(await s.api("POST", `/api/threads/${s.main}/messages/${question.id}/reactions`, { emoji: "👍", on: true })).toMatchObject({ delivery: "started" });
  await s.cli("wait", "--bot", s.bot.id, "--task", s.main, "--timeout", "20");
  expect((await s.messages(s.main)).findLast((message) => message.role === "bot" && message.kind === "text")?.text).toBe("Sent.");
}, 120_000);

it("answers the run itself when the person gives a 👍 to the copy of the question it waits on", async () => {
  const s = await server();
  const gate = join(s.dataDir, "finish-run");
  s.script([{ key: "run", match: [s.header("Inbox watch")], reply: "Checked the Work account: two new orders.", gateFile: gate }]);
  const id = await s.runNow(await s.routine("Inbox watch"));
  await s.settled(id, "running");
  const answers = await brokerOf(s, (await s.run(id)).threadId);
  broker!.write(JSON.stringify({ t: "ask", kind: "question", id: "work-account", tool: "ask_user", input: { question: "Should I check the Work account?" } }) + "\n");
  await expect.poll(async () => (await s.lines()).find((message) => message.kind === "options")?.card?.requestId, { timeout: 20_000 }).toBeTruthy();
  const copy = (await s.lines()).find((message) => message.kind === "options");
  expect(await s.api("POST", `/api/threads/${s.main}/messages/${copy.id}/reactions`, { emoji: "👍", on: true })).toMatchObject({ delivery: "answered" });
  await expect.poll(() => answers.find((answer) => answer.id === "work-account"), { timeout: 20_000 }).toMatchObject({ t: "answer", behavior: "answer", source: "user" });
  await s.settled(id, "running");
  writeFileSync(gate, "done");
  await s.reported(id, "posted");
  expect((await s.lines()).map((line) => line.text ?? line.card?.subtitle).at(-1)).toBe("Checked the Work account: two new orders.");
}, 120_000);

it("hands the chat's own session the newest report of each automation, however much else came in since its last turn", async () => {
  // A CLI that resumes exactly, so the turn gets only what its session has not seen, within a budget.
  const s = await server({ FAKE_CLAUDE_VERSION: "2.1.284" });
  // Without memory, nothing but the chat itself can bring the question back.
  await s.api("PATCH", `/api/bots/${s.bot.id}`, { memoryEnabled: false });
  s.script([
    { key: "hello", match: ["Morning!"], reply: "Morning! What's first?" },
    { key: "acme", match: [s.header("Acme replies")], reply: "NEEDS INPUT: Should I send the reply to Acme?" },
    { key: "orders", match: [s.header("Orders")], reply: `New orders: ${"a long list of order lines ".repeat(100)}`, repeat: true },
    { key: "answer", match: ["Yes, send it."], reply: "Sent.", expectContextIncludes: ["Should I send the reply to Acme?"] },
  ]);
  await s.cli("send", "--bot", s.bot.id, "--task", s.main, "--text", "Morning!");
  await s.cli("wait", "--bot", s.bot.id, "--task", s.main, "--timeout", "20");
  const acme = await s.runNow(await s.routine("Acme replies"));
  await s.reported(acme, "posted");
  const orders = await s.routine("Orders");
  for (let index = 0; index < 2; index++) await s.reported(await s.runNow(orders), "posted");
  await s.cli("send", "--bot", s.bot.id, "--task", s.main, "--text", "Yes, send it.");
  await s.cli("wait", "--bot", s.bot.id, "--task", s.main, "--timeout", "20");
  expect((await s.messages(s.main)).findLast((message) => message.role === "bot" && message.kind === "text")?.text).toBe("Sent.");
}, 120_000);

it("reports an outside event's run into the main chat too, from a conversation of its own that stays out of the way", async () => {
  const s = await server();
  s.script([{ key: "lead", match: ["Draft a follow-up"], reply: "Drafted a follow-up for Ada.", repeat: true }]);
  const { webhook, credential } = await s.api("POST", "/api/webhooks", { name: "Sales form leads", prompt: "Draft a follow-up for the lead.", botId: s.bot.id }, 201);
  const response = await fetch(credential.url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "lead-1" }, body: JSON.stringify({ lead: "Ada" }) });
  expect(response.status).toBe(202);
  const { runId } = await response.json() as any;
  await s.settled(runId);
  await s.reported(runId, "posted");
  const done = await s.run(runId);
  expect(done).toMatchObject({ webhookId: webhook.id, resultsThreadId: s.main, triggerSource: "webhook" });
  expect(await s.lines()).toEqual([expect.objectContaining({ text: "Drafted a follow-up for Ada.", automation: expect.objectContaining({ trigger: "webhook", name: "Sales form leads" }) })]);
  expect(s.toldOnlyReplyLeaves("lead")).toBe(true);
  const saved = await s.savedBot();
  expect(saved.threadId).toBe(s.main);
  expect(saved.tasks.find((task: any) => task.threadId === done.threadId)).toMatchObject({ routineRunId: runId });
  expect(existsSync(join(s.dataDir, "room-plan.json"))).toBe(true);
}, 120_000);

it("asks once, in the chat, when Chief escalations are on: a run's question is not escalated as well", async () => {
  const s = await server();
  await s.api("PATCH", "/api/config", { features: { chiefEscalations: true } });
  s.script([{ key: "run", match: [s.header("Acme replies")], reply: "NEEDS INPUT: Should I send the reply to Acme?" }]);
  const id = await s.runNow(await s.routine("Acme replies"));
  await s.reported(id, "posted");
  const { threadId } = await s.run(id);
  await expect.poll(() => s.notified().some((notification) => notification.kind === "question" && notification.threadId === s.main), { timeout: 20_000 }).toBe(true);
  // Neither told to the person a second time nor handed to the workspace's Chief as an escalation.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(s.notified().filter((notification) => notification.threadId === threadId || notification.kind === "incident")).toEqual([]);
  expect(await s.chiefRows(threadId, s.main)).toEqual([]);
}, 120_000);

it("still reports the person's own failed turn in a chat a run once continued", async () => {
  const s = await server();
  s.script([
    { key: "continue", match: [s.header("Finish the report")], reply: "Picked up where I stopped: the report is done." },
    { key: "person", match: ["Plan the launch."], reply: "never", fail: true },
  ]);
  const { routine } = await s.api("POST", "/api/routines", {
    name: "Finish the report", prompt: "Do the Finish the report check.", botId: s.bot.id, schedule: { type: "limit_reset", engine: "claude" },
  }, 201);
  const id = await s.runNow(routine.id);
  await s.settled(id);
  expect(await s.run(id)).toMatchObject({ threadId: s.main });
  expect(await s.lines()).toEqual([]);
  expect(s.toldOnlyReplyLeaves("continue")).toBe(false);
  await s.cli("send", "--bot", s.bot.id, "--task", s.main, "--text", "Plan the launch.");
  await s.cli("wait", "--bot", s.bot.id, "--task", s.main, "--timeout", "20");
  // The failure is filed: with the workspace's Chief, as a row in its incidents conversation; without one, to the person.
  const filed = async () => s.notified().some((notification) => notification.kind === "incident" && notification.threadId === s.main) ||
    (await s.chiefRows(s.main)).length > 0;
  await expect.poll(filed, { timeout: 20_000 }).toBe(true);
}, 120_000);

it("does not take a person's failed turn in a run's conversation for the run's own while the run waits on a teammate", async () => {
  const s = await server();
  const { bot: sam } = await s.cli("new-bot", "--name", "Sam");
  const samGate = join(s.dataDir, "sam-counts");
  s.script([
    { key: "run", match: [s.header("Stock check")], steps: [{ tool: "coordinate_bots", arguments: { bot_ids: [sam.id], message: "Count the boxes in stock." } }], reply: "Asked Sam to count the stock." },
    { key: "person", match: ["Any news?"], reply: "never", fail: true },
    { key: "resume", match: ["42 boxes"], reply: "We have 42 boxes in stock." },
  ], { [sam.id]: [{ key: "count", match: ["Count the boxes in stock."], reply: "Counted 42 boxes.", gateFile: samGate }] });
  const id = await s.runNow(await s.routine("Stock check"));
  await s.settled(id, "waiting");
  const { threadId } = await s.run(id);
  await s.cli("send", "--bot", s.bot.id, "--task", threadId, "--text", "Any news?");
  await s.cli("wait", "--bot", s.bot.id, "--task", threadId, "--timeout", "20");
  await expect.poll(async () => (await s.messages(threadId)).some((message) => message.kind === "activity" && message.tool?.ok === false), { timeout: 20_000 }).toBe(true);
  expect(await s.run(id)).toMatchObject({ status: "waiting" });
  expect((await s.run(id)).error).toBeUndefined();
  expect(await s.lines()).toEqual([]);
  writeFileSync(samGate, "done");
  await s.settled(id);
  await s.reported(id, "posted");
  expect((await s.lines()).map((line) => line.text)).toEqual(["We have 42 boxes in stock."]);
}, 120_000);

it("says in the main chat, once per run of failures, that an automation could not finish", async () => {
  const s = await server();
  s.script([{ key: "run", match: [s.header("Inbox watch")], reply: "never", fail: true, repeat: true }]);
  const routineId = await s.routine("Inbox watch");
  const first = await s.runNow(routineId);
  await s.settled(first, "failed");
  await s.reported(first, "posted");
  expect(await s.lines()).toEqual([expect.objectContaining({
    text: expect.stringMatching(/^This run didn't finish: /), automation: expect.objectContaining({ failed: true, runId: first }),
  })]);
  const second = await s.runNow(routineId);
  await s.settled(second, "failed");
  expect((await s.run(second)).error).toBe((await s.run(first)).error);
  expect(await s.lines()).toHaveLength(1);
}, 120_000);

it("tells the main chat about a run missed while the computer was off, which has no conversation of its own", async () => {
  const restartable = await launchRestartableServer({ scripted: true });
  const api = async (method: string, path: string, body?: unknown) => (await fetch(`${restartable.url}${path}`, {
    method, headers: { "content-type": "application/json", origin: restartable.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })).json() as Promise<any>;
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Pepper", "--url", restartable.url]) as any;
    const main = bot.activeTaskId as string;
    const { routine } = await api("POST", "/api/routines", {
      name: "Inbox watch", prompt: "Do the Inbox watch check.", botId: bot.id,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    });
    await restartable.stop();
    const file = join(restartable.dataDir, "routines.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.routines.find((each: any) => each.id === routine.id).nextRunAt = Date.now() - 13 * 3_600_000;
    writeFileSync(file, JSON.stringify(saved));
    await restartable.start();
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.map((run: any) => run.status), { timeout: 30_000 }).toEqual(["missed"]);
    const missed = (await api("GET", "/api/routines")).runs[0];
    expect(missed).toMatchObject({ resultsThreadId: main });
    expect(missed.threadId).toBeUndefined();
    await expect.poll(async () => (await api("GET", `/api/threads/${main}/messages?limit=200`)).messages
      .filter((message: any) => message.routineRun?.runId === missed.id).map((message: any) => message.routineRun.status), { timeout: 10_000 }).toEqual(["missed"]);
    const task = (await api("GET", "/api/bots")).bots.find((each: any) => each.id === bot.id).tasks.find((each: any) => each.threadId === main);
    expect(task.unread).toBe(true);
  } finally {
    await restartable.close();
  }
}, 120_000);
