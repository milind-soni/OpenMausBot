// A member's private chat with a team bot is theirs alone, the Owner and every Admin included (docs/team-cloud.md "The
// audience rule"). A real Team Cloud (OMB_CLOUD_ROLE=team) with the Owner, an Admin and Bob, a member, paired with the
// Admin's signed claims: Bob's chat, its words, its files and its live frames never reach the Owner or the Admin through
// any route, the event stream, search, a bot's tools or another bot; they cannot write in it; Bob uses it as before; and
// when Bob leaves the team it is deleted, never handed over. The engine is the synthetic Claude CLI.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ari@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const ENGINE = `import { readFileSync as readToolCalls } from "node:fs";
process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
try { process.env.FAKE_CLAUDE_TOOL_CALLS = readToolCalls(process.env.FAKE_CLAUDE_FIXTURE_DIR + "/tool-calls.json", "utf8"); } catch {}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const bobKey = personKey({ id: "", email: BOB.email });

let fx: CloudSendFixture, team: CloudTeamFixture;
let owner = "", admin = "", bob = "";
let bot: { id: string; mainThreadId: string };
let bobThread = "", bobFile = "", adminThread = "";

const dump = () => JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as { systemPrompt: string };
const scriptToolCalls = (calls: unknown[] | null) => {
  const file = join(team.home, "tool-calls.json");
  if (calls) writeFileSync(file, JSON.stringify(calls)); else rmSync(file, { force: true });
};
const dataDir = (...rest: string[]) => join(team.home, ".openmausbot", ...rest);
const messages = (token: string, threadId: string) => team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`);
const idle = async (token: string) => ((await team.as(token, "GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>)
  .every((entry) => entry.activity !== "working" && !entry.busy);
async function turn(token: string, threadId: string, text: string) {
  rmSync(join(team.home, "dump.json"), { force: true });
  const before = ((await messages(token, threadId)).body.messages as unknown[]).length;
  const sent = await team.as(token, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(async () => await idle(token) && ((await messages(token, threadId)).body.messages as unknown[]).length >= before + 2 && existsSync(join(team.home, "dump.json")));
  return dump();
}
/** expect.poll, usable in beforeAll too. */
async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const raw = async (token: string, path: string) => fetch(`${team.base}${path}`, { headers: { ...fx.edge, authorization: `Bearer ${token}` } });
/** An open event stream as one person: everything it was sent, as text. */
async function listen(token: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const stream = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${token}`, accept: "text/event-stream", ...headers }, signal: controller.signal });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; text += decoder.decode(value, { stream: true }); } })().catch(() => {});
  await until(() => text.includes("\"hello\""), 10_000);
  const cursor = /"cursor":"([^"]+)"/.exec(text)![1]!;
  return { text: () => text, cursor, close: async () => { controller.abort(); await done; } };
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  bob = (await team.pair(BOB)).token!;
  const created = await team.as(owner, "POST", "/api/bots", { name: "Scout" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  bot = created.body.bot;
  // Bob's private chat: his words, his note, his picture and his About you.
  const opened = await team.as(bob, "POST", `/api/bots/${bot.id}/tasks`, { title: "Bob's plans" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  bobThread = opened.body.task.threadId;
  expect((await team.as(bob, "PUT", "/api/me", { aboutMe: "I keep bees on the roof." })).status).toBe(200);
  const upload = await fetch(`${team.base}/api/attachments`, { method: "POST", headers: { ...fx.edge, authorization: `Bearer ${bob}`, "content-type": "image/png" }, body: PNG });
  expect(upload.status).toBe(201);
  bobFile = ((await upload.json()) as { path: string }).path.split(/[\\/]/).pop()!;
  scriptToolCalls([{ name: "memory_update", server: "agents", input: { action: "append", text: "Bob is interviewing at Kumquat Labs" } }]);
  await turn(bob, bobThread, `I am interviewing at Kumquat Labs next week. ![offer](/api/attachments/${bobFile})`);
  scriptToolCalls(null);
}, hostTimeout(180_000));

afterAll(async () => {
  await fx?.close();
});

it("Bob reads and writes his own private chat, with its words, its file, his search and his own copy of the bot", async () => {
  const mine = await messages(bob, bobThread);
  expect(mine.status).toBe(200);
  expect(JSON.stringify(mine.body)).toContain("Kumquat Labs");
  expect((await raw(bob, `/api/attachments/${bobFile}`)).status).toBe(200);
  const bots = (await team.as(bob, "GET", "/api/bots")).body.bots as Array<{ id: string; tasks: Array<{ threadId: string; private?: true }> }>;
  expect(bots.find((entry) => entry.id === bot.id)!.tasks.find((task) => task.threadId === bobThread)?.private).toBe(true);
  expect(JSON.stringify((await team.as(bob, "GET", "/api/search?q=Kumquat")).body)).toContain(bobThread);
  expect((await team.as(bob, "PATCH", `/api/bots/${bot.id}/tasks/${bobThread}`, { title: "Bob's plans" })).status).toBe(200);
  expect(readFileSync(dataDir("workspaces", `${bot.id}--member-${bobKey}`, "MEMORY.md"), "utf8")).toContain("Kumquat Labs");
  // The session says which conversations are his.
  expect((await team.as(bob, "GET", "/api/auth/session")).body.openedThreads).toContain(bobThread);
}, hostTimeout(60_000));

it("the Owner and an Admin never see Bob's chat: not by id, not in lists, counts, search, files, notifications or traces", async () => {
  // The bot's selected conversation is the server's one choice for everyone: Bob's, now.
  expect((await team.as(bob, "POST", `/api/bots/${bot.id}/tasks/${bobThread}`, {})).status).toBe(200);
  for (const [who, token] of [["Owner", owner], ["Admin", admin]] as const) {
    const label = (route: string) => `${who}: ${route}`;
    for (const route of [`/api/threads/${bobThread}/messages`, `/api/threads/${bobThread}/export`, `/api/threads/${bobThread}/job`,
      `/api/threads/${bobThread}/events`, `/api/search?q=Kumquat&threadId=${bobThread}`, `/api/bots/${bot.id}/browser/live?threadId=${bobThread}`,
      `/api/browser-sites?threadId=${bobThread}`, `/api/attachments/${bobFile}`]) {
      expect((await raw(token, route)).status, label(route)).toBe(404);
    }
    // Lists, counts and unread marks carry nothing of it.
    const listed = await team.as(token, "GET", "/api/bots");
    const scout = (listed.body.bots as Array<{ id: string; threadId: string; tasks: Array<{ threadId: string }>; unread: boolean }>).find((entry) => entry.id === bot.id)!;
    expect(scout.tasks.map((task) => task.threadId), label("/api/bots tasks")).not.toContain(bobThread);
    expect(scout.threadId, label("/api/bots selected")).toBe(bot.mainThreadId);
    expect(scout.unread, label("/api/bots unread")).toBe(false);
    for (const route of ["/api/bots", "/api/search?q=Kumquat", "/api/notifications", "/api/usage/traces", "/api/today", "/api/decisions",
      "/api/admin-activity?what=all", `/api/bots/${bot.id}/activity`, "/api/routines", `/api/bots/${bot.id}/system-prompt`]) {
      const answer = await team.as(token, "GET", route);
      expect(answer.status, label(route)).toBeLessThan(500);
      expect(JSON.stringify(answer.body), label(route)).not.toContain("Kumquat");
      expect(JSON.stringify(answer.body), label(route)).not.toContain(bobThread);
      expect(JSON.stringify(answer.body), label(route)).not.toContain("keep bees");
    }
    // Any answer that carries the bot (here a no-op folder reorder) carries the main chat, never Bob's selected one.
    const reordered = await team.as(token, "PATCH", `/api/bots/${bot.id}/projects/order`, { projectIds: [] });
    expect(reordered.status, label("projects/order")).toBe(200);
    expect(JSON.stringify(reordered.body), label("projects/order")).not.toContain("Kumquat");
    expect(JSON.stringify(reordered.body), label("projects/order")).not.toContain(bobThread);
    // Opening it is refused like a conversation that does not exist, and opens nothing.
    expect((await team.as(token, "POST", `/api/bots/${bot.id}/tasks/${bobThread}`, {})).status, label("switch")).toBe(404);
    // A team backup an admin downloads leaves it out.
    const backup = await team.as(token, "POST", "/api/teams/export", { format: "backup" });
    expect(backup.status, `${label("backup")} ${JSON.stringify(backup.body).slice(0, 300)}`).toBe(200);
    expect(JSON.stringify(backup.body), label("backup")).not.toContain("Kumquat");
  }
}, hostTimeout(90_000));

it("the Owner and an Admin cannot write in it, rename, delete, stop or answer anything in it", async () => {
  const before = JSON.stringify((await messages(bob, bobThread)).body.messages);
  for (const token of [owner, admin]) {
    const refused = async (method: string, route: string, body?: unknown) => {
      const answer = await team.as(token, method, route, body);
      expect(answer.status, `${method} ${route}`).toBe(404);
    };
    await refused("POST", `/api/bots/${bot.id}/messages`, { text: "Admin was here", threadId: bobThread });
    // No conversation named: the bot's selected one is Bob's, so it is refused rather than written into.
    await refused("POST", `/api/bots/${bot.id}/messages`, { text: "Admin was here" });
    await refused("PATCH", `/api/bots/${bot.id}/tasks/${bobThread}`, { title: "Mine now" });
    await refused("DELETE", `/api/bots/${bot.id}/tasks/${bobThread}`);
    await refused("POST", `/api/bots/${bot.id}/tasks/${bobThread}/title`, {});
    await refused("POST", `/api/bots/${bot.id}/tasks/delete`, { threadIds: [bobThread] });
    await refused("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bobThread });
    await refused("POST", `/api/bots/${bot.id}/read`, { threadId: bobThread });
    await refused("POST", `/api/bots/${bot.id}/compact`, { threadId: bobThread });
    await refused("POST", `/api/bots/${bot.id}/respond`, { threadId: bobThread, requestId: "r1", behavior: "allow" });
    await refused("POST", `/api/threads/${bobThread}/respond`, { requestId: "r1", behavior: "allow" });
    await refused("POST", "/api/routines", { name: "Spy", botId: bot.id, prompt: "x", schedule: { kind: "daily", time: "09:00" }, resultsThreadId: bobThread });
  }
  expect(JSON.stringify((await messages(bob, bobThread)).body.messages)).toBe(before);
  expect(before).not.toContain("Admin was here");
  // The task list still has it, under Bob's own title.
  const bobs = (await team.as(bob, "GET", "/api/bots")).body.bots as Array<{ id: string; tasks: Array<{ threadId: string; title: string }> }>;
  expect(bobs.find((entry) => entry.id === bot.id)!.tasks.find((task) => task.threadId === bobThread)?.title).toBe("Bob's plans");
}, hostTimeout(60_000));

it("the Owner and an Admin cannot mark Bob's notifications read, one by one or all at once", async () => {
  const bobsUnread = () => {
    const db = new DatabaseSync(dataDir("messages.db"), { readOnly: true });
    try {
      return (db.prepare("SELECT id FROM notification_log WHERE thread_id = ? AND read = 0 ORDER BY id").all(bobThread) as Array<{ id: string }>).map((row) => row.id);
    } finally {
      db.close();
    }
  };
  await turn(bob, bobThread, "Remind me to water the bees.");
  await until(() => bobsUnread().length > 0);
  const unread = bobsUnread();
  for (const token of [owner, admin]) {
    expect((await team.as(token, "POST", `/api/notifications/${unread[0]}/read`)).status).toBe(404);
    expect((await team.as(token, "POST", "/api/notifications/read-all")).status).toBe(200);
  }
  expect(bobsUnread()).toEqual(unread);
}, hostTimeout(90_000));

it("never streams Bob's chat to the Owner or an Admin, live or replayed, while Bob's stream has it", async () => {
  const ownerStream = await listen(owner), adminStream = await listen(admin), bobStream = await listen(bob);
  await turn(bob, bobThread, "Remember the quince jam recipe for me.");
  await expect.poll(() => bobStream.text().includes("quince jam"), { timeout: 10_000, interval: 50 }).toBe(true);
  // Every frame of that turn was fanned out in the same pass as Bob's; give the sockets a moment to drain.
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const [who, stream] of [["Owner", ownerStream], ["Admin", adminStream]] as const) {
    expect(stream.text(), who).not.toContain("quince");
    expect(stream.text(), who).not.toContain(bobThread);
  }
  // A reconnect replays from the cursor it had: still nothing of Bob's.
  const replayed = await listen(admin, { "last-event-id": adminStream.cursor });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(replayed.text()).toContain("\"resumed\":true");
  expect(replayed.text()).not.toContain("quince");
  expect(replayed.text()).not.toContain(bobThread);
  for (const stream of [ownerStream, adminStream, bobStream, replayed]) await stream.close();
}, hostTimeout(120_000));

it("a bot never carries Bob's chat to an Admin: not its tools in the Admin's chat or the main chat, nor a Chief", async () => {
  const opened = await team.as(admin, "POST", `/api/bots/${bot.id}/tasks`, { title: "Admin's chat" });
  expect(opened.status).toBe(201);
  adminThread = opened.body.task.threadId;
  const seen = await turn(admin, adminThread, "What do you know about the team?");
  expect(seen.systemPrompt).not.toContain("Kumquat");
  expect(seen.systemPrompt).not.toContain("keep bees");
  for (const threadId of [adminThread, bot.mainThreadId]) {
    const token = await team.capability(bot.id, threadId);
    const call = async (path: string, init: RequestInit = {}) => fetch(`${team.base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
    const search = await (await call(`/api/internal/session-search?fromBotId=${bot.id}&q=${encodeURIComponent("Kumquat Labs")}`)).json() as { hits: Array<{ threadId: string }>; memoryHits: Array<{ snippet: string }> };
    expect(search.hits.map((hit) => hit.threadId)).not.toContain(bobThread);
    expect(JSON.stringify(search.memoryHits)).not.toContain("Kumquat");
    const listed = await (await call(`/api/internal/threads?fromBotId=${bot.id}`)).json() as { threads: Array<{ threadId: string }> };
    expect(listed.threads.map((row) => row.threadId)).not.toContain(bobThread);
    const firstId = ((await messages(bob, bobThread)).body.messages as Array<{ id: string }>)[0]!.id;
    expect((await call(`/api/internal/session-read?fromBotId=${bot.id}&threadId=${bobThread}&messageId=${firstId}`)).status).toBe(404);
    expect((await call(`/api/internal/threads/${bobThread}/close?fromBotId=${bot.id}`, { method: "POST", body: "{}" })).status).toBe(404);
  }
  // What a bot learns in Bob's chat stays in his layer: it never publishes it as the section's shared memory.
  const bobs = await team.capability(bot.id, bobThread);
  const published = await fetch(`${team.base}/api/internal/team-memory`, { method: "POST", headers: { authorization: `Bearer ${bobs}`, "content-type": "application/json" },
    body: JSON.stringify({ fromBotId: bot.id, fromThreadId: bobThread, kind: "decision", name: "Interview", detail: "Bob is interviewing at Kumquat Labs" }) });
  expect(published.status).toBe(403);
  // Another bot: the team's Chief cannot restart it or read its title through a retry.
  const chief = ((await team.as(owner, "GET", "/api/bots")).body.bots as Array<{ id: string; chiefOfStaff?: boolean; threadId: string }>).find((entry) => entry.chiefOfStaff);
  if (chief) {
    const token = await team.capability(chief.id, chief.threadId);
    const retried = await fetch(`${team.base}/api/internal/retry-thread`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ fromBotId: chief.id, toBotId: bot.id, toThreadId: bobThread }) });
    expect(retried.status).not.toBe(200);
    expect(await retried.text()).not.toContain("Bob's plans");
  }
}, hostTimeout(120_000));

it("when Bob leaves the team, his private chats and everything only his are deleted, never handed to an admin", async () => {
  const layer = dataDir("workspaces", `${bot.id}--member-${bobKey}`);
  const adminsLayer = dataDir("workspaces", `${bot.id}--member-${personKey({ id: "", email: ADMIN.email })}`);
  expect(existsSync(layer)).toBe(true);
  expect(existsSync(adminsLayer)).toBe(true);
  expect(existsSync(dataDir("attachments", bobFile))).toBe(true);
  // Only the Admin's signed request, and only on a team.
  expect((await fetch(`${team.base}/api/cloud/team/member-left`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: BOB.email }) })).status).toBe(401);
  expect((await team.signed("POST", "/api/cloud/team/member-left", { email: "not an address" })).status).toBe(400);
  const left = await team.signed("POST", "/api/cloud/team/member-left", { email: BOB.email });
  expect(left.status, JSON.stringify(left.body)).toBe(200);
  expect(left.body).toMatchObject({ ok: true, chats: 1, layers: 1, files: 1 });
  expect(left.body.sessions).toBeGreaterThanOrEqual(1);
  // His sessions end at once.
  expect((await team.as(bob, "GET", "/api/auth/session")).status).toBe(401);
  // His chat, its words, its file, his notes and his About you are gone.
  for (const token of [owner, admin]) {
    expect((await messages(token, bobThread)).status).toBe(404);
    const bots = (await team.as(token, "GET", "/api/bots")).body.bots as Array<{ id: string; tasks: Array<{ threadId: string }> }>;
    expect(bots.find((entry) => entry.id === bot.id)!.tasks.map((task) => task.threadId)).not.toContain(bobThread);
    expect(JSON.stringify((await team.as(token, "GET", "/api/search?q=Kumquat")).body)).not.toContain("Kumquat");
    // What still names it (a usage trace, an activity row) stays his: no admin reads it now either.
    for (const route of ["/api/usage/traces", "/api/decisions", "/api/notifications"]) {
      const answer = JSON.stringify((await team.as(token, "GET", route)).body);
      expect(answer, route).not.toContain("Kumquat");
      expect(answer, route).not.toContain(bobThread);
    }
  }
  expect(existsSync(layer)).toBe(false);
  expect(existsSync(dataDir("attachments", bobFile))).toBe(false);
  expect(existsSync(dataDir("people", bobKey))).toBe(false);
  // The team's own things stay: the bot, its main chat, and the Admin's own chat and notes.
  expect((await messages(owner, bot.mainThreadId)).status).toBe(200);
  expect((await messages(admin, adminThread)).status).toBe(200);
  expect(existsSync(adminsLayer)).toBe(true);
  // A My Cloud has no such route.
  expect((await fx.onCloud("POST", "/api/cloud/team/member-left", { email: BOB.email })).status).not.toBe(200);
}, hostTimeout(90_000));

