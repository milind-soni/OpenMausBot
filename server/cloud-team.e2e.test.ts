// A real Team Cloud (OMB_CLOUD_ROLE=team) beside the cloud fixture's two servers: three people paired with the Admin's
// signed member claims, the audience rule on chats, memory, recall and files, the team's connected apps, and a My Cloud
// that refuses a team claim. The engine is the synthetic Claude CLI, so this proves the plumbing, not a model's judgement.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { TEAM_SESSION_MAX_MS } from "./cloud-team.ts";
import { personKey } from "./person-key.ts";
import { startBrokerFake, type BrokerFake } from "./testing/broker-fake.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const TOKEN = `ops_fake-team-${randomBytes(8).toString("hex")}`;
const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ben@acme.test", role: "admin" as const };
const MEMBER_A = { email: "ada@acme.test", role: "member" as const };
const MEMBER_C = { email: "cleo@acme.test", role: "member" as const };
const ENGINE = `import { readFileSync as readToolCalls } from "node:fs";
process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
try { process.env.FAKE_CLAUDE_TOOL_CALLS = readToolCalls(process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json", "utf8"); } catch {}`;

let fx: CloudSendFixture, team: CloudTeamFixture, broker: BrokerFake;
let owner = "", admin = "", ada = "", cleo = "";
let bot: { id: string; mainThreadId: string };
const adaKey = personKey({ id: "", email: MEMBER_A.email }), benKey = personKey({ id: "", email: ADMIN.email });

beforeAll(async () => {
  broker = await startBrokerFake();
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, broker, team: { id: "team-acme-1", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  ada = (await team.pair(MEMBER_A)).token!;
  cleo = (await team.pair(MEMBER_C)).token!;
  const created = await team.as(owner, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  bot = created.body.bot;
}, hostTimeout(120_000));

afterAll(async () => {
  await fx?.close();
  await broker?.close();
});

const dump = () => JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as { systemPrompt: string; prompt: unknown; mcpConfig: { mcpServers: Record<string, unknown> } };
const scriptToolCalls = (calls: unknown[] | null) => {
  const file = join(team.home, "tool-calls.json");
  if (calls) writeFileSync(file, JSON.stringify(calls)); else rmSync(file, { force: true });
};
const ws = (id: string, ...rest: string[]) => join(team.home, ".openmausbot", "workspaces", id, ...rest);
const layerOf = (audience: string) => `${bot.id}--${audience}`;
const messages = async (token: string, threadId: string) => team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`);
const idle = async (token: string) => ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ id: string; activity?: string; busy?: boolean }>)
  .every((entry) => entry.activity !== "working" && !entry.busy);
async function turn(token: string, threadId: string, text: string, room?: string) {
  rmSync(join(team.home, "dump.json"), { force: true });
  const before = ((await messages(token, threadId)).body.messages as unknown[]).length;
  const sent = room
    ? await team.as(token, "POST", `/api/groups/${room}/messages`, { text, ...(threadId ? { threadId } : {}) })
    : await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await expect.poll(async () => await idle(token) && ((await messages(token, threadId)).body.messages as Array<{ role: string; kind: string }>).length >= before + 2 && existsSync(join(team.home, "dump.json")),
    { timeout: 60_000, interval: 100 }).toBe(true);
  return dump();
}
const newThread = async (token: string, title: string) => {
  const created = await team.as(token, "POST", `/api/bots/${bot.id}/tasks`, { title });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.task.threadId as string;
};

it("pairs three people with the Admin's signed claims, each with their role, and refuses a forged, missing or foreign claim", async () => {
  const session = async (token: string) => (await team.as(token, "GET", "/api/auth/session")).body;
  expect(await session(owner)).toMatchObject({ kind: "session", scopes: ["admin", "client"], email: OWNER.email, team: { id: "team-acme-1", name: "Acme", role: "owner" }, cloudHome: true });
  expect(await session(admin)).toMatchObject({ scopes: ["admin", "client"], team: { role: "admin" } });
  const adas = await session(ada);
  expect(adas).toMatchObject({ scopes: ["client"], email: MEMBER_A.email, team: { role: "member" } });
  expect(adas.cloudGuest).toBeUndefined();
  // Membership lives on the Admin and is checked at each pairing: a team session ends within the hour, then the app pairs again.
  expect(adas.expiresAt - Date.now()).toBeLessThanOrEqual(TEAM_SESSION_MAX_MS);
  expect(adas.expiresAt - Date.now()).toBeGreaterThan(TEAM_SESSION_MAX_MS - 60_000);

  expect(await team.pair(null)).toMatchObject({ status: 400, body: { error: "member_required" } });
  expect(await team.pair({ email: "x@acme.test", role: "superuser" as never })).toMatchObject({ status: 400, body: { error: "invalid_member" } });
  expect(await team.pair(MEMBER_A, { body: { team: { id: "another-team" }, member: MEMBER_A } })).toMatchObject({ status: 400, body: { error: "team_mismatch" } });
  // A forged claim: signed with a key that is not this machine's.
  expect((await team.pair(OWNER, { secret: "W".repeat(43) })).status).toBe(401);
  // The app says what the server is called, and the server is the team.
  expect((await team.pair(MEMBER_C)).body.environment.label).toBe("Acme");
  expect((await team.as(ada, "GET", "/api/config")).body.team).toEqual({ id: "team-acme-1", name: "Acme", cloudPage: "https://cloud.example.test/cloud" });
  // My Cloud, beside it, is one person's: it refuses a team claim (cloud-home.test.ts) and its owner paired as before.
  expect((await fx.onCloud("GET", "/api/auth/session")).body).toMatchObject({ kind: "session", scopes: ["admin", "client"], cloudHome: true });
  expect((await fx.onCloud("GET", "/api/auth/session")).body.team).toBeUndefined();
}, hostTimeout(60_000));

it("keeps every member's session across a restart, never sleeps, and exports for the Owner only", async () => {
  await team.relaunch();
  expect((await team.as(ada, "GET", "/api/auth/session")).status).toBe(200);
  expect((await team.as(cleo, "GET", "/api/auth/session")).status).toBe(200);
  expect((await team.as(owner, "GET", "/api/auth/session")).status).toBe(200);
  const sleep = await team.signed("POST", "/api/cloud/power/sleep", {});
  expect(sleep.status, JSON.stringify(sleep.body)).toBe(409);
  expect(sleep.body.busy).toContain("team");
  expect((await team.signed("GET", "/api/cloud/power")).status).toBe(200);
  expect((await team.signed("GET", "/api/cloud/health")).status).toBe(200);
  // A member reaches nothing an admin does: the team's setup is the admins'.
  expect((await team.as(ada, "POST", "/api/bots", { name: "Nope" })).status).toBe(403);
}, hostTimeout(90_000));

let adaThread = "", roomId = "", roomThread = "";

it("a member's private chat with a team bot reads her notes and the team's, never another member's; she alone sees it", async () => {
  // The team's layer is the bot's own folder; Ben's private layer is a sibling folder of his own.
  mkdirSync(ws(bot.id, "memory"), { recursive: true });
  writeFileSync(ws(bot.id, "MEMORY.md"), "# Memory\n\n- The office plant is called Fernando (team)\n");
  mkdirSync(ws(layerOf(`member-${benKey}`), "memory"), { recursive: true });
  writeFileSync(ws(layerOf(`member-${benKey}`), "MEMORY.md"), "# Memory\n\n- Ben's badge code is 4471\n");
  adaThread = await newThread(ada, "Ada and Scout");
  scriptToolCalls([{ name: "memory_update", server: "agents", input: { action: "append", text: "Ada prefers oolong tea" } }]);
  const seen = await turn(ada, adaThread, "My cat is called Kumquat.");
  expect(seen.systemPrompt).toContain("Fernando");
  expect(seen.systemPrompt).not.toContain("4471");
  // Named as the prompt quotes a path (workspace.ts, JSON.stringify): Windows' backslashes come doubled.
  expect(seen.systemPrompt).toContain(JSON.stringify(ws(layerOf(`member-${adaKey}`), "MEMORY.md")));
  // Her note landed in her own layer, not the team's.
  expect(readFileSync(ws(layerOf(`member-${adaKey}`), "MEMORY.md"), "utf8")).toContain("oolong");
  expect(readFileSync(ws(bot.id, "MEMORY.md"), "utf8")).not.toContain("oolong");
  // Neither Ben (Admin), the Owner nor Cleo (Member) sees the conversation or its words.
  expect((await messages(admin, adaThread)).status).toBe(404);
  expect((await messages(owner, adaThread)).status).toBe(404);
  expect((await messages(cleo, adaThread)).status).toBe(404);
  const cleoBots = (await team.as(cleo, "GET", "/api/bots")).body.bots as Array<{ id: string; tasks: Array<{ threadId: string }> }>;
  expect(cleoBots.find((entry) => entry.id === bot.id)!.tasks.map((task) => task.threadId)).not.toContain(adaThread);
  const adaBots = (await team.as(ada, "GET", "/api/bots")).body.bots as Array<{ id: string; tasks: Array<{ threadId: string; private?: true }> }>;
  const adaTasks = adaBots.find((entry) => entry.id === bot.id)!.tasks;
  expect(adaTasks.map((task) => task.threadId)).toContain(adaThread);
  // The app's "Private · only you" header reads this: her conversation is private, the bot's main chat is the team's.
  expect(adaTasks.find((task) => task.threadId === adaThread)!.private).toBe(true);
  expect(adaTasks.find((task) => task.threadId === bot.mainThreadId)?.private).toBeUndefined();
  expect(JSON.stringify((await team.as(cleo, "GET", "/api/search?q=Kumquat")).body)).not.toContain(adaThread);
  expect(JSON.stringify((await team.as(ada, "GET", "/api/search?q=Kumquat")).body)).toContain(adaThread);
  // Only she changes what she started.
  expect((await team.as(cleo, "PATCH", `/api/bots/${bot.id}/tasks/${adaThread}`, { title: "x" })).status).not.toBe(200);
  expect((await team.as(ada, "PATCH", `/api/bots/${bot.id}/tasks/${adaThread}`, { title: "Ada and Scout" })).status).toBe(200);
  expect((await team.as(admin, "PATCH", `/api/bots/${bot.id}/tasks/${adaThread}`, { title: "Ada and Scout" })).status).toBe(404);
}, hostTimeout(120_000));

it("a room's turn reads the room's layer and the team's, never a member's notes, and both members see its answer", async () => {
  const created = await team.as(owner, "POST", "/api/groups", { name: "Launch", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  roomId = created.body.group.id; roomThread = created.body.group.threadId;
  scriptToolCalls([{ name: "memory_update", server: "agents", input: { action: "append", text: "Room decision: launch on Tuesday" } }]);
  const seen = await turn(ada, roomThread, "@Scout when do we launch?", roomId);
  expect(seen.systemPrompt).toContain("Fernando");
  expect(seen.systemPrompt).not.toContain("oolong");
  expect(seen.systemPrompt).not.toContain("4471");
  expect(readFileSync(ws(layerOf(`room-${roomId}`), "MEMORY.md"), "utf8")).toContain("Tuesday");
  expect(readFileSync(ws(layerOf(`member-${adaKey}`), "MEMORY.md"), "utf8")).not.toContain("Tuesday");
  expect(readFileSync(ws(bot.id, "MEMORY.md"), "utf8")).not.toContain("Tuesday");
  for (const token of [ada, admin, cleo]) expect(JSON.stringify((await messages(token, roomThread)).body)).toContain("when do we launch");
  // Ben writes in the room too, and Ada sees his line.
  scriptToolCalls(null);
  await turn(admin, roomThread, "@Scout Ben says Wednesday.", roomId);
  expect(JSON.stringify((await messages(ada, roomThread)).body)).toContain("Ben says Wednesday");
}, hostTimeout(120_000));

it("a room's bot reply is unread for each person until they read it, and one person reading clears it for nobody else", async () => {
  const room = async (token: string) => ((await team.as(token, "GET", "/api/bots")).body.groups as Array<{ id: string; unread?: boolean; lastReadMessageId?: string }>)
    .find((group) => group.id === roomId)!;
  for (const token of [ada, admin, cleo]) expect((await room(token)).unread).toBe(true);
  const read = await team.as(ada, "POST", `/api/groups/${roomId}/read`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect(read.body.group.unread).toBe(false);
  expect((await room(ada)).unread).toBe(false);
  for (const token of [admin, cleo]) expect((await room(token)).unread, "Ada reading is Ada's alone").toBe(true);
  await turn(admin, roomThread, "@Scout and Friday?", roomId);
  expect((await room(ada)).unread, "the bot's next reply is new to Ada").toBe(true);
  const marked = await team.as(ada, "PATCH", `/api/groups/${roomId}`, { unread: false });
  expect(marked.status, JSON.stringify(marked.body)).toBe(200);
  expect(marked.body.group.unread).toBe(false);
  expect((await room(ada)).unread, "marking a room read is reading it").toBe(false);
  expect((await room(cleo)).unread, "Ada marking it read is Ada's alone").toBe(true);
  expect((await team.as(ada, "PATCH", `/api/groups/${roomId}`, { unread: true })).body.group.unread).toBe(true);
  expect((await room(ada)).unread).toBe(true);
  expect((await team.as(cleo, "POST", `/api/groups/${roomId}/read`)).body.group.unread).toBe(false);
  expect((await room(ada)).unread, "Cleo reading leaves Ada's mark").toBe(true);
}, hostTimeout(120_000));

it("sends a person's read of a room to their own streams only", async () => {
  const listen = async (token: string) => {
    const controller = new AbortController();
    const stream = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const done = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; text += decoder.decode(value, { stream: true }); } })().catch(() => {});
    const rooms = () => text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as { kind: string; group?: { id: string } })
      .filter((frame) => frame.kind === "group" && frame.group?.id === roomId);
    await expect.poll(() => text.includes("\"hello\""), { timeout: 10_000 }).toBe(true);
    return { rooms, close: async () => { controller.abort(); await done; } };
  };
  const adas = await listen(ada), cleos = await listen(cleo);
  try {
    expect((await team.as(ada, "POST", `/api/groups/${roomId}/read`)).status).toBe(200);
    expect((await team.as(cleo, "POST", `/api/groups/${roomId}/read`)).status).toBe(200);
    expect((await team.as(ada, "POST", `/api/groups/${roomId}/read`)).status).toBe(200);
    await expect.poll(() => adas.rooms().length, { timeout: 10_000 }).toBe(2);
    await expect.poll(() => cleos.rooms().length, { timeout: 10_000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect([adas.rooms().length, cleos.rooms().length], "nobody else's read reaches a stream").toEqual([2, 1]);
  } finally {
    await adas.close();
    await cleos.close();
  }
}, hostTimeout(60_000));

it("recall never crosses: a room's fact never surfaces in a private chat and a private chat's never in the room", async () => {
  const search = async (threadId: string, q: string) => {
    const token = await team.capability(bot.id, threadId);
    // A bot's tools call the harness over loopback, with the turn's own bearer.
    const answer = await fetch(`${team.base}/api/internal/session-search?fromBotId=${bot.id}&q=${encodeURIComponent(q)}`, { headers: { authorization: `Bearer ${token}` } });
    expect(answer.status).toBe(200);
    return await answer.json() as { hits: Array<{ threadId: string }>; memoryHits: Array<{ snippet: string; file: string }> };
  };
  const fromAda = await search(adaThread, "Tuesday launch");
  expect(fromAda.memoryHits.map((hit) => hit.snippet).join("\n")).not.toContain("Tuesday");
  expect(fromAda.hits.map((hit) => hit.threadId)).not.toContain(roomThread);
  const fromRoom = await search(roomThread, "oolong tea");
  expect(fromRoom.memoryHits.map((hit) => hit.snippet).join("\n")).not.toContain("oolong");
  expect(fromRoom.hits.map((hit) => hit.threadId)).not.toContain(adaThread);
  // The team's fact reaches both.
  expect((await search(adaThread, "Fernando plant")).memoryHits.map((hit) => hit.snippet).join("\n")).toContain("Fernando");
  expect((await search(roomThread, "Fernando plant")).memoryHits.map((hit) => hit.snippet).join("\n")).toContain("Fernando");
  // list_threads names only the conversations a turn may read: a title is words too.
  const listed = async (threadId: string) => {
    const token = await team.capability(bot.id, threadId);
    const answer = await fetch(`${team.base}/api/internal/threads?fromBotId=${bot.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(answer.status).toBe(200);
    return ((await answer.json()) as { threads: Array<{ threadId: string }> }).threads.map((row) => row.threadId);
  };
  expect(await listed(bot.mainThreadId)).not.toContain(adaThread);
  expect(await listed(adaThread)).toContain(adaThread);
  // Each conversation's own fact reaches itself.
  expect((await search(adaThread, "oolong tea")).memoryHits.map((hit) => hit.snippet).join("\n")).toContain("oolong");
  expect((await search(roomThread, "Tuesday launch")).memoryHits.map((hit) => hit.snippet).join("\n")).toContain("Tuesday");
}, hostTimeout(60_000));

it("a member's upload is hers alone; a team file is everyone's; About you is per person", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const upload = async (token: string) => {
    const response = await fetch(`${team.base}/api/attachments`, { method: "POST", headers: { ...fx.edge, authorization: `Bearer ${token}`, "content-type": "image/png" }, body: png });
    expect(response.status).toBe(201);
    return `/api/attachments/${((await response.json()) as { path: string }).path.split(/[\\/]/).pop()}`;
  };
  scriptToolCalls(null);
  const hers = await upload(ada);
  await turn(ada, adaThread, `Keep this picture: ![cat](${hers})`);
  const theirs = await upload(owner);
  await turn(owner, bot.mainThreadId, `For everyone: ![logo](${theirs})`);
  const fetchAs = async (token: string, path: string) => (await fetch(`${team.base}${path}`, { headers: { ...fx.edge, authorization: `Bearer ${token}` } })).status;
  expect(await fetchAs(ada, hers)).toBe(200);
  expect(await fetchAs(admin, hers)).toBe(404);
  expect(await fetchAs(owner, hers)).toBe(404);
  expect(await fetchAs(cleo, hers)).toBe(404);
  for (const token of [ada, admin, cleo]) expect(await fetchAs(token, theirs)).toBe(200);
  // About you: hers in her turns, nobody's elsewhere.
  expect((await team.as(ada, "PUT", "/api/me", { aboutMe: "I run the design team and prefer short answers." })).status).toBe(200);
  expect((await team.as(cleo, "GET", "/api/me")).body.aboutMe).toBe("");
  const seen = await turn(ada, adaThread, "What do you know about me?");
  expect(seen.systemPrompt).toContain("prefer short answers");
  const room = await turn(cleo, roomThread, "@Scout anything about Ada?", roomId);
  expect(room.systemPrompt).not.toContain("prefer short answers");
  expect((await fx.onCloud("GET", "/api/me")).status).toBe(404);
}, hostTimeout(120_000));

it("a person's own connected apps cannot be brought into the team, and the team's connection serves any member's turn", async () => {
  const refused = await team.as(owner, "POST", "/api/cloud-connections/connected-apps", { share: "share-code-from-a-laptop", apps: ["gmail"] });
  expect(refused.status).toBe(403);
  expect(refused.body.error).toBe("Personal connections never enter Acme. Ask an admin to connect these apps for Acme.");
  expect((await team.as(owner, "PUT", "/api/cloud-connections/highlevel", { locationId: "loc", accessToken: "a", refreshToken: "r", expiresAt: 1 })).body.error).toContain("Personal connections never enter Acme");
  // Nor anything of a computer's one-time move: every send and move route answers the same plain line.
  for (const [method, route] of [["GET", "/api/cloud-send/manifest"], ["POST", "/api/cloud-send/chats"], ["GET", "/api/cloud-send?move=1"]] as const) {
    const moved = await team.as(owner, method, route, method === "POST" ? { conversations: [] } : undefined);
    expect(moved.status, route).toBe(403);
    expect(moved.body.error).toBe("Moving a computer's bots, chats and logins goes to My Cloud only. Nothing personal comes into Acme.");
  }
  expect((await fx.onCloud("GET", "/api/cloud-send/manifest")).status).toBe(200);
  // My Cloud still takes its owner's share (the one-time move), as before.
  expect((await fx.onCloud("POST", "/api/cloud-connections/connected-apps", { share: "not-a-real-code", apps: [] })).status).not.toBe(403);
  // The Team Cloud's own installation on the connected-apps service, registered as it started, is the team's: every member's view says connected apps are set up.
  const teamInstallation = broker.installationIds().filter((id) => broker.actingUser(id) === broker.userFor(id) && id !== fx.desktopInstallation?.id).at(-1)!;
  expect(teamInstallation).toBeTruthy();
  broker.account(broker.userFor(teamInstallation), "gmail");
  expect((await team.as(ada, "GET", "/api/config")).body.composio).toEqual({ configured: true, mode: "managed" });
  expect((await team.as(cleo, "GET", "/api/config")).body.composio).toEqual({ configured: true, mode: "managed" });
  const seen = await turn(cleo, await newThread(cleo, "Cleo and Scout"), "Check my mail.");
  expect(Object.keys(seen.mcpConfig.mcpServers)).toContain("composio");
}, hostTimeout(120_000));

it("a member's private chat keeps its own folder when the team's bot is given a working folder; the Owner's own thread moves there", async () => {
  const ownFolder = (threadId: string) => realpathSync(join(team.home, ".openmausbot", "task-workspaces", bot.id, threadId));
  const cwdOf = async (token: string, threadId: string, text: string) => realpathSync((await turn(token, threadId, text) as unknown as { cwd: string }).cwd);
  const hers = await newThread(ada, "Ada's own folder");
  const olives = await newThread(owner, "Olive's own folder");
  expect(await cwdOf(ada, hers, "Hello.")).toBe(ownFolder(hers));
  expect(await cwdOf(owner, olives, "Hello.")).toBe(ownFolder(olives));
  const project = join(team.home, "team-project");
  mkdirSync(project, { recursive: true });
  const given = await team.as(owner, "PATCH", `/api/bots/${bot.id}`, { cwd: project });
  expect(given.status, JSON.stringify(given.body)).toBe(200);
  try {
    expect(await cwdOf(ada, hers, "Hello again.")).toBe(ownFolder(hers));
    expect(await cwdOf(owner, olives, "Hello again.")).toBe(realpathSync(project));
  } finally {
    expect((await team.as(owner, "PATCH", `/api/bots/${bot.id}`, { cwd: null })).status).toBe(200);
  }
}, hostTimeout(120_000));
