// Who may see, chat with and change each bot on a real Team Cloud: Acme's Owner (Olive), an Admin (Ada) and four Users,
// each paired with the Admin's signed claim. One bot, Payroll, is shared with Bob to view, Cara to chat and Dan to edit;
// Eve is not added. Every route a member reaches is tried as each of them, the live stream follows a change, sharing
// moves with the bot's owner, and bots set up before levels keep exactly the access they had. The engine is the
// synthetic Claude CLI.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const ADA = { email: "ada@acme.test", role: "admin" as const };
const BOB = { email: "bob@acme.test", role: "member" as const };
const CARA = { email: "cara@acme.test", role: "member" as const };
const DAN = { email: "dan@acme.test", role: "member" as const };
const EVE = { email: "eve@acme.test", role: "member" as const };

type Bot = { id: string; name: string; threadId: string; mainThreadId?: string; yourAccess?: string; access?: { everyone: string; people: Record<string, string> }; visibility?: unknown; soul?: string };

let fx: CloudSendFixture, team: CloudTeamFixture;
const token: Record<string, string> = {};
let payroll: Bot, mirror: Bot, helpdesk: Bot;
let room = "", roomThread = "", adaRoutine = "", caraRoutine = "", lastLine = "";

const as = (who: string, method: string, path: string, body?: unknown) => team.as(token[who]!, method, path, body);
const bots = async (who: string) => (await as(who, "GET", "/api/bots")).body.bots as Bot[];
const botOf = async (who: string, id: string) => (await bots(who)).find((bot) => bot.id === id);
const share = (who: string, botId: string, access: { everyone: string; people: Record<string, string> }) => as(who, "PUT", `/api/bots/${botId}/access`, access);

async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const idle = async () => (await bots("ada")).every((bot) => !(bot as { busy?: boolean }).busy);

/** One person's live stream: every frame it was sent. */
async function listen(who: string) {
  const controller = new AbortController();
  const stream = await fetch(`${team.base}/api/events`, { headers: { ...fx.edge, authorization: `Bearer ${token[who]}`, accept: "text/event-stream" }, signal: controller.signal });
  expect(stream.status).toBe(200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let text = "", ended = false;
  const done = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) { ended = true; return; } text += decoder.decode(value, { stream: true }); } })().catch(() => {});
  await until(() => text.includes("\"hello\""), 10_000);
  const frames = () => text.split("\n\n").flatMap((part) => {
    const data = part.split("\n").find((line) => line.startsWith("data: "));
    try { return data ? [JSON.parse(data.slice(6)) as Record<string, any>] : []; } catch { return []; }
  });
  return { frames, ended: () => ended, close: async () => { controller.abort(); await done; } };
}

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-1", name: "Acme" } });
  team = fx.team!;
  for (const [who, member] of Object.entries({ olive: OLIVE, ada: ADA, bob: BOB, cara: CARA, dan: DAN, eve: EVE })) {
    const paired = await team.pair(member);
    expect(paired.token, JSON.stringify(paired.body)).toBeTruthy();
    token[who] = paired.token!;
  }
  const create = async (body: Record<string, unknown>) => {
    const created = await as("ada", "POST", "/api/bots", body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.bot as Bot;
  };
  payroll = await create({ name: "Payroll" });
  mirror = await create({ name: "Payroll Mirror" });
  helpdesk = await create({ name: "Helpdesk" });
  const levels = { everyone: "none", people: { [BOB.email]: "view", [CARA.email]: "chat", [DAN.email]: "edit" } };
  expect((await share("ada", payroll.id, levels)).status).toBe(200);
  expect((await share("ada", mirror.id, levels)).status).toBe(200);
  const made = await as("ada", "POST", "/api/groups", { memberIds: [payroll.id, mirror.id], name: "Pay desk", setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  room = made.body.group.id;
  roomThread = made.body.group.threadId;
  const sent = await as("ada", "POST", `/api/bots/${payroll.id}/messages`, { text: "Payroll runs on the 25th." });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(idle);
  const lines = (await as("ada", "GET", `/api/threads/${payroll.threadId}/messages`)).body.messages as Array<{ id: string }>;
  lastLine = lines.at(-1)!.id;
  const routine = (botId: string) => ({ name: "Weekly pay check", prompt: "Check this week's pay runs.", botId, schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 } });
  const adas = await as("ada", "POST", "/api/routines", routine(payroll.id));
  expect(adas.status, JSON.stringify(adas.body)).toBe(201);
  adaRoutine = adas.body.routine.id;
  const own = await as("cara", "POST", "/api/routines", routine(payroll.id));
  expect(own.status, JSON.stringify(own.body)).toBe(201);
  caraRoutine = own.body.routine.id;
}, hostTimeout(180_000));

afterAll(async () => {
  await fx?.close();
});

describe("a team bot shared with a level per person", () => {
  it("lists the bot with each person's own level, its sharing only to those who can edit it, and not at all for Eve", async () => {
    expect((await botOf("bob", payroll.id))).toMatchObject({ yourAccess: "view" });
    expect((await botOf("cara", payroll.id))).toMatchObject({ yourAccess: "chat" });
    expect((await botOf("dan", payroll.id))).toMatchObject({ yourAccess: "edit", access: { everyone: "none", people: { [BOB.email]: "view", [CARA.email]: "chat", [DAN.email]: "edit" } } });
    expect((await botOf("ada", payroll.id))).toMatchObject({ yourAccess: "edit", access: { everyone: "none" } });
    expect((await botOf("olive", payroll.id))).toMatchObject({ yourAccess: "edit" });
    for (const who of ["bob", "cara"]) {
      const copy = (await botOf(who, payroll.id))!;
      expect(copy.access, who).toBeUndefined();
      expect(copy.visibility, who).toBeUndefined();
    }
    expect(await botOf("eve", payroll.id)).toBeUndefined();
    expect((await as("eve", "GET", `/api/threads/${payroll.threadId}/messages`)).status).toBe(404);
    expect((await as("eve", "PUT", `/api/bots/${payroll.id}/access`, { everyone: "chat", people: {} })).status).toBe(404);
  });

  const chatRoutes = (): Array<[string, string, unknown?]> => [
    ["POST", `/api/bots/${payroll.id}/messages`, { text: "What is my pay date?" }],
    ["POST", `/api/bots/${payroll.id}/messages`, { text: "In the main chat", threadId: payroll.threadId }],
    ["POST", `/api/bots/${payroll.id}/tasks`, { title: "Mine" }],
    ["POST", `/api/bots/${payroll.id}/interrupt`, { threadId: payroll.threadId }],
    ["POST", `/api/bots/${payroll.id}/compact`, { threadId: payroll.threadId }],
    ["POST", `/api/bots/${payroll.id}/respond`, { requestId: "x", behavior: "deny", threadId: payroll.threadId }],
    ["POST", `/api/bots/${payroll.id}/messages/${lastLine}/edit`, { text: "Edited", threadId: payroll.threadId }],
    ["POST", `/api/bots/${payroll.id}/always-allow`, { threadId: payroll.threadId, requestId: "x" }],
    ["POST", `/api/bots/${payroll.id}/setup-request`, { text: "Set me up" }],
    ["POST", `/api/bots/${payroll.id}/browser/action`, { action: "back" }],
    ["POST", `/api/threads/${payroll.threadId}/respond`, { requestId: "x", behavior: "deny" }],
    ["POST", `/api/threads/${payroll.threadId}/undo`, { requestId: "x" }],
    ["POST", `/api/threads/${payroll.threadId}/messages/${lastLine}/reactions`, { emoji: "👍", on: true }],
    ["PATCH", `/api/bots/${payroll.id}`, { color: "teal" }],
    ["PATCH", `/api/bots/${payroll.id}/profile`, { avatarFocusX: 0.4 }],
    ["POST", "/api/routines", { name: "Mine", prompt: "Hello", botId: payroll.id, schedule: { type: "once", at: Date.now() + 86_400_000 } }],
    ["POST", "/api/routines", { name: "Room's", prompt: "Hello", groupId: room, schedule: { type: "once", at: Date.now() + 86_400_000 } }],
    ["POST", `/api/routines/${adaRoutine}/run`],
    ["POST", "/api/groups", { memberIds: [payroll.id, mirror.id], name: "Mine" }],
    ["POST", `/api/groups/${room}/messages`, { text: "Hello both" }],
    ["POST", `/api/groups/${room}/tasks`, { title: "Ours" }],
    ["POST", `/api/groups/${room}/interrupt`],
    ["PATCH", `/api/groups/${room}`, { name: "Renamed" }],
  ];

  it("lets Bob, who can view, read the bot, its chat and its room, and refuses every way of writing to it", async () => {
    for (const [method, path] of [
      ["GET", `/api/threads/${payroll.threadId}/messages`], ["GET", `/api/threads/${payroll.threadId}/export`],
      ["GET", `/api/threads/${roomThread}/messages`],
      ["GET", "/api/routines"],
    ] as const) {
      expect((await as("bob", method, path)).status, `${method} ${path}`).toBe(200);
    }
    expect((await as("bob", "POST", `/api/bots/${payroll.id}/read`, { threadId: payroll.threadId })).status).toBe(200);
    expect((await as("bob", "POST", `/api/bots/${payroll.id}/tasks/${payroll.threadId}`)).status).toBe(200);
    expect((await as("bob", "POST", `/api/groups/${room}/tasks/${roomThread}`)).status).toBe(200);
    expect((await as("bob", "PATCH", `/api/bots/${payroll.id}`, { unread: false })).status).toBe(200);
    expect((await as("bob", "POST", `/api/groups/${room}/read`)).status).toBe(200);
    for (const [method, path, body] of chatRoutes()) {
      const res = await as("bob", method, path, body);
      expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(403);
      expect(String(res.body.error), `${method} ${path}`).toMatch(/view|change/);
    }
    expect((await as("bob", "PATCH", `/api/routines/${caraRoutine}`, { enabled: false })).status).toBe(403);
    expect((await as("bob", "DELETE", `/api/routines/${adaRoutine}`)).status).toBe(403);
    expect((await as("bob", "PATCH", `/api/bots/${payroll.id}`, { soul: "Be brief." })).status).toBe(403);
    expect((await as("bob", "PUT", `/api/bots/${payroll.id}/access`, { everyone: "chat", people: {} })).status).toBe(403);
    // Nothing behind the refusals changed.
    expect((await botOf("ada", payroll.id))?.access?.everyone).toBe("none");
    expect((await as("ada", "GET", "/api/routines")).body.routines.filter((one: { botId?: string }) => one.botId === payroll.id)).toHaveLength(2);
  });

  it("lets Cara chat and keep her own routine, but not change the bot, its sharing or someone else's routine", async () => {
    const sent = await as("cara", "POST", `/api/bots/${payroll.id}/messages`, { text: "When is payday?", threadId: payroll.threadId });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await until(idle);
    const task = await as("cara", "POST", `/api/bots/${payroll.id}/tasks`, { title: "Mine" });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    const said = await as("cara", "POST", `/api/groups/${room}/messages`, { text: "Hello both" });
    expect(said.status, JSON.stringify(said.body)).toBe(202);
    await until(idle);
    // Her own place in the list is hers; how the bot looks is everyone's, so changing it takes "Can edit".
    expect((await as("cara", "PATCH", `/api/bots/${payroll.id}`, { pinned: true })).status).toBe(200);
    expect((await as("cara", "PATCH", `/api/routines/${caraRoutine}`, { name: "My pay check" })).status).toBe(200);
    expect((await as("cara", "POST", `/api/routines/${caraRoutine}/run`)).status).toBe(201);
    for (const [method, path, body] of [
      ["PATCH", `/api/bots/${payroll.id}`, { soul: "Be brief." }],
      ["PATCH", `/api/bots/${payroll.id}`, { color: "teal" }],
      ["PATCH", `/api/bots/${payroll.id}`, { composio: true }],
      ["PATCH", `/api/bots/${payroll.id}/profile`, { soul: "Be brief." }],
      ["PUT", `/api/bots/${payroll.id}/access`, { everyone: "chat", people: {} }],
      ["PATCH", `/api/routines/${adaRoutine}`, { enabled: false }],
      ["DELETE", `/api/routines/${adaRoutine}`],
    ] as const) {
      const res = await as("cara", method, path, body);
      expect(res.status, `${method} ${path}: ${JSON.stringify(res.body)}`).toBe(403);
    }
    await until(idle);
  });

  it("lets Dan, who can edit, change its instructions, apps and sharing, and nothing an admin keeps", async () => {
    const changed = await as("dan", "PATCH", `/api/bots/${payroll.id}`, { soul: "Answer pay questions briefly.", composio: false, mcpServers: [] });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.bot).toMatchObject({ soul: "Answer pay questions briefly.", yourAccess: "edit" });
    const profile = await as("dan", "PATCH", `/api/bots/${payroll.id}/profile`, { description: "Pay questions" });
    expect(profile.status, JSON.stringify(profile.body)).toBe(200);
    for (const field of [{ approvalMode: "full" }, { cwd: "/tmp" }, { computer: "off" }, { section: "Finance" }, { chiefOfStaff: true }, { peers: [] }, { visibility: "everyone" }, { access: { everyone: "edit", people: {} } }]) {
      const res = await as("dan", "PATCH", `/api/bots/${payroll.id}`, field);
      expect(res.status, `${JSON.stringify(field)}: ${JSON.stringify(res.body)}`).toBe(403);
    }
    expect((await as("dan", "PATCH", `/api/routines/${adaRoutine}`, { enabled: false })).status).toBe(200);
    expect((await as("dan", "PUT", `/api/bots/${payroll.id}/access`, { everyone: "none", people: { [BOB.email]: "view", [CARA.email]: "chat", [DAN.email]: "edit", "stranger@elsewhere.test": "chat" } })).status).toBe(400);
    expect((await botOf("dan", payroll.id))?.soul).toBe("Answer pay questions briefly.");
  });

  it("relays another app's message only for a person who can chat with the bot", async () => {
    const relay = async (email: string | undefined, n: number) => {
      const leaf = (await as("ada", "GET", `/api/threads/${payroll.threadId}/messages?limit=1`)).body.activeLeafId ?? null;
      const mode = ((await botOf("ada", payroll.id)) as { approvalMode?: string }).approvalMode;
      const res = await fetch(`${team.base}/api/bots/${payroll.id}/messages/guarded`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: payroll.threadId, sendId: `slackjob_bot_access_${n}`, text: "From the other app", expectedActiveLeafId: leaf, expectedApprovalMode: mode,
          ...(email ? { onBehalfOf: { email } } : {}) }),
      });
      return { status: res.status, body: await res.json() as { error?: string } };
    };
    expect(await relay(BOB.email, 1)).toMatchObject({ status: 403 });
    expect(await relay(EVE.email, 2)).toMatchObject({ status: 403 });
    expect(await relay(undefined, 3)).toMatchObject({ status: 403 });
    const cara = await relay(CARA.email, 4);
    expect(cara.status, JSON.stringify(cara.body)).toBe(202);
    await until(idle);
    expect((await relay(ADA.email, 5)).status).toBe(202);
    await until(idle);
  });

  it("sends a level change down each person's live stream, and a removal ends their stream and takes the bot away", async () => {
    const bob = await listen("bob");
    try {
      const raised = await share("dan", payroll.id, { everyone: "none", people: { [BOB.email]: "chat", [CARA.email]: "chat", [DAN.email]: "edit" } });
      expect(raised.status, JSON.stringify(raised.body)).toBe(200);
      await until(() => bob.frames().some((frame) => frame.kind === "bot" && frame.bot?.id === payroll.id && frame.bot.yourAccess === "chat"), 10_000);
      expect(bob.frames().filter((frame) => frame.kind === "bot" && frame.bot?.id === payroll.id).every((frame) => frame.bot.access === undefined)).toBe(true);
      expect(bob.ended()).toBe(false);
      expect((await as("bob", "POST", `/api/bots/${payroll.id}/tasks`, { title: "Now I can" })).status).toBe(201);
    } finally {
      await bob.close();
    }
    const again = await listen("bob");
    try {
      expect((await share("ada", payroll.id, { everyone: "none", people: { [CARA.email]: "chat", [DAN.email]: "edit", [EVE.email]: "view" } })).status).toBe(200);
      await until(() => again.ended(), 10_000);
      expect((await bots("bob")).some((bot) => bot.id === payroll.id)).toBe(false);
      expect((await as("bob", "GET", `/api/threads/${payroll.threadId}/messages`)).status).toBe(404);
      expect((await as("bob", "POST", `/api/bots/${payroll.id}/messages`, { text: "Still here?" })).status).toBe(404);
      expect((await botOf("eve", payroll.id))).toMatchObject({ yourAccess: "view" });
      expect((await as("eve", "POST", `/api/bots/${payroll.id}/tasks`, { title: "Not yet" })).status).toBe(403);
    } finally {
      await again.close();
    }
  });

  it("lets everyone in the team view a bot set to Everyone · Can view, and admins edit it whatever its sharing", async () => {
    expect((await share("ada", helpdesk.id, { everyone: "view", people: { [CARA.email]: "chat" } })).status).toBe(200);
    expect((await botOf("eve", helpdesk.id))).toMatchObject({ yourAccess: "view" });
    expect((await botOf("cara", helpdesk.id))).toMatchObject({ yourAccess: "chat" });
    expect((await as("eve", "POST", `/api/bots/${helpdesk.id}/messages`, { text: "Hi" })).status).toBe(403);
    expect((await as("ada", "PATCH", `/api/bots/${helpdesk.id}`, { soul: "Help." })).status).toBe(200);
    expect((await share("olive", helpdesk.id, { everyone: "chat", people: {} })).status).toBe(200);
    expect((await botOf("eve", helpdesk.id))).toMatchObject({ yourAccess: "chat" });
  });
});

describe("the owner of a bot", () => {
  it("can always edit it, sees it while only the people added do, and keeps editing after handing it on", async () => {
    const made = await as("ada", "POST", "/api/bots", { name: "Bob's desk", reportsTo: BOB.email });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const desk = made.body.bot as Bot;
    expect((await share("ada", desk.id, { everyone: "none", people: {} })).status).toBe(200);
    expect((await botOf("bob", desk.id))).toMatchObject({ yourAccess: "edit" });
    expect(await botOf("cara", desk.id)).toBeUndefined();
    expect((await as("bob", "PATCH", `/api/bots/${desk.id}`, { soul: "Bob's way." })).status).toBe(200);
    const handed = await as("bob", "PUT", `/api/bots/${desk.id}/reports-to`, { email: CARA.email });
    expect(handed.status, JSON.stringify(handed.body)).toBe(200);
    expect((await botOf("cara", desk.id))).toMatchObject({ yourAccess: "edit" });
    expect((await botOf("bob", desk.id))).toMatchObject({ yourAccess: "edit" });
    expect((await botOf("ada", desk.id))?.access?.people).toEqual({ [BOB.email]: "edit" });
  });

  it("keeps a person's own MausBot private to them", async () => {
    const own = (await bots("eve")).find((bot) => (bot as { defaultBot?: { person?: string } }).defaultBot?.person === EVE.email);
    expect(own).toMatchObject({ yourAccess: "edit" });
    expect(await botOf("cara", own!.id)).toBeUndefined();
  });
});

describe("bots set up before levels", () => {
  it("keep what their visibility gave: everyone can chat, listed people can chat, and admins only stays admins only", async () => {
    const make = async (name: string, visibility: unknown) => {
      const created = await as("ada", "POST", "/api/bots", { name, visibility });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return created.body.bot as Bot;
    };
    const open = await make("Open desk", "everyone");
    const listed = await make("Listed desk", { people: [BOB.email, "@acme.test"] });
    const board = await make("Board desk", "admins");
    expect((await botOf("ada", open.id))?.access).toEqual({ everyone: "chat", people: {} });
    expect((await botOf("eve", open.id))).toMatchObject({ yourAccess: "chat" });
    expect((await botOf("ada", listed.id))?.access).toEqual({ everyone: "none", people: { [BOB.email]: "chat", "@acme.test": "chat" } });
    expect((await botOf("cara", listed.id))).toMatchObject({ yourAccess: "chat" });
    expect((await as("cara", "POST", `/api/bots/${listed.id}/tasks`, { title: "As before" })).status).toBe(201);
    expect((await botOf("ada", board.id))?.access).toEqual({ everyone: "none", people: {} });
    expect(await botOf("bob", board.id)).toBeUndefined();
    expect((await botOf("olive", board.id))).toMatchObject({ yourAccess: "edit" });
    // An older app's visibility change on a team sets the matching sharing.
    expect((await as("ada", "PATCH", `/api/bots/${board.id}`, { visibility: { people: [DAN.email] } })).status).toBe(200);
    expect((await botOf("ada", board.id))?.access).toEqual({ everyone: "none", people: { [DAN.email]: "chat" } });
    expect((await botOf("dan", board.id))).toMatchObject({ yourAccess: "chat" });
  });
});
