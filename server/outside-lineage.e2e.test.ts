// Work that came in from outside stays with that work, on a real Team Cloud, a personal Cloud someone else has used and a
// desktop, with the fake engine: the level each turn really got, read from what the engine was started with.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { OUTSIDE_REFUSAL } from "./host/outside-fence.ts";
import { OUTSIDE_STAYS_HERE } from "./host/outside-lineage.ts";
import { markLeftBehind } from "./testing/cloud-left-behind.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const tag = randomBytes(6).toString("hex");
const dump = join(tmpdir(), `outside-${tag}.json`), release = join(tmpdir(), `outside-${tag}.release`), failing = join(tmpdir(), `outside-${tag}.fail`), notes = join(tmpdir(), `outside-${tag}.notes`),
  holding = join(tmpdir(), `outside-${tag}.holding`), held = join(tmpdir(), `outside-${tag}.held`);
const engine = `const { existsSync: __has } = await import("node:fs"); process.env.FAKE_CLAUDE_MODE = __has(${JSON.stringify(failing)}) ? "exit-early" : "hang"; process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(dump)}; process.env.FAKE_CLAUDE_RELEASE = __has(${JSON.stringify(holding)}) ? ${JSON.stringify(held)} : ${JSON.stringify(release)}; process.env.FAKE_CLAUDE_TEXT_FILE = ${JSON.stringify(notes)}; process.env.FAKE_CLAUDE_TEXT_DUMP = ${JSON.stringify(`${notes}.dump`)};`;
const KEY = randomBytes(16).toString("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const read = () => { try { return JSON.parse(readFileSync(dump, "utf8")); } catch { return null; } };
async function until<V>(what: string, fn: () => Promise<V> | V, ms = hostTimeout(30_000)): Promise<V> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
}
const said = (marker: string, where: "prompt" | "systemPrompt" = "prompt") => { const turn = read(); return turn && JSON.stringify(turn[where] ?? "").includes(marker) ? turn : null; };
const turnWith = (marker: string, where: "prompt" | "systemPrompt" = "prompt") => until(`a turn with ${marker}`, () => said(marker, where));
const confined = (turn: { argv: string[] }) => turn.argv.includes("--restricted");
const skillNamed = (name: string) => ({ name, description: "Write the digest.", source: "local:test", enabled: true, text: `---\nname: ${name}\ndescription: Write the digest.\n---\n\nWrite the digest.\n` });
const atFull = (turn: { argv: string[] }) => turn.argv[turn.argv.indexOf("--permission-mode") + 1] === "bypassPermissions";

let fx: CloudSendFixture, team: CloudTeamFixture, ada: string;
beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-${randomBytes(8).toString("hex")}`, cloudEngine: engine, desktopEngine: engine, env: { OMB_TEST_INTERNAL_CAPABILITY_KEY: KEY },
    team: { id: "team-acme-1", name: "Acme", engine } });
  team = fx.team!;
  ada = (await team.pair({ email: "ada@acme.test", role: "admin" })).token!;
}, hostTimeout(180_000));
afterAll(async () => {
  writeFileSync(release, "");
  await sleep(500);
  await fx?.close?.();
  for (const file of [dump, release, failing, notes, `${notes}.dump`, holding, held]) rmSync(file, { force: true });
});

const newBot = async (name: string, level = "full") => {
  const bot = (await team.as(ada, "POST", "/api/bots", { name, visibility: "everyone" })).body.bot as { id: string; threadId: string };
  expect((await team.as(ada, "PATCH", `/api/bots/${bot.id}`, { approvalMode: level, applyToAllThreads: true })).status).toBe(200);
  return bot;
};
const newChief = async (name: string) => {
  const bot = await newBot(name);
  expect((await team.as(ada, "PATCH", `/api/bots/${bot.id}`, { chiefOfStaff: true })).status).toBe(200);
  return bot;
};
const hookOn = async (botId: string, name: string) => (await team.as(ada, "POST", "/api/webhooks", { name, prompt: "Handle the event.", botId })).body;
const deliver = async (hook: any, text: string) => {
  const receiver = team.base.replace(/:(\d+)$/, (_: string, port: string) => `:${Number(port) + 1}`);
  const delivered = await fetch(`${receiver}/hooks/${hook.webhook.endpointId}/${encodeURIComponent(hook.credential.secret)}`, { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": randomBytes(6).toString("hex") }, body: JSON.stringify({ text }) });
  expect(delivered.status).toBe(202);
};
const runOf = async (hook: any) => ((await team.as(ada, "GET", "/api/routines")).body.runs as any[]).find((run) => run.webhookId === hook.webhook.id);
const internal = async (botId: string, thread: string, path: string, body: unknown, capability?: string) => {
  const token = capability ?? await team.capability(botId, thread);
  const response = await fetch(`${team.base}${path}?fromBotId=${botId}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ fromBotId: botId, fromThreadId: thread, ...(body as object) }) });
  return { status: response.status, body: await response.json().catch(() => null) as any };
};
const idle = (...ids: string[]) => until(`${ids} idle`, async () => {
  const bots = (await team.as(ada, "GET", "/api/bots")).body.bots as any[];
  return ids.every((id) => !bots.find((bot) => bot.id === id)?.busy);
}, hostTimeout(40_000));
const finish = async (...ids: string[]) => {
  writeFileSync(release, ""); writeFileSync(held, "");
  await idle(...ids);
  await sleep(300);
  for (const file of [release, held, holding, dump]) rmSync(file, { force: true });
};
const linesOf = async (threadId: string) => (await team.as(ada, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
/** The webhook's turn is running on `bot`. */
const webhookTurn = async (botId: string, name: string, marker: string) => {
  const hook = await hookOn(botId, name);
  await deliver(hook, marker);
  const turn = await turnWith(marker);
  const run = await until("the run", () => runOf(hook));
  return { hook, run, turn, thread: run.threadId as string };
};

describe("a Team Cloud", () => {
  it("runs a routine a confined turn makes confined, however it is started", async () => {
    const scout = await newBot("Routine maker");
    const { thread, turn } = await webhookTurn(scout.id, "Routine hook", "marker-routine");
    expect(confined(turn)).toBe(true);
    const made = await internal(scout.id, thread, "/api/internal/trigger-requests", { action: "create", kind: "schedule", routine: { name: "From outside", instructions: "routine-made-outside", schedule: { type: "interval", everyMinutes: 60 } } });
    expect(made.body?.state).toBe("applied");
    expect((await internal(scout.id, thread, "/api/internal/trigger-requests", { action: "run_now", triggerId: made.body.result.resultId })).status).toBe(201);
    const routineTurn = await turnWith("routine-made-outside");
    expect(confined(routineTurn)).toBe(true);
    expect(atFull(routineTurn)).toBe(false);
    const mate = await newBot("Routine mate");
    const runs = (await team.as(ada, "GET", "/api/routines")).body.runs as any[];
    const runThread = runs.find((one) => one.routineId === made.body.result.resultId).threadId as string;
    const handed = await internal(scout.id, runThread, "/api/internal/coordinate-bots", { botIds: [mate.id], message: "brief-from-routine", reply: "none" });
    expect(confined(await turnWith("brief-from-routine"))).toBe(true);
    await finish(scout.id, mate.id);
    expect((await team.as(ada, "POST", `/api/bots/${mate.id}/messages`, { text: "person-after-routine", threadId: handed.body.receipts[0].threadId })).status).toBe(202);
    expect(confined(await turnWith("person-after-routine"))).toBe(true);
    await finish(mate.id);
    // Saved by a person, it is theirs, as its card says.
    const id = made.body.result.resultId as string;
    expect((await team.as(ada, "PATCH", `/api/routines/${id}`, { prompt: "routine-saved-by-a-person" })).status).toBe(200);
    expect((await team.as(ada, "POST", `/api/routines/${id}/run`)).status).toBe(201);
    const saved = await turnWith("routine-saved-by-a-person");
    expect(confined(saved)).toBe(false);
    expect(atFull(saved)).toBe(true);
    await finish(scout.id);
  }, hostTimeout(120_000));

  it("keeps a routine outside work wrote outside, with what its runs write, a bot's change and a person's Undo, until a person saves it", async () => {
    const scout = await newBot("Lineage scout");
    const mate = await newBot("Lineage mate");
    const soon = (ms: number) => new Date(Date.now() + ms).toISOString();
    const runs = async () => (await team.as(ada, "GET", "/api/routines")).body.runs as any[];
    const { thread } = await webhookTurn(scout.id, "Lineage hook", "marker-lineage");
    const made = await internal(scout.id, thread, "/api/internal/trigger-requests", { action: "create", kind: "schedule", routine: { name: "Outside first", instructions: "lineage-first-run", schedule: { type: "interval", everyMinutes: 60 } } });
    const first = made.body.result.resultId as string;
    expect((await internal(scout.id, thread, "/api/internal/trigger-requests", { action: "run_now", triggerId: first })).status).toBe(201);
    expect(confined(await turnWith("lineage-first-run"))).toBe(true);
    const runThread = (await runs()).find((run) => run.routineId === first).threadId as string;
    const made2 = await internal(scout.id, runThread, "/api/internal/trigger-requests", { action: "create", kind: "schedule", forBotId: mate.id,
      routine: { name: "Outside second", instructions: "lineage-new-routine", schedule: { type: "once", at: soon(9_000) } } });
    expect(made2.body?.state).toBe("applied");
    await finish(scout.id, mate.id);
    expect(confined(await turnWith("lineage-new-routine"))).toBe(true);
    await finish(mate.id);
    // A bot changing it from a person's own conversation is not the person saving it.
    const changed = await internal(scout.id, scout.threadId, "/api/internal/trigger-requests", { action: "update", triggerId: first,
      changes: { instructions: "lineage-after-change", schedule: { type: "once", at: soon(8_000) } } });
    expect(changed.body?.state).toBe("applied");
    await finish(scout.id);
    expect(confined(await turnWith("lineage-after-change"))).toBe(true);
    await finish(scout.id);
    const deleted = await internal(scout.id, thread, "/api/internal/trigger-requests", { action: "delete", triggerId: first });
    expect(deleted.body?.state).toBe("applied");
    expect((await team.as(ada, "POST", `/api/threads/${thread}/undo`, { requestId: deleted.body.requestId })).status).toBe(200);
    const restored = ((await team.as(ada, "GET", "/api/routines")).body.routines as any[]).find((one) => one.name === "Outside first" && one.id !== first);
    expect((await team.as(ada, "POST", `/api/routines/${restored.id}/run`)).status).toBe(201);
    expect(confined(await turnWith("lineage-after-change"))).toBe(true);
    await finish(scout.id);
  }, hostTimeout(150_000));

  it("keeps a confined turn from starting or changing a person's routine", async () => {
    const scout = await newBot("Routine starter");
    const mine = (await team.as(ada, "POST", "/api/routines", { name: "Ada's", prompt: "routine-of-a-person", botId: scout.id, resultsThreadId: null, enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } })).body.routine;
    const { thread } = await webhookTurn(scout.id, "Starter hook", "marker-starter");
    const refused = await internal(scout.id, thread, "/api/internal/trigger-requests", { action: "run_now", triggerId: mine.id });
    expect(refused).toMatchObject({ status: 403, body: { error: OUTSIDE_STAYS_HERE } });
    await sleep(800);
    expect(said("routine-of-a-person")).toBeNull();
    const changed = await internal(scout.id, thread, "/api/internal/trigger-requests", { action: "update", triggerId: mine.id, changes: { instructions: "routine-changed-from-outside" } });
    expect(changed).toMatchObject({ status: 403, body: { error: OUTSIDE_STAYS_HERE } });
    expect(((await team.as(ada, "GET", "/api/routines")).body.routines as any[]).find((one) => one.id === mine.id).prompt).toBe("routine-of-a-person");
    await finish(scout.id);
  }, hostTimeout(120_000));

  it("refuses a retry from a confined turn into a person's thread, and keeps its own work confined when it retries that", async () => {
    const chief = await newChief("Retry chief");
    const mate = await newBot("Retry mate");
    const { thread } = await webhookTurn(chief.id, "Retry hook", "marker-retry");
    const capability = await team.capability(chief.id, thread);
    const sent = await internal(chief.id, thread, "/api/internal/coordinate-bots", { botIds: [mate.id], message: "brief-retry", reply: "none" }, capability);
    expect(confined(await turnWith("brief-retry"))).toBe(true);
    const child = sent.body.receipts[0].threadId as string;
    expect((await team.as(ada, "POST", `/api/bots/${mate.id}/interrupt`, { threadId: child })).status).toBe(200);
    await idle(mate.id);
    await sleep(500);
    const refused = await internal(chief.id, thread, "/api/internal/retry-thread", { toBotId: mate.id, toThreadId: mate.threadId, note: "note-into-main" }, capability);
    expect(refused).toMatchObject({ status: 403, body: { error: OUTSIDE_STAYS_HERE } });
    await sleep(800);
    expect(said("note-into-main")).toBeNull();
    expect((await internal(chief.id, thread, "/api/internal/retry-thread", { toBotId: mate.id, toThreadId: child, note: "note-own-work" }, capability)).status).toBe(200);
    expect(confined(await turnWith("note-own-work"))).toBe(true);
    await finish(chief.id, mate.id);
  }, hostTimeout(120_000));

  it("keeps one-way work confined after the run that sent it has ended", async () => {
    const scout = await newBot("Notice sender");
    const mate = await newBot("Notice mate");
    const { hook, thread } = await webhookTurn(scout.id, "Notice hook", "marker-notice");
    const capability = await team.capability(scout.id, thread);
    // The first notice outlasts the run that sent it, so the second starts with that run over.
    writeFileSync(holding, "");
    expect((await internal(scout.id, thread, "/api/internal/coordinate-bots", { botIds: [mate.id], message: "notice-first", reply: "none" }, capability)).status).toBe(200);
    expect(confined(await turnWith("notice-first"))).toBe(true);
    expect((await internal(scout.id, thread, "/api/internal/coordinate-bots", { botIds: [mate.id], message: "notice-second", reply: "none" }, capability)).status).toBe(200);
    writeFileSync(release, "");
    await until("the run to end", async () => (await runOf(hook)).status === "completed");
    writeFileSync(held, "");
    expect(confined(await turnWith("notice-second"))).toBe(true);
    await finish(scout.id, mate.id);
  }, hostTimeout(120_000));

  it("tells a person, not a Chief, when a confined run fails, and a person's retry of that run stays confined", async () => {
    const chief = await newChief("Failure chief");
    const mate = await newBot("Failure mate");
    const hook = await hookOn(mate.id, "Failure hook");
    rmSync(dump, { force: true });
    writeFileSync(failing, "");
    await deliver(hook, "marker-failure");
    const run = await until("the run to fail", async () => { const one = await runOf(hook); return one && ["failed", "missed"].includes(one.status) ? one : null; }, hostTimeout(60_000));
    rmSync(failing, { force: true });
    await sleep(1_000);
    const bots = (await team.as(ada, "GET", "/api/bots")).body.bots as any[];
    expect(bots.find((bot) => bot.id === chief.id).tasks.map((task: any) => task.title), "no notices chat on the Chief").not.toEqual(expect.arrayContaining([expect.stringMatching(/Problems to look at|Team incidents/)]));
    expect((await internal(chief.id, chief.threadId, "/api/internal/retry-thread", { toBotId: mate.id, toThreadId: run.threadId, note: "person-chief-retry" })).status).toBe(200);
    expect(confined(await turnWith("person-chief-retry"))).toBe(true);
    await finish(chief.id, mate.id);
  }, hostTimeout(180_000));

  it("keeps a person's line in a conversation outside work reached confined, and says why once", async () => {
    const scout = await newBot("Follow-up bot");
    const { thread } = await webhookTurn(scout.id, "Follow-up hook", "marker-followup");
    await finish(scout.id);
    expect((await team.as(ada, "POST", `/api/bots/${scout.id}/messages`, { text: "person-line-here", threadId: thread })).status).toBe(202);
    const turn = await turnWith("person-line-here");
    expect(confined(turn)).toBe(true);
    expect(atFull(turn)).toBe(false);
    const told = (await linesOf(thread)).filter((line) => line.kind === "activity" && /Work from outside came into this conversation/.test(line.tool?.name ?? ""));
    expect(told).toHaveLength(1);
    await finish(scout.id);
    const bots = (await team.as(ada, "GET", "/api/bots")).body.bots as any[];
    const results = bots.find((bot) => bot.id === scout.id).tasks.find((task: any) => task.title === "Follow-up hook · Results");
    expect((await team.as(ada, "POST", `/api/bots/${scout.id}/messages`, { text: "person-line-in-results", threadId: results.threadId })).status).toBe(202);
    expect(confined(await turnWith("person-line-in-results"))).toBe(true);
    await finish(scout.id);
  }, hostTimeout(120_000));

  it("keeps a person's own new conversation with the same bot at the bot's level, without its brief reading outside work", async () => {
    const scout = await newBot("Own chat bot");
    const { thread } = await webhookTurn(scout.id, "Own chat hook", "marker-ownchat");
    const handedTo = await newBot("Own chat mate");
    expect((await internal(scout.id, thread, "/api/internal/coordinate-bots", { botIds: [handedTo.id], message: "brief-ownchat", reply: "none" })).status).toBe(200);
    await turnWith("brief-ownchat");
    await finish(scout.id, handedTo.id);
    const theirs = (await team.as(ada, "POST", `/api/bots/${handedTo.id}/tasks`, { title: "Theirs" })).body.task.threadId as string;
    expect((await team.as(ada, "POST", `/api/bots/${handedTo.id}/messages`, { text: "person-chat-with-mate", threadId: theirs })).status).toBe(202);
    const brief = await turnWith("person-chat-with-mate");
    expect(confined(brief)).toBe(false);
    expect(JSON.stringify(brief.systemPrompt)).not.toContain("· work");
    await finish(handedTo.id);
    const mine = (await team.as(ada, "POST", `/api/bots/${scout.id}/tasks`, { title: "Mine" })).body.task.threadId as string;
    expect(mine).not.toBe(thread);
    expect((await team.as(ada, "POST", `/api/bots/${scout.id}/messages`, { text: "person-new-chat", threadId: mine })).status).toBe(202);
    const turn = await turnWith("person-new-chat");
    expect(confined(turn)).toBe(false);
    expect(atFull(turn)).toBe(true);
    await finish(scout.id);
  }, hostTimeout(120_000));

  it("waits on a card for what a confined turn writes to a room's bulletin or a bot's memory", async () => {
    const chief = await newChief("Writer chief");
    const mate = await newBot("Writer mate");
    const room = (await team.as(ada, "POST", "/api/groups", { name: "Writer room", memberIds: [chief.id, mate.id], setup: { bulletin: "as it was", defaultResponder: { kind: "member", botId: mate.id } } })).body.group;
    const { thread } = await webhookTurn(chief.id, "Writer hook", "marker-writer");
    const capability = await team.capability(chief.id, thread);
    const bulletin = await internal(chief.id, thread, "/api/internal/manage-room", { roomId: room.id, action: "set_bulletin", bulletin: "bulletin-from-outside" }, capability);
    expect(bulletin.body).toMatchObject({ state: "pending" });
    const note = await internal(chief.id, thread, "/api/internal/memory", { action: "append", text: "memory-from-outside" }, capability);
    expect(note.body).toMatchObject({ state: "pending" });
    expect((await internal(chief.id, thread, "/api/internal/memory/log", { text: "log-from-outside" }, capability)).status).toBe(403);
    await finish(chief.id, mate.id);
    expect((await team.as(ada, "POST", `/api/groups/${room.id}/messages`, { text: "room-before-card" })).status).toBeLessThan(300);
    const roomTurn = await turnWith("room-before-card");
    expect(JSON.stringify(roomTurn.systemPrompt)).not.toContain("bulletin-from-outside");
    expect(JSON.stringify(roomTurn.systemPrompt)).toContain("as it was");
    await finish(chief.id, mate.id);
    expect((await team.as(ada, "POST", `/api/bots/${chief.id}/messages`, { text: "chief-before-card", threadId: chief.threadId })).status).toBe(202);
    const before = await turnWith("chief-before-card");
    expect(JSON.stringify({ system: before.systemPrompt, prompt: before.prompt })).not.toContain("memory-from-outside");
    await finish(chief.id);
    const member = (await team.pair({ email: "ben@acme.test", role: "member" })).token!;
    const answer = (token: string, requestId: string) => team.as(token, "POST", `/api/threads/${thread}/respond`, { requestId, behavior: "allow" });
    expect((await answer(member, bulletin.body.requestId)).status).toBe(403);
    expect((await answer(ada, bulletin.body.requestId)).status).toBe(200);
    expect((await answer(ada, note.body.requestId)).status).toBe(200);
    expect(((await team.as(ada, "GET", "/api/bots?messages=0")).body.groups as any[]).find((group) => group.id === room.id).bulletin).toBe("bulletin-from-outside");
    expect((await team.as(ada, "POST", `/api/bots/${chief.id}/messages`, { text: "chief-after-card", threadId: chief.threadId })).status).toBe(202);
    const after = await turnWith("chief-after-card");
    expect(JSON.stringify({ system: after.systemPrompt, prompt: after.prompt })).toContain("memory-from-outside");
    await finish(chief.id);
  }, hostTimeout(180_000));

  it("keeps outside text out of work a person started, by thread and by question", async () => {
    const chief = await newChief("Fold chief");
    const mate = await newBot("Fold mate");
    expect((await team.as(ada, "POST", `/api/bots/${chief.id}/messages`, { text: "person-line-fold", threadId: chief.threadId })).status).toBe(202);
    await turnWith("person-line-fold");
    const handed = await internal(chief.id, chief.threadId, "/api/internal/coordinate-bots", { botIds: [mate.id], message: "person-work-fold" });
    expect(confined(await turnWith("person-work-fold"))).toBe(false);
    const work = handed.body.receipts[0].threadId as string;
    const { thread } = await webhookTurn(chief.id, "Fold hook", "marker-fold");
    const sent = await internal(chief.id, thread, "/api/internal/coordinate-bots", { botIds: [mate.id], thread: work, message: "line-for-the-work" });
    expect(sent.body.receipts[0]).toMatchObject({ outcome: "failed", detail: OUTSIDE_STAYS_HERE });
    await sleep(800);
    expect(JSON.stringify(await linesOf(work))).not.toContain("line-for-the-work");
    const named = await internal(chief.id, thread, "/api/internal/coordinate-bots", { botIds: [mate.id], message: "line-as-answer", answers: handed.body.receipts[0].requestId });
    expect(named.body.receipts[0].outcome).toBe("failed");
    expect(JSON.stringify(await linesOf(work))).not.toContain("line-as-answer");
    await finish(chief.id, mate.id);
  }, hostTimeout(120_000));

  it("refuses a confined post into a room people work in, leaving nothing there", async () => {
    const chief = await newChief("Post chief");
    const mate = await newBot("Post mate");
    const room = (await team.as(ada, "POST", "/api/groups", { name: "Post room", memberIds: [chief.id, mate.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: mate.id } } })).body.group;
    const { thread } = await webhookTurn(chief.id, "Post hook", "marker-post");
    const capability = await team.capability(chief.id, thread);
    expect(await internal(chief.id, thread, "/api/internal/post-to-room", { groupId: room.id, message: "post-from-outside" }, capability)).toMatchObject({ status: 403, body: { error: OUTSIDE_STAYS_HERE } });
    const handed = await internal(chief.id, thread, "/api/internal/coordinate-bots", { groupId: room.id, botIds: [mate.id], message: "room-work-from-outside" }, capability);
    expect(handed).toMatchObject({ status: 403, body: { error: OUTSIDE_STAYS_HERE } });
    expect(JSON.stringify(await linesOf(room.threadId))).not.toContain("from-outside");
    await finish(chief.id, mate.id);
  }, hostTimeout(120_000));

  it("refuses what a confined turn could run or start with nobody deciding", async () => {
    const chief = await newChief("Fence chief");
    const { thread } = await webhookTurn(chief.id, "Fence hook", "marker-fence");
    const capability = await team.capability(chief.id, thread);
    for (const route of ["vm-exec", "fill-login", "create-room", "people/message", "request-credential"]) {
      expect(await internal(chief.id, thread, `/api/internal/${route}`, { name: "x", command: "true", to: "a@acme.test", message: "x" }, capability), route).toMatchObject({ status: 403, body: { error: OUTSIDE_REFUSAL } });
    }
    await finish(chief.id);
  }, hostTimeout(120_000));

  it("saves nothing from a confined conversation into a bot's memory or log on its own, where a person's own chat is saved", async () => {
    writeFileSync(notes, JSON.stringify({ facts: [{ text: "fact-from-a-chat", kind: "decision" }] }));
    expect((await team.as(ada, "PUT", "/api/config", { memory: { captureQuietMs: 1_000 } })).status).toBe(200);
    const saved = (botId: string) => {
      const root = join(team.home, ".openmausbot", "workspaces");
      return readdirSync(root).filter((name) => name.startsWith(botId)).flatMap((name) => {
        const logs = join(root, name, "memory", "log");
        return [join(root, name, "MEMORY.md"), ...(existsSync(logs) ? readdirSync(logs).map((file) => join(logs, file)) : [])];
      }).filter((file) => existsSync(file)).map((file) => readFileSync(file, "utf8")).join("\n");
    };
    const scout = await newBot("Capture scout");
    const mate = await newBot("Capture mate");
    const { thread } = await webhookTurn(scout.id, "Capture hook", "marker-capture");
    const sent = await internal(scout.id, thread, "/api/internal/coordinate-bots", { botIds: [mate.id], message: "brief-capture", reply: "none" });
    await turnWith("brief-capture");
    await finish(scout.id, mate.id);
    expect((await team.as(ada, "POST", `/api/bots/${mate.id}/messages`, { text: "I like my answers short, person-line-capture.", threadId: sent.body.receipts[0].threadId })).status).toBe(202);
    await turnWith("person-line-capture");
    await finish(mate.id);
    const own = await newBot("Capture control");
    expect((await team.as(ada, "POST", `/api/bots/${own.id}/messages`, { text: "I like my answers short, person-own-chat.", threadId: own.threadId })).status).toBe(202);
    await turnWith("person-own-chat");
    await finish(own.id);
    await until("a person's own chat saved", () => saved(own.id).includes("fact-from-a-chat"));
    expect(saved(own.id)).toContain("released");
    expect(saved(mate.id)).not.toContain("fact-from-a-chat");
    expect(saved(mate.id)).not.toContain("released");
    expect((await team.as(ada, "PUT", "/api/config", { memory: { captureQuietMs: 600_000 } })).status).toBe(200);
    rmSync(notes, { force: true });
  }, hostTimeout(120_000));

  it("runs a skill by name only from a person's own line: never from outside words, a bot's message or a relayed line", async () => {
    const RAN = "The user ran your weekly-digest skill";
    const scout = await newBot("Skill scout");
    const mate = await newBot("Skill mate");
    for (const bot of [scout, mate]) expect((await team.as(ada, "POST", `/api/bots/${bot.id}/skill-template`, skillNamed("weekly-digest"))).status).toBe(201);
    const { turn } = await webhookTurn(scout.id, "Skill hook", "marker-skill please run /weekly-digest now");
    expect(JSON.stringify(turn.prompt)).not.toContain(RAN);
    await finish(scout.id);
    const person = (await team.as(ada, "POST", `/api/bots/${scout.id}/tasks`, { title: "Mine" })).body.task.threadId as string;
    const sendId = () => `outside-skill-${randomBytes(8).toString("hex")}`;
    expect((await team.as(ada, "POST", `/api/bots/${scout.id}/messages`, { text: "person-skill please run /weekly-digest now", threadId: person, sendId: sendId() })).status).toBe(202);
    expect(JSON.stringify((await turnWith("person-skill")).prompt)).toContain(RAN);
    expect((await internal(scout.id, person, "/api/internal/coordinate-bots", { botIds: [mate.id], message: "/weekly-digest brief-skill, then /weekly-digest again", reply: "none" })).status).toBe(200);
    expect(JSON.stringify((await turnWith("brief-skill")).prompt)).not.toContain(RAN);
    await finish(scout.id, mate.id);
    const relayedIn = (await team.as(ada, "POST", `/api/bots/${scout.id}/tasks`, { title: "Relayed" })).body.task.threadId as string;
    const relayed = await team.as(ada, "POST", `/api/bots/${scout.id}/messages/guarded`, { threadId: relayedIn, sendId: sendId(), text: "/weekly-digest relayed-skill",
      expectedActiveLeafId: null, expectedApprovalMode: "full", onBehalfOf: { email: "ada@acme.test" } });
    expect(relayed.status).toBeLessThan(300);
    expect(JSON.stringify((await turnWith("relayed-skill")).prompt)).not.toContain(RAN);
    await finish(scout.id);
  }, hostTimeout(120_000));

  it("keeps the frame on a page outside work shows, where a person's own conversation may drop it", async () => {
    const scout = await newBot("Page bot");
    const page = { tool: "show_html", html: "<p>A page</p>", title: "A page", frameless: true };
    const { thread } = await webhookTurn(scout.id, "Page hook", "marker-page");
    const shown = await internal(scout.id, thread, "/api/internal/options-card", page);
    expect(shown.status).toBe(201);
    expect((await linesOf(thread)).find((line) => line.id === shown.body.messageId).app.border).toBe(true);
    await finish(scout.id);
    const person = (await team.as(ada, "POST", `/api/bots/${scout.id}/tasks`, { title: "Mine" })).body.task.threadId as string;
    expect((await team.as(ada, "POST", `/api/bots/${scout.id}/messages`, { text: "person-page", threadId: person })).status).toBe(202);
    await turnWith("person-page");
    const own = await internal(scout.id, person, "/api/internal/options-card", page);
    expect(own.status).toBe(201);
    expect((await linesOf(person)).find((line) => line.id === own.body.messageId).app.border).toBe(false);
    await finish(scout.id);
  }, hostTimeout(120_000));

  it("keeps a goal step in a conversation holding outside work confined, with what it hands on", async () => {
    const scout = await newChief("Goal bot");
    const mate = await newBot("Goal mate");
    expect((await team.as(ada, "POST", `/api/bots/${mate.id}/messages`, { text: "person-line-goal", threadId: mate.threadId })).status).toBe(202);
    await turnWith("person-line-goal");
    await finish(mate.id);
    const { thread } = await webhookTurn(scout.id, "Goal hook", "marker-goal");
    await finish(scout.id);
    expect((await team.as(ada, "POST", `/api/bots/${scout.id}/messages`, { text: "goal-in-this-thread: finish it", mode: "goal", threadId: thread })).status).toBe(202);
    expect(confined(await turnWith("goal-in-this-thread"))).toBe(true);
    const capability = await team.capability(scout.id, thread);
    const handed = await internal(scout.id, thread, "/api/internal/coordinate-bots", { botIds: [mate.id], message: "brief-from-goal", reply: "none" }, capability);
    expect(handed.status).toBe(200);
    expect(confined(await turnWith("brief-from-goal"))).toBe(true);
    expect(await internal(scout.id, thread, "/api/internal/retry-thread", { toBotId: mate.id, toThreadId: mate.threadId, note: "note-from-goal" }, capability)).toMatchObject({ status: 403, body: { error: OUTSIDE_STAYS_HERE } });
    expect((await team.as(ada, "POST", `/api/bots/${scout.id}/interrupt`, { threadId: thread })).status).toBe(200);
    await finish(scout.id, mate.id);
    expect((await team.as(ada, "POST", `/api/bots/${mate.id}/messages`, { text: "person-after-goal", threadId: handed.body.receipts[0].threadId })).status).toBe(202);
    expect(confined(await turnWith("person-after-goal"))).toBe(true);
    await finish(mate.id);
  }, hostTimeout(120_000));

  it("judges work again after a restart as it stood before", async () => {
    const scout = await newBot("Restart bot");
    const mate = await newBot("Restart mate");
    const { thread } = await webhookTurn(scout.id, "Restart hook", "marker-restart");
    const capability = await team.capability(scout.id, thread);
    writeFileSync(holding, "");
    const sent = await internal(scout.id, thread, "/api/internal/coordinate-bots", { botIds: [mate.id], message: "work-across-restart", reply: "none" }, capability);
    expect(confined(await turnWith("work-across-restart"))).toBe(true);
    expect((await internal(scout.id, thread, "/api/internal/coordinate-bots", { botIds: [mate.id], message: "work-queued-at-restart", reply: "none" }, capability)).status).toBe(200);
    const child = sent.body.receipts[0].threadId as string;
    rmSync(dump, { force: true });
    await team.relaunch();
    ada = (await team.pair({ email: "ada@acme.test", role: "admin" })).token!;
    writeFileSync(held, "");
    expect(confined(await turnWith("work-queued-at-restart"))).toBe(true);
    await finish(scout.id, mate.id);
    expect((await team.as(ada, "POST", `/api/bots/${mate.id}/messages`, { text: "person-after-restart", threadId: child })).status).toBe(202);
    expect(confined(await turnWith("person-after-restart"))).toBe(true);
    await finish(mate.id);
    expect((await team.as(ada, "POST", `/api/bots/${scout.id}/messages`, { text: "person-in-run-thread", threadId: thread })).status).toBe(202);
    expect(confined(await turnWith("person-in-run-thread"))).toBe(true);
    await finish(scout.id);
  }, hostTimeout(180_000));

  it("counts a run from before the conversation kept its own record", async () => {
    const scout = await newBot("Earlier bot");
    const { thread } = await webhookTurn(scout.id, "Earlier hook", "marker-earlier");
    await finish(scout.id);
    const file = join(team.home, ".openmausbot", "bots.json");
    const before = readFileSync(file, "utf8");
    expect(before).toContain('"outside":true');
    writeFileSync(file, before.replaceAll('"outside":true', '"unmarked":true'));
    await team.relaunch();
    ada = (await team.pair({ email: "ada@acme.test", role: "admin" })).token!;
    expect((await team.as(ada, "POST", `/api/bots/${scout.id}/messages`, { text: "person-line-earlier", threadId: thread })).status).toBe(202);
    expect(confined(await turnWith("person-line-earlier"))).toBe(true);
    await finish(scout.id);
  }, hostTimeout(180_000));

  it("leaves a person's own work as it was: their level, hand-offs, threads, posts, notes and retries", async () => {
    const chief = await newChief("Person chief");
    const mate = await newBot("Person mate");
    const room = (await team.as(ada, "POST", "/api/groups", { name: "Person room", memberIds: [chief.id, mate.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: mate.id } } })).body.group;
    expect((await team.as(ada, "POST", `/api/bots/${chief.id}/messages`, { text: "person-line-own", threadId: chief.threadId })).status).toBe(202);
    const turn = await turnWith("person-line-own");
    expect(confined(turn)).toBe(false);
    expect(atFull(turn)).toBe(true);
    const capability = await team.capability(chief.id, chief.threadId);
    const handed = await internal(chief.id, chief.threadId, "/api/internal/coordinate-bots", { botIds: [mate.id], message: "person-handed-work", reply: "none" }, capability);
    const handedTurn = await turnWith("person-handed-work");
    expect(confined(handedTurn)).toBe(false);
    expect(atFull(handedTurn)).toBe(true);
    expect((await internal(chief.id, chief.threadId, "/api/internal/post-to-room", { groupId: room.id, message: "person-room-post" }, capability)).status).toBe(201);
    expect(((await internal(chief.id, chief.threadId, "/api/internal/memory", { action: "append", text: "person-note" }, capability)).body as any)?.state).not.toBe("pending");
    expect((await internal(chief.id, chief.threadId, "/api/internal/manage-room", { roomId: room.id, action: "set_bulletin", bulletin: "person-bulletin" }, capability)).status).toBe(200);
    await team.as(ada, "POST", `/api/bots/${mate.id}/interrupt`, { threadId: handed.body.receipts[0].threadId });
    await idle(mate.id);
    await sleep(500);
    expect((await internal(chief.id, chief.threadId, "/api/internal/retry-thread", { toBotId: mate.id, toThreadId: handed.body.receipts[0].threadId, note: "person-retry" }, capability)).status).toBe(200);
    const retried = await turnWith("person-retry");
    expect(confined(retried)).toBe(false);
    await finish(chief.id, mate.id);
  }, hostTimeout(180_000));
});

describe("a personal Cloud only its owner has used", () => {
  it("runs a webhook at the bot's level, and keeps what a routine it made hands on confined after that work ends", async () => {
    rmSync(dump, { force: true });
    const cloud = fx.onCloud;
    const scout = (await cloud("POST", "/api/bots", { name: "Solo scout" })).body.bot;
    const mate = (await cloud("POST", "/api/bots", { name: "Solo mate" })).body.bot;
    for (const bot of [scout, mate]) expect((await cloud("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full", applyToAllThreads: true })).status).toBe(200);
    const hook = (await cloud("POST", "/api/webhooks", { name: "Solo hook", prompt: "Handle the event.", botId: scout.id })).body;
    const receiver = fx.cloudBase.replace(/:(\d+)$/, (_: string, port: string) => `:${Number(port) + 1}`);
    expect((await fetch(`${receiver}/hooks/${hook.webhook.endpointId}/${encodeURIComponent(hook.credential.secret)}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomBytes(6).toString("hex") }, body: JSON.stringify({ text: "marker-solo" }) })).status).toBe(202);
    const webhook = await turnWith("marker-solo");
    expect(confined(webhook)).toBe(false);
    const capabilityFor = async (botId: string, threadId: string) => ((await (await fetch(`${fx.cloudBase}/api/testing/internal-capability`, { method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": KEY }, body: JSON.stringify({ botId, threadId }) })).json()) as any).token as string;
    const call = async (from: string, path: string, body: object) => {
      const response = await fetch(`${fx.cloudBase}${path}?fromBotId=${scout.id}`, { method: "POST", headers: { authorization: `Bearer ${await capabilityFor(scout.id, from)}`, "content-type": "application/json" }, body: JSON.stringify({ fromBotId: scout.id, fromThreadId: from, ...body }) });
      return { status: response.status, body: await response.json().catch(() => null) as any };
    };
    const runs = async () => (await cloud("GET", "/api/routines")).body.runs as any[];
    const hookThread = (await runs()).find((run) => run.webhookId === hook.webhook.id).threadId as string;
    const made = await call(hookThread, "/api/internal/trigger-requests", { action: "create", kind: "schedule", routine: { name: "Solo routine", instructions: "solo-routine-run", schedule: { type: "interval", everyMinutes: 60 } } });
    expect((await call(hookThread, "/api/internal/trigger-requests", { action: "run_now", triggerId: made.body.result.resultId })).status).toBe(201);
    expect(confined(await turnWith("solo-routine-run"))).toBe(true);
    const runThread = (await runs()).find((run) => run.routineId === made.body.result.resultId).threadId as string;
    const handed = await call(runThread, "/api/internal/coordinate-bots", { botIds: [mate.id], message: "solo-brief", reply: "none" });
    expect(confined(await turnWith("solo-brief"))).toBe(true);
    writeFileSync(release, "");
    await sleep(2_500);
    rmSync(release, { force: true });
    rmSync(dump, { force: true });
    expect((await cloud("POST", `/api/bots/${mate.id}/messages`, { text: "owner-line-solo", threadId: handed.body.receipts[0].threadId })).status).toBe(202);
    expect(confined(await turnWith("owner-line-solo"))).toBe(true);
    writeFileSync(release, "");
    await sleep(1_500);
    rmSync(release, { force: true });
    rmSync(dump, { force: true });
    const second = await call(runThread, "/api/internal/trigger-requests", { action: "create", kind: "schedule", forBotId: mate.id,
      routine: { name: "Solo second", instructions: "solo-new-routine", schedule: { type: "once", at: new Date(Date.now() + 6_000).toISOString() } } });
    expect(second.body?.state).toBe("applied");
    expect(confined(await turnWith("solo-new-routine"))).toBe(true);
    writeFileSync(release, "");
    await sleep(1_500);
    rmSync(release, { force: true });
  }, hostTimeout(120_000));
});

describe("a personal Cloud someone else has used", () => {
  it("keeps a confined turn out of the owner's conversations and their room's instructions", async () => {
    rmSync(dump, { force: true });
    const cloud = fx.onCloud;
    const chief = (await cloud("POST", "/api/bots", { name: "Chief" })).body.bot;
    expect((await cloud("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true })).status).toBe(200);
    const mate = (await cloud("POST", "/api/bots", { name: "Mate" })).body.bot;
    expect((await cloud("PATCH", `/api/bots/${mate.id}`, { approvalMode: "full", applyToAllThreads: true })).status).toBe(200);
    const room = (await cloud("POST", "/api/groups", { name: "Owner's room", memberIds: [chief.id, mate.id], setup: { bulletin: "as it was", defaultResponder: { kind: "member", botId: mate.id } } })).body.group;
    const theirs = (await cloud("POST", `/api/bots/${chief.id}/tasks`, { title: "Left behind" })).body.task.threadId as string;
    const capabilityFor = async (botId: string, threadId: string) => ((await (await fetch(`${fx.cloudBase}/api/testing/internal-capability`, { method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": KEY }, body: JSON.stringify({ botId, threadId }) })).json()) as any).token as string;
    const call = async (capability: string, from: string, path: string, body: object) => {
      const response = await fetch(`${fx.cloudBase}${path}?fromBotId=${chief.id}`, { method: "POST", headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" }, body: JSON.stringify({ fromBotId: chief.id, fromThreadId: from, ...body }) });
      return { status: response.status, body: await response.json().catch(() => null) as any };
    };
    // A page shown without its frame before outside work reached this conversation.
    const page = await call(await capabilityFor(chief.id, theirs), theirs, "/api/internal/options-card", { tool: "show_html", html: "<p>Before</p>", title: "Before", frameless: true });
    expect(page.status).toBe(201);
    const borderOf = async () => ((await cloud("GET", `/api/threads/${theirs}/messages?limit=200`)).body.messages as any[]).find((line) => line.id === page.body.messageId).app.border;
    expect(await borderOf()).toBe(false);
    // A turn of the owner's ends the work that page came from, so nothing of it runs again after the restart.
    expect((await cloud("POST", `/api/bots/${chief.id}/messages`, { text: "before-mark", threadId: theirs })).status).toBe(202);
    await turnWith("before-mark");
    writeFileSync(release, "");
    await sleep(1_500);
    for (const file of [release, dump]) rmSync(file, { force: true });
    markLeftBehind(join(fx.root, "cloud", ".openmausbot"), { threadIds: [theirs] });
    await fx.relaunch({ kill: false, cloud: {} });
    expect((await cloud("POST", `/api/bots/${chief.id}/messages`, { text: "their-line", threadId: theirs })).status).toBe(202);
    expect(confined(await turnWith("their-line"))).toBe(true);
    const capability = await capabilityFor(chief.id, theirs);
    expect((await call(capability, theirs, "/api/internal/options-card", { tool: "update_html", app_id: page.body.messageId, html: "<p>After</p>" })).status).toBeLessThan(300);
    expect(await borderOf()).toBe(true);

    expect(await call(capability, theirs, "/api/internal/retry-thread", { toBotId: mate.id, toThreadId: mate.threadId, note: "note-for-owner" })).toMatchObject({ status: 403, body: { error: OUTSIDE_STAYS_HERE } });
    await sleep(800);
    expect(said("note-for-owner")).toBeNull();

    expect(await call(capability, theirs, "/api/internal/vm-exec", { command: "true" })).toMatchObject({ status: 403, body: { error: OUTSIDE_REFUSAL } });
    expect(await call(capability, theirs, "/api/internal/post-to-room", { groupId: room.id, message: "post-for-owner" })).toMatchObject({ status: 403, body: { error: OUTSIDE_STAYS_HERE } });

    const bulletin = await call(capability, theirs, "/api/internal/manage-room", { roomId: room.id, action: "set_bulletin", bulletin: "bulletin-for-owner" });
    expect(bulletin.body).toMatchObject({ state: "pending" });
    expect(((await cloud("GET", "/api/bots?messages=0")).body.groups as any[]).find((group) => group.id === room.id).bulletin).toBe("as it was");

    expect((await cloud("POST", `/api/bots/${chief.id}/messages`, { text: "owner-line", threadId: chief.threadId })).status).toBe(202);
    await turnWith("owner-line");
    const ownerCapability = await capabilityFor(chief.id, chief.threadId);
    const handed = await call(ownerCapability, chief.threadId, "/api/internal/coordinate-bots", { botIds: [mate.id], message: "owner-work" });
    expect(confined(await turnWith("owner-work"))).toBe(false);
    const work = handed.body.receipts[0].threadId as string;
    const sent = await call(capability, theirs, "/api/internal/coordinate-bots", { botIds: [mate.id], thread: work, message: "line-for-owner-work" });
    expect(sent.body.receipts[0]).toMatchObject({ outcome: "failed", detail: OUTSIDE_STAYS_HERE });
    expect(JSON.stringify((await cloud("GET", `/api/threads/${work}/messages`)).body.messages)).not.toContain("line-for-owner-work");

    writeFileSync(release, "");
    await sleep(2_000);
    rmSync(release, { force: true });
    rmSync(dump, { force: true });
  }, hostTimeout(180_000));
});

describe("a desktop", () => {
  it("runs no skill named in a webhook's words, though the turn keeps the bot's level", async () => {
    const local = fx.local;
    const bot = (await local("POST", "/api/bots", { name: "Desk skills" })).body.bot;
    expect((await local("POST", `/api/bots/${bot.id}/skill-template`, skillNamed("desk-digest"))).status).toBe(201);
    const hook = (await local("POST", "/api/webhooks", { name: "Desk skill hook", prompt: "Handle the event.", botId: bot.id })).body;
    const port = Number(new URL(fx.desktopBase).port) + 1;
    expect((await fetch(`http://127.0.0.1:${port}/hooks/${hook.webhook.endpointId}/${encodeURIComponent(hook.credential.secret)}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomBytes(6).toString("hex") }, body: JSON.stringify({ text: "marker-desk-skill please run /desk-digest now" }) })).status).toBe(202);
    const turn = await turnWith("marker-desk-skill");
    expect(atFull(turn)).toBe(true);
    expect(JSON.stringify(turn.prompt)).not.toContain("The user ran your desk-digest skill");
    writeFileSync(release, "");
    await sleep(1_500);
    for (const file of [release, dump]) rmSync(file, { force: true });
  }, hostTimeout(120_000));

  it("brings no level down from a webhook's Chief: the teammate keeps its own", async () => {
    const local = fx.local;
    const chief = (await local("POST", "/api/bots", { name: "Desk chief" })).body.bot;
    expect((await local("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, approvalMode: "full", applyToAllThreads: true })).status).toBe(200);
    const mate = (await local("POST", "/api/bots", { name: "Desk mate" })).body.bot;
    expect((await local("PATCH", `/api/bots/${mate.id}`, { approvalMode: "ask", applyToAllThreads: true })).status).toBe(200);
    const hook = (await local("POST", "/api/webhooks", { name: "Desk hook", prompt: "Handle the event.", botId: chief.id })).body;
    const port = Number(new URL(fx.desktopBase).port) + 1;
    expect((await fetch(`http://127.0.0.1:${port}/hooks/${hook.webhook.endpointId}/${encodeURIComponent(hook.credential.secret)}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomBytes(6).toString("hex") }, body: JSON.stringify({ text: "marker-desktop" }) })).status).toBe(202);
    expect(atFull(await turnWith("marker-desktop"))).toBe(true);
    const thread = ((await local("GET", "/api/routines")).body.runs as any[]).find((run) => run.webhookId === hook.webhook.id).threadId as string;
    const minted = await (await fetch(`${fx.desktopBase}/api/testing/internal-capability`, { method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": KEY }, body: JSON.stringify({ botId: chief.id, threadId: thread }) })).json() as any;
    const sent = await fetch(`${fx.desktopBase}/api/internal/coordinate-bots?fromBotId=${chief.id}`, { method: "POST", headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" }, body: JSON.stringify({ fromBotId: chief.id, fromThreadId: thread, botIds: [mate.id], message: "brief-desktop", reply: "none" }) });
    expect(sent.status).toBe(200);
    expect(atFull(await turnWith("brief-desktop"))).toBe(false);
    writeFileSync(release, "");
    await sleep(1_500);
    rmSync(release, { force: true });
  }, hostTimeout(120_000));
});
