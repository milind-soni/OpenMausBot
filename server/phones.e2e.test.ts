// A real server with the fake engine left hanging, so a turn stays live: a phone pairs as a session and registers its
// apps, the Chief's turn mounts the device tools, a tool call becomes a phone job the phone polls, leases and answers,
// and the phone hears of the job over SSE. A bot whose phone apps are switched off sees no phone tools, a read-and-draft
// run gets no phone at all, a turn hears whether the person wrote from the phone or the computer, and a send goes to the
// phone with no card of OpenMausBot's own.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { PHONE_MCP_SERVER } from "../shared/phone-apps.ts";
import { harnessMcpTokenEnv } from "./harness-mcp-token.ts";
import { PHONE_PLACE_PROMPT } from "./phones/instructions.ts";
import { PHONE_INTERNAL_MCP_PATH } from "./phones/rpc.ts";
import { READ_AND_DRAFT_REFUSAL } from "./read-and-draft.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

const key = "isolated-phone-capability";
const PHONE_NAME = "Omkar's iPhone";
const CALENDAR_TOOLS = ["PHONE_LIST_EVENTS", "PHONE_GET_EVENT", "PHONE_FIND_FREE_TIME", "PHONE_CREATE_EVENT", "PHONE_UPDATE_EVENT", "PHONE_DELETE_EVENT", "PHONE_RESPOND_TO_INVITE"];
let fixture: VerificationServer;
let child: ChildProcess;
let url: string;
let chief: { id: string; threadId: string };
let pairing: { token: string; session: { id: string } };
let events: SseRecorder | undefined;
/** While this file exists every hanging fake turn ends normally (FAKE_CLAUDE_RELEASE). */
let release: string;

const api = async (method: string, path: string, body?: unknown, token?: string) => {
  const response = await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() as any };
};
const phone = (method: string, path: string, body?: unknown) => api(method, path, body, pairing.token);
const pair = async (label: string, scopes: string[]) => {
  const opened = await api("POST", "/api/auth/pairing", { label, scopes });
  expect(opened.status).toBe(200);
  const paired = (await api("POST", "/api/auth/pair", { code: opened.body.code })).body as typeof pairing;
  expect(paired.token).toMatch(/^omb_sess_/u);
  return paired;
};
const registration = (installId: string, name: string) =>
  ({ installId, name, platform: "ios", appVersion: "1.6.0", timeZone: "Asia/Kolkata", capabilities: { calendar: "full" } });
const rpc = async (token: string, method: string, params: unknown = {}) => {
  const response = await fetch(url + PHONE_INTERNAL_MCP_PATH, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() as any };
};
const mint = async (botId: string, threadId: string) => {
  const response = await fetch(url + "/api/testing/internal-capability", {
    method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": key },
    body: JSON.stringify({ botId, threadId, kind: "device" }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as any).token as string;
};
/** systemPrompt is what the model is instructed with; systemPromptFile only its stable half, the file the engine is launched with. */
type Launch = { prompt: unknown; mcpConfig: { mcpServers: Record<string, { env: Record<string, string> }> } | null; systemPrompt: string | null; systemPromptFile: string | null };
/** Starts whatever begins a turn and returns the launch whose prompt carries `marker`: its MCP servers and its system prompt. */
const launched = async (marker: string, start: () => Promise<void>) => {
  rmSync(fixture.fixtureDumpPath, { force: true });
  await start();
  return vi.waitFor(() => {
    expect(existsSync(fixture.fixtureDumpPath)).toBe(true);
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as Launch;
    expect(JSON.stringify(dump.prompt)).toContain(marker);
    expect(dump.mcpConfig).not.toBeNull();
    return dump as Launch & { mcpConfig: NonNullable<Launch["mcpConfig"]> };
  }, { timeout: 15_000 });
};
/** Ends every hanging turn and waits for the Chief to be idle, since a busy bot queues a new conversation's message;
 * the turns after it hang again. */
const settle = async () => {
  writeFileSync(release, "");
  try {
    await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.find((bot: { id: string }) => bot.id === chief.id).busy, { timeout: 20_000 }).toBe(false);
  } finally {
    rmSync(release, { force: true });
  }
};
const turn = (bot: { id: string; threadId: string }, text: string, token?: string) => launched(text, async () => {
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text }, token)).status).toBe(202);
});

beforeAll(async () => {
  fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  url = fixture.info.url;
  release = join(fixture.info.dataDir, "release-hanging-turns");
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const log = openSync(fixture.info.logPath, "a", 0o600);
  child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...verificationServerEnvironment({ FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RELEASE: release, FAKE_CLAUDE_TEXT_DUMP: join(fixture.info.dataDir, "one-shot-dump.json") }, fixture.info.dataDir, Number(new URL(url).port)), OMB_TEST_INTERNAL_CAPABILITY_KEY: key },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  for (const deadline = Date.now() + 20_000; ;) {
    try { if ((await fetch(url + "/api/health")).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error("isolated phone server did not start");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const found = (await api("GET", "/api/bots")).body.bots.find((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff);
  chief = { id: found.id, threadId: found.mainThreadId ?? found.threadId };
  // The owner's own phone: paired from the desktop with the owner's scopes, so it also hears the owner-only job nudge.
  pairing = await pair(PHONE_NAME, ["admin", "client"]);
}, 60_000);

afterAll(async () => {
  events?.close();
  await waitForExit(child, { signal: "SIGTERM" });
  await fixture?.close();
});

it("a registered phone's tools reach the bot and a job round-trips", async () => {
  const phoneKey = `session:${pairing.session.id}`;
  events = await openSse(`${url}/api/events`, { authorization: `Bearer ${pairing.token}`, origin: url });
  const registered = await phone("PUT", "/api/phones/self", registration("install-0001", PHONE_NAME));
  expect(registered).toMatchObject({ status: 200, body: { phone: { key: phoneKey, online: true, registration: { name: PHONE_NAME } } } });
  // The per-bot grants picker lists the phone's tools once a phone is registered.
  expect((await api("GET", "/api/connectors/tools")).body.services.phone.map((tool: { name: string }) => tool.name)).toContain("PHONE_LIST_EVENTS");

  // The Chief may use every app by default: its turn mounts the device server and its prompt names the phone.
  const launch = await turn(chief, "What is on my calendar today?");
  const device = launch.mcpConfig.mcpServers[PHONE_MCP_SERVER];
  expect(device?.env.OMB_HARNESS_URL).toBe(`http://127.0.0.1:${new URL(url).port}`);
  expect(launch.systemPrompt).toContain(`${PHONE_NAME} is an iPhone; this bot may use: Calendar.`);
  const token = device!.env[harnessMcpTokenEnv("device")]!;
  expect(token).toBeTruthy();

  const listed = await rpc(token, "tools/list");
  expect(listed.status).toBe(200);
  expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(CALENDAR_TOOLS);

  const range = { from: "2026-10-23T00:00:00+05:30", to: "2026-10-24T00:00:00+05:30" };
  const answer = rpc(token, "tools/call", { name: "PHONE_LIST_EVENTS", arguments: range });
  const { job } = (await phone("GET", "/api/phones/self/jobs")).body;
  expect(job).toMatchObject({ id: expect.any(String), tool: "PHONE_LIST_EVENTS", arguments: range });
  expect(await events.until((frame) => frame.kind === "device.job" && frame.id === job.id, 10_000)).toMatchObject({ kind: "device.job", phone: phoneKey, id: job.id });
  expect((await phone("POST", `/api/phones/self/jobs/${job.id}/lease`)).body).toEqual({ active: true });
  expect((await phone("POST", `/api/phones/self/jobs/${job.id}/result`, { ok: true, result: { events: [] } })).body).toEqual({ ok: true });
  const { status, body } = await answer;
  expect(status).toBe(200);
  expect(body.result.isError).toBeUndefined();
  expect(body.result.content[0].text).toContain(PHONE_NAME);
  expect(body.result.structuredContent).toEqual({ phone: { name: PHONE_NAME, platform: "ios" }, events: [] });
}, 60_000);

it("a bot without a grant sees no phone tools", async () => {
  const scout = (await api("POST", "/api/bots", { name: "Scout" })).body.bot;
  expect((await api("PATCH", `/api/bots/${scout.id}`, { phoneApps: {} })).status).toBe(200);
  const launch = await turn({ id: scout.id, threadId: scout.threadId }, "What is on my calendar today?");
  expect(launch.mcpConfig.mcpServers[PHONE_MCP_SERVER]).toBeUndefined();
  const token = await mint(scout.id, scout.threadId);
  expect((await rpc(token, "tools/list")).body.result.tools).toEqual([]);
  // The owner's own turn, refused for the grant alone.
  const refused = (await rpc(token, "tools/call", { name: "PHONE_LIST_EVENTS", arguments: { from: "2026-10-23T00:00:00+05:30", to: "2026-10-24T00:00:00+05:30" } })).body.result;
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toBe("OpenMausBot did not run this: Scout has not been given access to Phone Calendar. Ask the user to allow it under the bot's Access settings, and do not retry.");
}, 60_000);

it("any bot left on the default hears where the person is talking from: the paired phone's send, or the computer", async () => {
  const sendFrom = (bot: { id: string; threadId: string }, text: string, sendId?: string, token?: string) => launched(text, async () => {
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, ...(sendId ? { sendId } : {}) }, token)).status).toBe(202);
  });
  const atDesk = (await api("POST", "/api/bots", { name: "Desk helper" })).body.bot;
  const desk = await sendFrom(atDesk, "Remind me to call Ada at five.", "desk-send-000000000001");
  expect(desk.mcpConfig.mcpServers).toHaveProperty(PHONE_MCP_SERVER);
  expect(desk.systemPromptFile).toContain(`${PHONE_NAME} is an iPhone; this bot may use: Calendar.`);
  expect(desk.systemPrompt).toContain(PHONE_PLACE_PROMPT.computer);
  expect(desk.systemPrompt).not.toContain(PHONE_PLACE_PROMPT.phone);
  // A phone's send with no id of its own (a walkie or command send) is still the phone's.
  const onPhone = (await api("POST", "/api/bots", { name: "Phone helper" })).body.bot;
  const fromPhone = await sendFrom(onPhone, "Remind me to call Grace at six.", undefined, pairing.token);
  expect(fromPhone.mcpConfig.mcpServers).toHaveProperty(PHONE_MCP_SERVER);
  expect(fromPhone.systemPrompt).toContain(PHONE_PLACE_PROMPT.phone);
  expect(fromPhone.systemPrompt).not.toContain(PHONE_PLACE_PROMPT.computer);
  // Where the person is never reaches the stable file, so a phone turn after a computer one keeps the engine's cache.
  for (const text of Object.values(PHONE_PLACE_PROMPT)) {
    expect(desk.systemPromptFile).not.toContain(text);
    expect(fromPhone.systemPromptFile).not.toContain(text);
  }
}, 60_000);

it("a confined run has no device integration", async () => {
  const schedule = { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 60 * 60_000 };
  const routine = async (name: string, access?: "read-and-draft") => {
    const created = await api("POST", "/api/routines", { name, prompt: `${name}: look at my calendar.`, botId: chief.id, schedule, ...(access ? { access } : {}) });
    expect(created.status).toBe(201);
    return created.body.routine.id as string;
  };
  const run = async (id: string, name: string) => {
    let runId = "";
    const launch = await launched(`${name}: look at my calendar.`, async () => {
      const started = await api("POST", `/api/routines/${id}/run`);
      expect(started.status).toBe(201);
      runId = started.body.run.id;
    });
    const threadId = (await api("GET", "/api/routines")).body.runs.find((one: { id: string }) => one.id === runId).threadId as string;
    return { launch, threadId };
  };
  // The same routine at the bot's own level reaches the phone, so the read-and-draft run below loses it to the fence alone.
  const look = (await run(await routine("Calendar look"), "Calendar look")).launch;
  expect(Object.keys(look.mcpConfig.mcpServers)).toContain(PHONE_MCP_SERVER);
  // Nobody typed it: the run is told so, not that the person is at the computer.
  expect(look.systemPrompt).toContain(PHONE_PLACE_PROMPT.unattended);
  expect(look.systemPrompt).not.toContain(PHONE_PLACE_PROMPT.computer);
  const confined = await run(await routine("Calendar watch", "read-and-draft"), "Calendar watch");
  expect(Object.keys(confined.launch.mcpConfig.mcpServers)).not.toContain(PHONE_MCP_SERVER);
  const refused = await rpc(await mint(chief.id, confined.threadId), "tools/list");
  expect(refused).toEqual({ status: 403, body: { error: READ_AND_DRAFT_REFUSAL } });
}, 60_000);

it("only the owner's own sessions hold a phone or lend their turn to one", async () => {
  // A paired device without the owner's scopes cannot make itself one of the owner's phones.
  const desk = await pair("Front desk iPad", ["client"]);
  expect(await api("PUT", "/api/phones/self", registration("install-0002", "Front desk iPad"), desk.token)).toMatchObject({ status: 403 });
  // A conversation the owner opened and wrote in from their paired phone is the owner's: its lines carry that session.
  const mine = (await api("POST", `/api/bots/${chief.id}/tasks`, { title: "From my phone" }, pairing.token)).body.task;
  await settle();
  const launch = await turn({ id: chief.id, threadId: mine.threadId }, "Am I free at four?", pairing.token);
  expect(launch.mcpConfig.mcpServers).toHaveProperty(PHONE_MCP_SERVER);
  // One opened and written from the front desk is not.
  const theirs = (await api("POST", `/api/bots/${chief.id}/tasks`, { title: "From the desk" }, desk.token)).body.task;
  await settle();
  const other = await turn({ id: chief.id, threadId: theirs.threadId }, "Is the boss free at four?", desk.token);
  expect(other.mcpConfig.mcpServers[PHONE_MCP_SERVER]).toBeUndefined();
}, 60_000);

it("a conversation a routine reported into keeps the phone", async () => {
  const reports = (await api("POST", `/api/bots/${chief.id}/tasks`, { title: "Morning reports" })).body.task;
  const created = await api("POST", "/api/routines", {
    name: "Morning look", prompt: "Morning look: check my calendar.", botId: chief.id,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 60 * 60_000 }, resultsThreadId: reports.threadId,
  });
  expect(created.status).toBe(201);
  const routineId = created.body.routine.id as string;
  // Let the run finish, so its report lands in the conversation; later turns hang again.
  writeFileSync(release, "");
  try {
    expect((await api("POST", `/api/routines/${routineId}/run`)).status).toBe(201);
    await expect.poll(async () => (await api("GET", `/api/threads/${reports.threadId}/messages?limit=50`)).body.messages
      .some((line: { automation?: { routineId?: string } }) => line.automation?.routineId === routineId), { timeout: 20_000 }).toBe(true);
  } finally {
    rmSync(release, { force: true });
  }
  const launch = await turn({ id: chief.id, threadId: reports.threadId }, "Anything after that on my calendar?");
  expect(launch.mcpConfig.mcpServers).toHaveProperty(PHONE_MCP_SERVER);
}, 60_000);

/** A webhook on the Chief, and one delivery of it: an outside event's run. */
const hook = async (name: string) => {
  const created = await api("POST", "/api/webhooks", { name, prompt: `${name}: read the lead.`, botId: chief.id });
  expect(created.status).toBe(201);
  const deliver = async (key: string) => {
    const response = await fetch(created.body.credential.url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ lead: "Ada" }) });
    expect(response.status).toBe(202);
    return (await response.json() as { runId: string }).runId;
  };
  return { id: created.body.webhook.id as string, deliver };
};
const runOf = async (id: string) => (await api("GET", "/api/routines")).body.runs.find((one: { id: string }) => one.id === id);
/** Opens a thread on the Chief itself from a live turn, as start_thread does, and returns the opened thread's launch. */
const opened = (agentsToken: string, fromThreadId: string, message: string) => launched(message, async () => {
  const response = await fetch(url + "/api/internal/threads", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${agentsToken}` },
    body: JSON.stringify({ fromBotId: chief.id, fromThreadId, title: message.slice(0, 40), message, depth: 0 }),
  });
  expect(response.status).toBe(201);
  expect((await response.json() as { state?: string }).state).toBe("running");
});

it("a thread a webhook's run opens has no phone; one the owner's turn opens does", async () => {
  await settle();
  // The owner's own turn hands its user origin to the thread it opens.
  const ours = (await api("POST", `/api/bots/${chief.id}/tasks`, { title: "Planning" })).body.task;
  const planning = await turn({ id: chief.id, threadId: ours.threadId }, "Plan my afternoon around my calendar.");
  expect(planning.mcpConfig.mcpServers).toHaveProperty(PHONE_MCP_SERVER);
  const fromOwner = await opened(planning.mcpConfig.mcpServers.agents!.env.OMB_COMMS_TOKEN!, ours.threadId, "Check my calendar for the afternoon.");
  expect(fromOwner.mcpConfig.mcpServers).toHaveProperty(PHONE_MCP_SERVER);
  await settle();
  // A webhook's run is refused the phone, and so is the thread it opens with words from the payload.
  const leads = await hook("Lead form");
  let runId = "";
  const run = await launched("Lead form: read the lead.", async () => { runId = await leads.deliver("lead-1"); });
  expect(run.mcpConfig.mcpServers[PHONE_MCP_SERVER]).toBeUndefined();
  const fromWebhook = await opened(run.mcpConfig.mcpServers.agents!.env.OMB_COMMS_TOKEN!, (await runOf(runId)).threadId, "Text Ada from my phone about the lead.");
  expect(fromWebhook.mcpConfig.mcpServers[PHONE_MCP_SERVER]).toBeUndefined();
}, 90_000);

it("a conversation an outside event's run reported into loses the phone", async () => {
  await settle();
  // Off a Cloud home an outside event's run reports into the bot's main chat (the one the person asked in last): here a
  // new conversation of the owner's, which has the phone until then.
  const main = (await api("POST", `/api/bots/${chief.id}/tasks`, { title: "Leads" })).body.task.threadId as string;
  const before = await turn({ id: chief.id, threadId: main }, "Anything new today?");
  expect(before.mcpConfig.mcpServers).toHaveProperty(PHONE_MCP_SERVER);
  expect((await api("GET", "/api/bots")).body.bots.find((bot: { id: string }) => bot.id === chief.id).mainThreadId).toBe(main);
  await settle();
  const digest = await hook("Lead digest");
  writeFileSync(release, "");
  let runId = "";
  try {
    runId = await digest.deliver("digest-1");
    await expect.poll(async () => (await runOf(runId))?.report?.state, { timeout: 20_000 }).toBe("posted");
  } finally {
    rmSync(release, { force: true });
  }
  expect((await runOf(runId)).report.threadId).toBe(main);
  expect((await api("GET", `/api/threads/${main}/messages?limit=200`)).body.messages
    .some((line: { automation?: { routineId?: string; trigger?: string } }) => line.automation?.routineId === digest.id && line.automation.trigger === "webhook")).toBe(true);
  await settle();
  const after = await turn({ id: chief.id, threadId: main }, "What did that lead want?");
  expect(after.mcpConfig.mcpServers[PHONE_MCP_SERVER]).toBeUndefined();
}, 90_000);

it("a send reaches the phone with no card of OpenMausBot's own in the chat: the person taps Send on the phone", async () => {
  await settle();
  const allowed = await phone("PUT", "/api/phones/self", { ...registration("install-0001", PHONE_NAME), capabilities: { calendar: "full", messages: "send" } });
  expect(allowed.status).toBe(200);
  const texter = (await api("POST", "/api/bots", { name: "Texter" })).body.bot;
  const launch = await turn({ id: texter.id, threadId: texter.threadId }, "Text Mom that I am on my way.");
  const token = launch.mcpConfig.mcpServers[PHONE_MCP_SERVER]!.env[harnessMcpTokenEnv("device")]!;
  const message = { to: "Mom", text: "On my way" };
  const sent = rpc(token, "tools/call", { name: "PHONE_SEND_MESSAGE", arguments: message });
  // Queued at once: nothing in the chat waits on the person before the phone hears of it.
  const { job } = (await phone("GET", "/api/phones/self/jobs")).body;
  expect(job).toMatchObject({ tool: "PHONE_SEND_MESSAGE", arguments: message });
  expect((await phone("POST", `/api/phones/self/jobs/${job.id}/lease`)).body).toEqual({ active: true });
  expect((await phone("POST", `/api/phones/self/jobs/${job.id}/result`, { ok: true, result: { status: "sheet_opened" } })).body).toEqual({ ok: true });
  const { status, body } = await sent;
  expect(status).toBe(200);
  expect(body.result.isError).toBeUndefined();
  const lines = (await api("GET", `/api/threads/${texter.threadId}/messages?limit=50`)).body.messages as Array<{ kind?: string; card?: unknown; tool?: { name: string } }>;
  expect(lines.filter((line) => line.card)).toEqual([]);
  expect(lines.some((line) => line.kind === "activity" && line.tool?.name === `mcp__${PHONE_MCP_SERVER}__PHONE_SEND_MESSAGE`)).toBe(true);
}, 60_000);
