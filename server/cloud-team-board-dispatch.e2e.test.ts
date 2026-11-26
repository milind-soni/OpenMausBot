// The Team Board handing work to bots on a real Team Cloud: Olive (the Owner) and Mira (a Member), and the Launch room
// with Writer, Reviewer and Lead, whose default responder is Reviewer. The synthetic Claude CLI plays each bot's part by
// calling the board tools through the real agents MCP server, keyed by a word of the turn's newest line. The board's
// waits run at a twentieth of their length (OMB_BOARD_TIME_SCALE): two quiet minutes are six seconds, a minute of
// `later` three. It proves what is started, for whom and with what, not a model's judgement.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import type { BoardItem } from "../shared/board.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const MIRA = { email: "mira@acme.test", role: "member" as const };
const ENGINE = `const dir = process.env.FAKE_CLAUDE_FIXTURE_DIR;
process.env.FAKE_CLAUDE_DUMP = dir + "/dump.json";
process.env.FAKE_CLAUDE_TOOL_CALLS_FILE = dir + "/tool-calls.json";
process.env.FAKE_CLAUDE_MARKERS_LATEST = "1";
process.env.FAKE_CLAUDE_RELEASE = dir + "/release";`;

type Bot = { id: string; name: string; threadId: string };
type Room = { id: string; threadId: string };
type Line = { id: string; role: string; kind: string; text?: string; sender?: { name: string; id?: string }; from?: { botId: string } };

let fx: CloudSendFixture, team: CloudTeamFixture;
let olive = "", mira = "";
let writer: Bot, reviewer: Bot, lead: Bot, launch: Room;

const file = (name: string) => join(team.home, name);
/** Each bot's part, by a word of its turn's newest line; the first word found wins. */
const parts = (calls: Record<string, unknown[]>) => writeFileSync(file("tool-calls.json"), JSON.stringify(calls));
const update = (input: Record<string, unknown>) => ({ name: "board_update", server: "agents", input });
const messages = async (token: string, threadId: string) => (await team.as(token, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as Line[];
const board = async (token: string) => (await team.as(token, "GET", "/api/board")).body.items as BoardItem[];
const item = async (threadId: string) => (await board(olive)).find((one) => one.threadId === threadId)!;
const add = async (token: string, body: Record<string, unknown>) => {
  const made = await team.as(token, "POST", "/api/board/items", body);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.item as BoardItem;
};
/** The usage rows the Team Cloud booked for one thread. */
const usageRows = (threadId: string) => {
  const dir = join(team.home, ".openmausbot", "usage");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean).map((row) => JSON.parse(row) as { threadId: string; botId: string; trigger: { kind: string } }))
    .filter((row) => row.threadId === threadId);
};

async function until(done: () => Promise<boolean> | boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what}\n${fx.logs().slice(-6_000)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
const settled = (threadId: string, state: BoardItem["state"]) => until(async () => (await item(threadId)).state === state, `${threadId} ${state}`);

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-board-dispatch-${randomBytes(8).toString("hex")}`,
    team: { id: "team-acme-board-dispatch", name: "Acme", engine: ENGINE, env: { OMB_BOARD_TIME_SCALE: "0.05" } } });
  team = fx.team!;
  olive = (await team.pair(OLIVE)).token!;
  mira = (await team.pair(MIRA)).token!;
  parts({});
  const bot = async (name: string) => {
    const made = await team.as(olive, "POST", "/api/bots", { name, visibility: "everyone" });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    return made.body.bot as Bot;
  };
  writer = await bot("Writer");
  reviewer = await bot("Reviewer");
  lead = await bot("Lead");
  const made = await team.as(olive, "POST", "/api/groups", { name: "Launch", memberIds: [writer.id, reviewer.id, lead.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: reviewer.id } } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  launch = made.body.group as Room;
}, hostTimeout(180_000));

afterAll(async () => {
  await fx?.close();
});

it("lists the board tools to every bot of a Team Cloud with no switch, and tells a room's bots to split work only when asked", async () => {
  const dump = () => JSON.parse(readFileSync(file("dump.json"), "utf8")) as { systemPrompt?: string | null; mcpConfig?: { mcpServers?: { agents?: { env?: Record<string, string> } } } };
  const idle = () => until(async () => ((await team.as(olive, "GET", "/api/bots")).body.bots as Array<{ busy?: boolean }>).every((one) => !one.busy), "idle");
  rmSync(file("dump.json"), { force: true });
  const sent = await team.as(olive, "POST", `/api/bots/${writer.id}/messages`, { text: "Hello", threadId: writer.threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(() => existsSync(file("dump.json")), "a chat turn");
  expect(dump().mcpConfig?.mcpServers?.agents?.env?.OMB_TEAM_BOARD).toBe("1");
  expect(dump().systemPrompt).toBeTruthy();
  expect(dump().systemPrompt ?? "", "the split line is for rooms").not.toContain("board_add");
  expect(dump().systemPrompt ?? "", "and so is the work view").not.toContain("call board_list and show it here with show_html");
  await idle();
  rmSync(file("dump.json"), { force: true });
  const room = await team.as(mira, "POST", `/api/groups/${launch.id}/messages`, { text: "Hello room", threadId: launch.threadId });
  expect(room.status, JSON.stringify(room.body)).toBe(202);
  await until(() => existsSync(file("dump.json")), "a room turn");
  expect(dump().mcpConfig?.mcpServers?.agents?.env?.OMB_TEAM_BOARD).toBe("1");
  expect(dump().systemPrompt ?? "").toContain("When a person here asks you to split up or share out work");
  expect(dump().systemPrompt ?? "").toContain("When someone asks to see the work or where it stands, call board_list and show it here with show_html");
  expect(dump().systemPrompt ?? "").toContain("asked again, replace that page by its app_id. Never show it unasked.");
  // Every bot must be idle before the next case: a busy one would hand its first item to another bot.
  await idle();
}, hostTimeout(90_000));

it("hands a person's item to a free bot as unattended work, and a done item readies and dispatches what needs it", async () => {
  parts({
    "Beta review": [update({ move: "done", text: "Reads well." })],
    "Alpha draft": [update({ move: "done", text: "Draft at drafts/alpha.md" })],
  });
  const alpha = await add(mira, { groupId: launch.id, title: "Alpha draft", text: "Write the launch post for Friday." });
  const beta = await add(mira, { groupId: launch.id, title: "Beta review", needs: [alpha.threadId], forBotId: reviewer.id });
  expect(beta.state).toBe("waiting");
  await settled(alpha.threadId, "done");
  expect(await item(alpha.threadId)).toMatchObject({ result: "Draft at drafts/alpha.md", attempts: 1 });
  const lines = await messages(mira, alpha.threadId);
  const brief = lines.find((line) => line.role === "user" && line.sender?.name === "Handoff")!;
  expect(brief.text).toMatch(/^@Writer /);
  expect(brief.text).toContain("Alpha draft");
  expect(brief.text).toContain("Write the launch post for Friday.");
  expect(brief.sender?.id, "the board is no person").toBeUndefined();
  await until(async () => (await messages(mira, alpha.threadId)).some((line) => line.role === "bot" && line.kind === "text" && line.from?.botId === writer.id), "Writer's reply");
  await settled(beta.threadId, "done");
  const review = (await messages(mira, beta.threadId)).find((line) => line.sender?.name === "Handoff")!;
  expect(review.text).toMatch(/^@Reviewer /);
  expect(review.text).toContain("Draft at drafts/alpha.md");
  expect(await item(beta.threadId)).toMatchObject({ result: "Reads well." });
  await until(() => usageRows(alpha.threadId).length > 0, "a usage row");
  expect(usageRows(alpha.threadId).map((row) => [row.botId, row.trigger.kind])).toEqual([[writer.id, "bot"]]);
}, hostTimeout(120_000));

it("an ask waits on the person who made the item, reaches their inbox, and their reply in the thread starts the same bot", async () => {
  parts({
    "Friday the 5th": [update({ move: "done", text: "Launch set for Friday the 5th." })],
    "Gamma launch date": [update({ move: "ask", text: "Which date should the launch be?" })],
  });
  const gamma = await add(mira, { groupId: launch.id, title: "Gamma launch date", forBotId: writer.id });
  await settled(gamma.threadId, "needs_person");
  const asked = await item(gamma.threadId);
  expect(asked).toMatchObject({ holder: { botId: writer.id }, question: { text: "Which date should the launch be?", person: personKey({ id: "", email: MIRA.email }) } });
  expect(asked.question?.name, "whom it waits on, by name").toBeTruthy();
  expect((await messages(mira, gamma.threadId)).some((line) => line.role === "bot" && line.text === "Which date should the launch be?" && line.from?.botId === writer.id)).toBe(true);
  await until(async () => ((await team.as(mira, "GET", "/api/inbox")).body.rows as Array<{ text: string; origin?: { threadId: string } }>)
    .some((row) => row.text === "Which date should the launch be?" && row.origin?.threadId === gamma.threadId), "Mira's inbox line");
  const rooms = (await team.as(mira, "GET", "/api/bots?messages=0")).body.groups as Array<Room & { tasks?: Array<{ threadId: string; activity?: string }> }>;
  expect(rooms.find((room) => room.id === launch.id)!.tasks!.find((task) => task.threadId === gamma.threadId)!.activity).toBe("waiting-on-you");
  const replied = await team.as(mira, "POST", `/api/groups/${launch.id}/messages`, { text: "Friday the 5th", threadId: gamma.threadId });
  expect(replied.status, JSON.stringify(replied.body)).toBe(202);
  // Writer's asking turn may still be ending (the item waits on Mira from the moment it asked), so her line is either
  // started at once or queued behind that turn; either way it is saved addressed to Writer.
  if (replied.body.queued) expect(replied.body.queueId).toBeTruthy();
  else expect(replied.body.message?.text).toBe("@Writer Friday the 5th");
  await until(async () => (await messages(mira, gamma.threadId)).some((line) => line.role === "user" && line.text === "@Writer Friday the 5th"), "Mira's line, addressed to Writer");
  expect((await messages(mira, gamma.threadId)).filter((line) => line.role === "user" && line.text?.includes("Friday the 5th"))).toHaveLength(1);
  await settled(gamma.threadId, "done");
  expect(await item(gamma.threadId)).toMatchObject({ result: "Launch set for Friday the 5th.", attempts: 1 });
  const answers = (await messages(mira, gamma.threadId)).filter((line) => line.role === "bot" && line.kind === "text");
  expect(answers.every((line) => line.from?.botId === writer.id), "Reviewer, the room's default, never answered").toBe(true);
}, hostTimeout(120_000));

it("a reply queued behind the turn that asked still goes to the same bot, and the item is not handed on meanwhile", async () => {
  rmSync(file("release"), { force: true });
  parts({
    "Thursday works": [update({ move: "done", text: "Booked Thursday." })],
    // Writer asks, then stays in its turn until the release file exists: Mira's reply has to wait in the queue.
    "Theta booking": [update({ move: "ask", text: "Which day should I book?" }), { name: "Bash", input: { command: "echo still finishing" }, hold: true }],
  });
  const theta = await add(mira, { groupId: launch.id, title: "Theta booking", forBotId: writer.id });
  await settled(theta.threadId, "needs_person");
  const replied = await team.as(mira, "POST", `/api/groups/${launch.id}/messages`, { text: "Thursday works", threadId: theta.threadId });
  expect(replied.status, JSON.stringify(replied.body)).toBe(202);
  expect(replied.body.queued, "Writer's turn is still running").toBe(true);
  expect(await item(theta.threadId)).toMatchObject({ state: "working", holder: { botId: writer.id }, attempts: 1 });
  writeFileSync(file("release"), "");
  await settled(theta.threadId, "done");
  expect(await item(theta.threadId)).toMatchObject({ result: "Booked Thursday.", attempts: 1 });
  const lines = await messages(mira, theta.threadId);
  expect(lines.filter((line) => line.role === "user" && line.text?.includes("Thursday works")).map((line) => line.text)).toEqual(["@Writer Thursday works"]);
  expect(lines.filter((line) => line.sender?.name === "Handoff"), "never handed out again").toHaveLength(1);
  rmSync(file("release"), { force: true });
}, hostTimeout(120_000));

it("an answer from the person's inbox, which starts no turn by itself, brings the item back to the bot that asked", async () => {
  parts({
    "The Hall": [update({ move: "done", text: "Booked The Hall." })],
    "Zeta venue": [update({ move: "ask", text: "Which venue should I book?" })],
  });
  const zeta = await add(mira, { groupId: launch.id, title: "Zeta venue", forBotId: writer.id });
  await settled(zeta.threadId, "needs_person");
  type Inbox = { botId: string; threadId: string; rows: Array<{ id: string; text: string; origin?: { threadId: string } }> };
  let inbox: Inbox | null = null;
  await until(async () => {
    inbox = (await team.as(mira, "GET", "/api/inbox")).body as Inbox;
    return inbox.rows.some((row) => row.origin?.threadId === zeta.threadId);
  }, "Mira's inbox line");
  const line = inbox!.rows.find((row) => row.origin?.threadId === zeta.threadId)!;
  const answered = await team.as(mira, "POST", `/api/bots/${inbox!.botId}/messages`, { text: "The Hall, please.", threadId: inbox!.threadId, replyToId: line.id });
  expect(answered.status, JSON.stringify(answered.body)).toBe(202);
  await settled(zeta.threadId, "done");
  expect(await item(zeta.threadId)).toMatchObject({ result: "Booked The Hall.", attempts: 1 });
  const boardLines = (await messages(mira, zeta.threadId)).filter((row) => row.sender?.name === "Handoff");
  expect(boardLines).toHaveLength(2);
  expect(boardLines[1]!.text).toMatch(/^@Writer .*The Hall, please\./s);
}, hostTimeout(120_000));

it("board_add from a lead makes a thread and an item each, with needs, and a bad batch makes nothing", async () => {
  parts({ "Delta two": [update({ move: "done", text: "Two done." })], "Delta one": [update({ move: "done", text: "One done." })] });
  const bearer = await team.capability(lead.id, launch.threadId);
  const call = (path: string, body: unknown) => fetch(`${team.base}/api/internal/board/${path}`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const before = (await board(olive)).length;
  const bad = await call("add", { items: [{ key: "a", title: "Delta zero" }, { key: "b", title: "Delta nobody", for: "Nobody" }] });
  expect(bad.status).toBe(400);
  expect((await board(olive)).length).toBe(before);
  const made = await call("add", { items: [{ key: "two", title: "Delta two", needs: ["one"], for: "Reviewer", labels: { area: "launch" } }, { key: "one", title: "Delta one", brief: "Book the room for Friday." }] });
  expect(made.status, await made.clone().text()).toBe(201);
  const items = (await board(olive)).filter((one) => one.title.startsWith("Delta"));
  const one = items.find((entry) => entry.title === "Delta one")!, two = items.find((entry) => entry.title === "Delta two")!;
  expect(two).toMatchObject({ needs: [one.threadId], forBotId: reviewer.id, labels: { area: "launch" }, createdBy: { kind: "bot", id: lead.id } });
  const first = (await messages(olive, one.threadId))[0]!;
  expect(first).toMatchObject({ role: "bot", text: "Book the room for Friday.", from: { botId: lead.id } });
  await settled(two.threadId, "done");
  const listed = await (await call("list", {})).json() as { text: string };
  expect(listed.text).toContain(`${two.threadId} [done] Delta two`);
  // A bot working one piece cannot split it into more: that would start turns nobody asked for.
  const inside = await team.capability(writer.id, one.threadId);
  const again = await fetch(`${team.base}/api/internal/board/add`, { method: "POST", headers: { authorization: `Bearer ${inside}`, "content-type": "application/json" }, body: JSON.stringify({ items: [{ key: "x", title: "Delta three" }] }) });
  expect(again.status).toBe(409);
  expect((await board(olive)).some((entry) => entry.title === "Delta three")).toBe(false);
}, hostTimeout(120_000));

it("later sets the item aside and brings it back to the same bot at its time, counting no attempt", async () => {
  parts({
    "See whether CI passed": [update({ move: "done", text: "CI green." })],
    "Epsilon ship": [update({ move: "later", minutes: 1, text: "See whether CI passed" })],
  });
  const epsilon = await add(mira, { groupId: launch.id, title: "Epsilon ship", forBotId: writer.id });
  await until(async () => (await item(epsilon.threadId)).later !== undefined, "set aside");
  expect(await item(epsilon.threadId)).toMatchObject({ state: "working", holder: { botId: writer.id }, laterCount: 1, later: { note: "See whether CI passed" } });
  await settled(epsilon.threadId, "done");
  expect(await item(epsilon.threadId)).toMatchObject({ result: "CI green.", attempts: 1, laterCount: 1 });
  const woken = (await messages(mira, epsilon.threadId)).filter((line) => line.sender?.name === "Handoff");
  expect(woken).toHaveLength(2);
  expect(woken[1]!.text).toMatch(/^@Writer .*See whether CI passed/s);
}, hostTimeout(120_000));
