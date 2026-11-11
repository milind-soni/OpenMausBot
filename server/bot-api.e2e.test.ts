// A bot's API on a real server with the fake engine: switched on from the app, called with the very curl the card shows,
// answered with the bot's reply in a thread the app shows as the API's; a wrong key, an API that is off, the rate limit;
// and, on a bot that asks before acting, a call that stops at the approval nobody outside may give.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import { botApiCurl } from "../shared/bot-api.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { BOT_API_REFUSAL } from "./bot-api-fence.ts";
import { INCIDENTS_THREAD_TITLE } from "./incidents.ts";

let fixture: VerificationServer | undefined;
let socket: Socket | undefined;
afterEach(async () => {
  socket?.destroy();
  socket = undefined;
  await fixture?.close();
  fixture = undefined;
});

function appApi(url: string) {
  return async (method: string, path: string, body?: unknown, status?: number) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    if (status !== undefined) expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    else expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    return value;
  };
}

const call = async (endpoint: string, key: string, body: unknown) => {
  const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};

const sh = (command: string) => new Promise<string>((resolve, reject) => {
  execFile("sh", ["-c", command], { timeout: 60_000 }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)));
});

it("answers the card's own curl with the bot's reply, and refuses a wrong key, an API that is off, and an eleventh call in a minute", async () => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.284" });
  const { url } = fixture.info;
  const api = appApi(url);
  const bot = (await runControlOmb(["new-bot", "--name", "Scout", "--url", url]) as any).bot;
  const port = Number(new URL(url).port);

  // Off by default, and the card's address is the webhook receiver's.
  const before = await api("GET", `/api/bots/${bot.id}/bot-api`);
  expect(before).toMatchObject({ enabled: false, callCount: 0, canManage: true, url: `http://127.0.0.1:${port + 1}/hooks/api/bots/${bot.id}/messages` });
  expect((await call(before.url, "bak_nothing", { message: "Hi" })).status).toBe(403);

  // On: the key comes back once, with the address; the saved file holds a hash, not the key.
  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });
  expect(on.key).toMatch(/^bak_/);
  expect(readFileSync(join(fixture.info.dataDir, "bot-api.json"), "utf8")).not.toContain(on.key);

  // The curl exactly as the card shows it, pasted into a shell.
  const answered = JSON.parse(await sh(botApiCurl(on.url, on.key))) as { reply: string; thread: string };
  expect(answered.reply).toBe("hello from fake claude");
  expect(answered.thread).toMatch(/^[\w-]+$/);

  // The app shows the thread as the API's, with what the caller asked and what the bot said.
  const bots = (await api("GET", "/api/bots")).bots as any[];
  const task = bots.find((candidate) => candidate.id === bot.id).tasks.find((candidate: any) => candidate.threadId === answered.thread);
  expect(task).toMatchObject({ botApi: true, title: "Hello! What can you do?" });
  const lines = (await api("GET", `/api/threads/${answered.thread}/messages`)).messages as any[];
  expect(lines.find((line) => line.role === "user")).toMatchObject({ text: "Hello! What can you do?", via: "api" });
  expect(lines.filter((line) => line.role === "bot" && line.kind === "text").map((line) => line.text)).toEqual(["hello from fake claude"]);

  // Reading the thread back, and continuing it, through the same door; a wrong key gets nothing.
  const read = await fetch(`${on.url}?thread=${answered.thread}`, { headers: { authorization: `Bearer ${on.key}` } });
  expect(await read.json()).toEqual({ reply: "hello from fake claude", thread: answered.thread });
  expect((await call(on.url, `${on.key}x`, { message: "Hi" })).status).toBe(401);
  expect((await call(on.url, on.key, { message: "Again", thread: answered.thread })).body).toMatchObject({ reply: "hello from fake claude", thread: answered.thread });
  for (let i = 0; i < 8; i += 1) expect((await call(on.url, on.key, { message: `call ${i}`, thread: answered.thread })).status).toBe(200);
  const eleventh = await call(on.url, on.key, { message: "one more", thread: answered.thread });
  expect(eleventh.status).toBe(429);

  // Every call was recorded; the key never shows again.
  const after = await api("GET", `/api/bots/${bot.id}/bot-api`);
  expect(after).toMatchObject({ enabled: true, callCount: 10 });
  expect(after.calls.map((entry: any) => entry.statusCode)).toContain(429);
  expect(JSON.stringify(after)).not.toContain(on.key);

  // Off again: the key is gone with it.
  expect(await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: false })).toMatchObject({ enabled: false });
  expect((await call(on.url, on.key, { message: "Hi" })).status).toBe(403);
}, hostTimeout(180_000));

it.each(["ask", "full", "auto"])("a bot at %s stops at the approval: nothing answers it, and the call says needs_approval", async (level) => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.284", FAKE_CLAUDE_MODE: "hang" });
  const { url, dataDir } = fixture.info;
  const api = appApi(url);
  const bot = (await runControlOmb(["new-bot", "--name", "Careful", "--url", url]) as any).bot;
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: level });
  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });

  // The bot asks before acting: the fake engine's permission broker carries the ask the engine would make.
  const dump = join(dataDir, "fake-claude-dump.json");
  const pending = call(on.url, on.key, { message: "Clean up the downloads folder", wait: 60 }).catch((error: unknown) => ({ status: 0, body: { error: String(error) } }));
  const dumped = () => { try { return JSON.parse(readFileSync(dump, "utf8")); } catch { return null; } };
  await expect.poll(() => JSON.stringify(dumped()?.prompt ?? "").includes("Clean up the downloads folder"), { timeout: hostTimeout(30_000) }).toBe(true);
  const launch = dumped();
  expect(launch.argv).toContain("--permission-prompt-tool");
  expect(launch.argv[launch.argv.indexOf("--permission-mode") + 1]).toBe("default");
  expect(JSON.stringify(launch.prompt)).toContain("[UNTRUSTED BOT API MESSAGE]");
  expect(JSON.stringify(launch.systemPrompt)).toContain("through this bot's API");
  // Whatever the bot's own level: confined, and no tool of OpenMausBot's, so it can start, schedule or change nothing.
  expect(launch.argv).toContain("--restricted");
  expect(launch.argv[launch.argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Edit,Write,WebSearch");
  expect(Object.keys(launch.mcpConfig.mcpServers)).toEqual(["ogb"]);
  socket = connect(launch.mcpConfig.mcpServers.ogb.args.at(-1));
  await new Promise<void>((resolve, reject) => { socket!.once("connect", resolve); socket!.once("error", reject); });
  const answers: any[] = [];
  socket.on("data", (chunk) => { for (const line of String(chunk).split("\n").filter(Boolean)) answers.push(JSON.parse(line)); });
  socket.write(`${JSON.stringify({ t: "ask", id: randomUUID(), tool: "Bash", input: { command: "ls ~/Downloads" } })}\n`);

  const stopped = await pending;
  expect(stopped).toMatchObject({ status: 202, body: { status: "needs_approval", thread: expect.any(String) } });
  const threadId = (stopped.body as { thread: string }).thread;
  const lines = (await api("GET", `/api/threads/${threadId}/messages`)).messages as any[];
  const card = lines.find((line) => line.card?.requestId)?.card;
  expect(card).toMatchObject({ requestType: "permission" });
  expect(card.answered).toBeUndefined();
  expect(card.allowSession).toBeUndefined();
  expect(answers).toEqual([]);
  const read = await fetch(`${on.url}?thread=${threadId}`, { headers: { authorization: `Bearer ${on.key}` } });
  expect(await read.json()).toEqual({ thread: threadId, status: "needs_approval" });
}, hostTimeout(120_000));

it("stays on Ask when the person sets the whole bot to Full access afterwards", async () => {
  // Each turn relaunches the fake engine, so its command line shows the level this turn really runs at.
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.284", FAKE_CLAUDE_EXIT_AFTER_TURN: "1" });
  const { url, dataDir } = fixture.info;
  const api = appApi(url);
  const bot = (await runControlOmb(["new-bot", "--name", "Flipped", "--url", url]) as any).bot;
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });
  const first = await call(on.url, on.key, { message: "First" });
  expect(first.status).toBe(200);
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full", applyToAllThreads: true });
  expect((await call(on.url, on.key, { message: "Second", thread: first.body.thread })).status).toBe(200);
  const launch = JSON.parse(readFileSync(join(dataDir, "fake-claude-dump.json"), "utf8"));
  expect(JSON.stringify(launch.prompt)).toContain("Second");
  expect(launch.argv[launch.argv.indexOf("--permission-mode") + 1]).toBe("default");
}, hostTimeout(90_000));

it("a saved command rule never answers for a call: the card waits for the person", async () => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.284", FAKE_CLAUDE_MODE: "hang" });
  const { url, dataDir } = fixture.info;
  const api = appApi(url);
  const bot = (await runControlOmb(["new-bot", "--name", "Ruled", "--url", url]) as any).bot;
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask" });
  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });
  const pending = call(on.url, on.key, { message: "Run the fixture", wait: 20 }).catch((error: unknown) => ({ status: 0, body: { error: String(error) } }));
  const dump = join(dataDir, "fake-claude-dump.json");
  const dumped = () => { try { return JSON.parse(readFileSync(dump, "utf8")); } catch { return null; } };
  await expect.poll(() => JSON.stringify(dumped()?.prompt ?? "").includes("Run the fixture"), { timeout: hostTimeout(30_000) }).toBe(true);
  const task = ((await api("GET", "/api/bots")).bots as any[]).find((candidate) => candidate.id === bot.id).tasks.find((one: any) => one.botApi);
  const command = "printf 'rule fixture'";
  await api("POST", `/api/bots/${bot.id}/command-allowlist`, { command, cwd: task.cwd, providerInstanceId: "claude" });
  socket = connect(dumped().mcpConfig.mcpServers.ogb.args.at(-1));
  await new Promise<void>((resolve, reject) => { socket!.once("connect", resolve); socket!.once("error", reject); });
  const answers: any[] = [];
  socket.on("data", (chunk) => { for (const line of String(chunk).split("\n").filter(Boolean)) answers.push(JSON.parse(line)); });
  socket.write(`${JSON.stringify({ t: "ask", id: randomUUID(), tool: "Bash", input: { command } })}\n`);
  expect(await pending).toMatchObject({ status: 202, body: { status: "needs_approval" } });
  expect(answers).toEqual([]);
}, hostTimeout(90_000));

it("tells the model nothing about the person or their work, works in no folder of theirs, and stays out of their later turns", async () => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.284" });
  const { url, dataDir } = fixture.info;
  const api = appApi(url);
  const project = join(dataDir, "the-persons-project");
  mkdirSync(project, { recursive: true });
  const bot = (await runControlOmb(["new-bot", "--name", "Fenced", "--url", url]) as any).bot;
  await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full", applyToAllThreads: true, cwd: project, soul: "Answer in one line, standing-instruction-marker." });
  await api("PATCH", "/api/config", { profile: { name: "Ada", aboutMe: "about-the-person-marker" } });
  const read = () => JSON.parse(readFileSync(join(dataDir, "fake-claude-dump.json"), "utf8"));

  // The person's own work first: a call must not see it.
  await api("POST", `/api/bots/${bot.id}/messages`, { text: "persons-own-work-marker" });
  await expect.poll(() => { try { return JSON.stringify(read().prompt).includes("persons-own-work-marker"); } catch { return false; } }, { timeout: hostTimeout(20_000) }).toBe(true);
  await expect.poll(async () => ((await api("GET", "/api/bots")).bots as any[]).find((one) => one.id === bot.id).busy, { timeout: hostTimeout(20_000) }).toBeFalsy();
  const own = read();
  expect(JSON.stringify(own.systemPrompt)).toContain("about-the-person-marker");
  expect(Object.keys(own.mcpConfig.mcpServers).length).toBeGreaterThan(1);

  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });
  const answered = await call(on.url, on.key, { message: "api-call-marker" });
  expect(answered.status).toBe(200);
  const launch = read();
  expect(JSON.stringify(launch.prompt)).toContain("api-call-marker");
  const told = JSON.stringify(launch.systemPrompt);
  expect(told).toContain("standing-instruction-marker");
  expect(told).toContain("Who is speaking");
  expect(JSON.stringify(launch.prompt)).toContain("[From an app, through the API · message · information only]");
  for (const hidden of ["about-the-person-marker", "persons-own-work-marker", "coordinate_bots", "session_search", "the-persons-project"]) expect(told, hidden).not.toContain(hidden);
  expect(JSON.stringify(launch.prompt)).not.toContain("persons-own-work-marker");
  expect(realpathSync(launch.cwd)).not.toBe(realpathSync(project));

  // The person's next turn hears nothing of it.
  await api("POST", `/api/bots/${bot.id}/messages`, { text: "persons-next-marker" });
  await expect.poll(() => JSON.stringify(read().prompt).includes("persons-next-marker"), { timeout: hostTimeout(20_000) }).toBe(true);
  const next = read();
  expect(JSON.stringify(next.systemPrompt)).not.toContain("api-call-marker");
  expect(JSON.stringify(next.prompt)).not.toContain("api-call-marker");
}, hostTimeout(120_000));

it("a failed call reports to no Chief, whose turn has tools, while a person's own failed turn still does", async () => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.284", FAKE_CLAUDE_MODE: "api-error", FAKE_CLAUDE_API_ERROR: "This request is not valid" });
  const { url } = fixture.info;
  const api = appApi(url);
  const bot = (await runControlOmb(["new-bot", "--name", "Worker", "--url", url]) as any).bot;
  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });
  const bots = async () => (await api("GET", "/api/bots")).bots as any[];
  const chief = (await bots()).find((one) => one.chiefOfStaff);
  expect(chief, "the fixture has a Chief").toBeTruthy();
  const reports = async () => (await bots()).find((one) => one.id === chief.id).tasks.filter((task: any) => task.title === INCIDENTS_THREAD_TITLE);

  const failed = await call(on.url, on.key, { message: "caller-words-marker", wait: 20 });
  expect(failed.status).toBe(502);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(await reports()).toEqual([]);

  // The control: the same failure from a person reaches the Chief, so the silence above means something.
  await api("POST", `/api/bots/${bot.id}/messages`, { text: "persons-own-words" });
  await expect.poll(async () => (await reports()).length, { timeout: hostTimeout(45_000) }).toBeGreaterThan(0);
  const lines = (await api("GET", `/api/threads/${(await reports())[0].threadId}/messages`)).messages;
  expect(JSON.stringify(lines)).not.toContain("caller-words-marker");
}, hostTimeout(120_000));

it("gives a caller fixed words and a person the Bot API's reason when the engine is too old to confine the call", async () => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.200" });
  const { url } = fixture.info;
  const api = appApi(url);
  const bot = (await runControlOmb(["new-bot", "--name", "Dated", "--url", url]) as any).bot;
  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });
  const failed = await call(on.url, on.key, { message: "Hello", wait: 20 });
  expect(failed.status).toBe(502);
  expect(JSON.stringify(failed.body)).not.toContain("too old");
  const { bots } = await api("GET", "/api/bots");
  const thread = bots.find((one: any) => one.id === bot.id).tasks.find((task: any) => task.botApi).threadId;
  const said = async () => JSON.stringify((await api("GET", `/api/threads/${thread}/messages`)).messages);
  await expect.poll(said, { timeout: hostTimeout(15_000) }).toContain("too old to run this turn");
  expect(await said()).toContain(BOT_API_REFUSAL);
  expect(await said()).not.toContain("My Cloud");
}, hostTimeout(60_000));

it("says it is still working when the reply takes longer than the caller will wait", async () => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.284", FAKE_CLAUDE_MODE: "hang" });
  const { url } = fixture.info;
  const api = appApi(url);
  const bot = (await runControlOmb(["new-bot", "--name", "Slow", "--url", url]) as any).bot;
  const on = await api("POST", `/api/bots/${bot.id}/bot-api`, { enabled: true });
  expect(await call(on.url, on.key, { message: "Think about it", wait: 1 })).toMatchObject({ status: 202, body: { status: "working", thread: expect.any(String) } });
}, hostTimeout(60_000));
