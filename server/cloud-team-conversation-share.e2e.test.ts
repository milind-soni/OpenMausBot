// Sharing a private conversation and saving to team memory on a real Team Cloud, as its owner and as hostile callers:
// only the conversation's own person shares it or saves from it, nobody else (another member, an admin) reaches it
// before or after, a conversation shared with one person is read by those two alone and carries the bot's context
// without either person's private notes, and a line saved to team memory reaches the next conversation with that bot.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const ENGINE = `process.env.FAKE_CLAUDE_DUMP = process.env.FAKE_CLAUDE_FIXTURE_DIR + "/dump.json";
process.env.FAKE_CLAUDE_EXIT_AFTER_TURN = "1";`;
const OLIVE = { email: "olive@acme.test", role: "owner" as const };
const RUI = { email: "rui@acme.test", role: "member" as const };
const MARTA = { email: "marta@acme.test", role: "member" as const };
const ANA = { email: "ana@acme.test", role: "member" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const HANDOFF = "Kumquat launch: the supplier is Ortega, call before Friday";
const OTHER = "Rui's other private chat about his salary";
const RUI_NOTE = "Rui prefers to be called Ruizinho";
const DECISION = "We ship the Kumquat launch on 3 March";

type Task = { threadId: string; title?: string; private?: true; shared?: true; sharedWith?: { name: string; byYou?: true } };
type Bot = { id: string; mainThreadId: string; tasks: Task[] };
type Dump = { env: Record<string, string>; prompt: unknown; systemPrompt?: string };
const said = (dump: Dump) => `${JSON.stringify(dump.prompt)}\n${dump.systemPrompt ?? ""}`;

let fx: CloudSendFixture, team: CloudTeamFixture;
const tokens = { olive: "", rui: "", marta: "", ana: "", ben: "" };
type Who = keyof typeof tokens;
let scout = "", vault = "", handoff = "", other = "";

const as = (who: Who, method: string, path: string, body?: unknown) => team.as(tokens[who], method, path, body);
const messages = async (who: Who, threadId: string) => as(who, "GET", `/api/threads/${threadId}/messages?limit=200`);
const scoutOf = async (who: Who) => ((await as(who, "GET", "/api/bots?messages=0")).body.bots as Bot[]).find((bot) => bot.id === scout)!;
const taskOf = async (who: Who, threadId: string) => (await scoutOf(who)).tasks.find((task) => task.threadId === threadId);
const idle = async (who: Who) => ((await as(who, "GET", "/api/bots")).body.bots as Array<{ activity?: string; busy?: boolean }>).every((bot) => bot.activity !== "working" && !bot.busy);
const inboxLines = async (who: Who) => JSON.stringify((await as(who, "GET", "/api/inbox")).body.rows ?? []);
type Row = { id: string; text: string; tab: string; origin?: { threadId: string } };
const openRows = async (who: Who, threadId: string) => (((await as(who, "GET", "/api/inbox")).body.rows ?? []) as Row[]).filter((row) => row.origin?.threadId === threadId && row.tab !== "done");
const notifications = async (who: Who) => JSON.stringify((await as(who, "GET", "/api/notifications")).body);

/** expect.poll, usable in beforeAll too. */
async function until(done: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function turn(who: Who, botId: string, threadId: string, text: string): Promise<Dump> {
  rmSync(join(team.home, "dump.json"), { force: true });
  const before = ((await messages(who, threadId)).body.messages as unknown[]).length;
  const sent = await as(who, "POST", `/api/bots/${botId}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  await until(async () => await idle(who) && ((await messages(who, threadId)).body.messages as unknown[]).length >= before + 2 && existsSync(join(team.home, "dump.json")));
  return JSON.parse(readFileSync(join(team.home, "dump.json"), "utf8")) as Dump;
}
const opened = async (who: Who, botId: string, title: string) => {
  const made = await as(who, "POST", `/api/bots/${botId}/tasks`, { title });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.task.threadId as string;
};
const lastLine = async (who: Who, threadId: string) => ((await messages(who, threadId)).body.messages as Array<{ id: string; role: string }>).at(-1)!.id;

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-share-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-share", name: "Acme", engine: ENGINE } });
  team = fx.team!;
  for (const [who, person] of [["olive", OLIVE], ["rui", RUI], ["marta", MARTA], ["ana", ANA], ["ben", BEN]] as const) tokens[who] = (await team.pair(person)).token!;
  const created = await as("olive", "POST", "/api/bots", { name: "Scout", visibility: "everyone" });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  scout = created.body.bot.id;
  const locked = await as("olive", "POST", "/api/bots", { name: "Vault" });
  vault = locked.body.bot.id;
  expect((await as("olive", "PUT", `/api/bots/${vault}/access`, { everyone: "none", people: { [RUI.email]: "chat" } })).status).toBe(200);
  expect((await as("rui", "PUT", `/api/bots/${scout}/memory/mine/file`, { path: "MEMORY.md", text: `- ${RUI_NOTE}\n` })).status).toBe(200);
  handoff = await opened("rui", scout, "Kumquat launch");
  await turn("rui", scout, handoff, HANDOFF);
  other = await opened("rui", scout, "Salary");
  await turn("rui", scout, other, OTHER);
}, hostTimeout(240_000));

afterAll(async () => {
  await fx?.close();
});

describe("sharing a private conversation", () => {
  it("is refused to anyone but its person, and changes nothing for them: another member and an admin get no such conversation", async () => {
    for (const who of ["ben", "olive", "marta"] as const) {
      expect((await as(who, "GET", `/api/bots/${scout}/tasks/${handoff}/share`)).status, `${who}: reading its sharing`).toBe(404);
      expect((await as(who, "POST", `/api/bots/${scout}/tasks/${handoff}/share`, { with: "team" })).status, `${who}: sharing it with the team`).toBe(404);
      expect((await as(who, "POST", `/api/bots/${scout}/tasks/${handoff}/share`, { with: { email: `${who}@acme.test` } })).status, `${who}: sharing it with themselves`).toBe(404);
      expect((await messages(who, handoff)).status, `${who}: reading it`).toBe(404);
    }
    expect((await taskOf("rui", handoff))?.private).toBe(true);
    expect((await taskOf("rui", handoff))?.shared).toBeUndefined();
  }, hostTimeout(60_000));

  it("offers its person the teammates who can chat with the bot, and refuses one who can't", async () => {
    const offered = await as("rui", "GET", `/api/bots/${scout}/tasks/${handoff}/share`);
    expect(offered.status).toBe(200);
    expect(offered.body.shared).toBeNull();
    expect((offered.body.people as Array<{ email: string }>).map((person) => person.email).sort()).toEqual([ANA.email, BEN.email, MARTA.email, OLIVE.email].sort());
    const locked = await opened("rui", vault, "Vault notes");
    expect((await as("rui", "GET", `/api/bots/${vault}/tasks/${locked}/share`)).body.people).toEqual([expect.objectContaining({ email: OLIVE.email })]);
    const refused = await as("rui", "POST", `/api/bots/${vault}/tasks/${locked}/share`, { with: { email: MARTA.email } });
    expect(refused.status).toBe(409);
    expect(refused.body.errorKey).toBe("serverError.share.cantUse");
    expect((await as("rui", "POST", `/api/bots/${scout}/tasks/${handoff}/share`, { with: { email: "nobody@else.test" } })).body.errorKey).toBe("serverError.share.notTeammate");
    expect((await as("rui", "POST", `/api/bots/${scout}/tasks/${handoff}/share`, { with: "private" })).status, "there is no way back").toBe(400);
  }, hostTimeout(60_000));

  it("with one person: only Rui and Marta read it, all of it, and Marta alone hears of it, once, in her inbox", async () => {
    const before = { ana: await inboxLines("ana"), ben: await inboxLines("ben"), olive: await inboxLines("olive") };
    const shared = await as("rui", "POST", `/api/bots/${scout}/tasks/${handoff}/share`, { with: { email: MARTA.email } });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect(shared.body.shared).toEqual({ email: MARTA.email, name: expect.any(String) });

    const page = await messages("marta", handoff);
    expect(page.status).toBe(200);
    expect(JSON.stringify(page.body), "everything already in it").toContain(HANDOFF);
    expect(await taskOf("marta", handoff)).toMatchObject({ shared: true, sharedWith: { name: expect.any(String) } });
    expect((await taskOf("marta", handoff))?.private).toBeUndefined();
    expect((await taskOf("marta", handoff))?.sharedWith?.byYou).toBeUndefined();
    expect(await taskOf("rui", handoff)).toMatchObject({ shared: true, sharedWith: { byYou: true } });
    expect((await taskOf("rui", handoff))?.private, "no longer says only you").toBeUndefined();
    expect((await as("rui", "GET", "/api/auth/session")).body.openedThreads, "nor is it counted among his private chats").not.toContain(handoff);

    for (const who of ["ben", "olive", "ana"] as const) {
      expect((await messages(who, handoff)).status, `${who}: reading it`).toBe(404);
      expect(await taskOf(who, handoff), `${who}: listed`).toBeUndefined();
      expect(await notifications(who), `${who}: notified`).not.toContain(handoff);
      expect(await inboxLines(who), `${who}: inbox`).toBe(before[who]);
    }
    expect((await messages("marta", other)).status, "Rui's other private chat stays his").toBe(404);
    await expect.poll(() => inboxLines("marta"), { timeout: 10_000 }).toContain("shared");
    expect(await inboxLines("marta")).toContain(handoff);
    const theirs = JSON.parse(await notifications("marta")) as { notifications?: Array<{ threadId: string; title: string }> } | Array<{ threadId: string; title: string }>;
    const list = Array.isArray(theirs) ? theirs : theirs.notifications ?? [];
    expect(list.filter((entry) => entry.threadId === handoff).length, "one notification, linking the conversation").toBe(1);
  }, hostTimeout(90_000));

  it("Marta carries it on: the bot gets the whole conversation so far, in a home of its own, without either person's private notes", async () => {
    const dump = await turn("marta", scout, handoff, "What did Rui say about the supplier?");
    expect(JSON.stringify(dump.prompt), "the conversation so far").toContain(HANDOFF);
    expect(said(dump), "Rui's own notes about him stay his").not.toContain(RUI_NOTE);
    expect(said(dump), "his other private chat too").not.toContain(OTHER);
    const ruiHome = (await turn("rui", scout, other, "Another private line")).env.HOME;
    expect(dump.env.HOME, "not Rui's own engine home").not.toBe(ruiHome);
    expect((await messages("rui", handoff)).status).toBe(200);
    expect(JSON.stringify((await messages("rui", handoff)).body), "Rui reads what Marta wrote").toContain("What did Rui say about the supplier?");
  }, hostTimeout(120_000));

  it("goes back and forth: what one of them writes, or the bot answers them, waits in the other's inbox as one line", async () => {
    const forRui = await openRows("rui", handoff);
    expect(forRui.length, "Marta wrote and the bot answered her: one line for Rui").toBe(1);
    expect(forRui[0]!.text).toContain("answered");
    const mentions = (list: string) => (JSON.parse(list).notifications as Array<{ threadId: string; kind: string; forPerson?: string }>).filter((entry) => entry.threadId === handoff && entry.kind === "mention");
    expect(mentions(await notifications("rui")).length, "one notification for the one line").toBe(1);
    expect((await openRows("marta", handoff)).length, "her own line was settled when she wrote").toBe(0);

    await turn("rui", scout, handoff, "Ortega confirmed, thanks Marta");
    expect(await openRows("rui", handoff), "Rui answered there, so nothing waits on him").toEqual([]);
    const forMarta = await openRows("marta", handoff);
    expect(forMarta.length, "one line for Marta, updated in place by the bot's answer").toBe(1);
    expect(forMarta[0]!.text).toContain("answered");
    await turn("marta", scout, handoff, "Great, I'll book the call");
    expect(await openRows("marta", handoff)).toEqual([]);
    expect((await openRows("rui", handoff)).length).toBe(1);
    for (const who of ["ben", "olive", "ana"] as const) expect(await openRows(who, handoff), `${who}: nothing`).toEqual([]);
  }, hostTimeout(120_000));

  it("is shared once: Marta can't pass it on, Rui can't hand it to a third person, and only widening to the team stays", async () => {
    expect((await as("marta", "POST", `/api/bots/${scout}/tasks/${handoff}/share`, { with: "team" })).body.errorKey).toBe("serverError.share.notYours");
    expect((await as("rui", "POST", `/api/bots/${scout}/tasks/${handoff}/share`, { with: { email: ANA.email } })).body.errorKey).toBe("serverError.share.alreadyWith");
    expect((await as("rui", "POST", `/api/bots/${scout}/tasks/${handoff}/share`, { with: { email: MARTA.email } })).status, "the same person again changes nothing").toBe(200);
  }, hostTimeout(60_000));

  it("with the team: everyone who can use the bot reads it, nobody gets an inbox line or a notification for it, and it can't be shared again", async () => {
    const before = { ana: await inboxLines("ana"), ben: await inboxLines("ben"), olive: await inboxLines("olive"), marta: await inboxLines("marta") };
    const notifiedBefore = { ana: await notifications("ana"), ben: await notifications("ben"), olive: await notifications("olive") };
    const widened = await as("rui", "POST", `/api/bots/${scout}/tasks/${handoff}/share`, { with: "team" });
    expect(widened.status, JSON.stringify(widened.body)).toBe(200);
    expect(widened.body.shared).toBe("team");
    for (const who of ["ana", "ben", "olive", "marta"] as const) {
      expect((await messages(who, handoff)).status, `${who}: reading it`).toBe(200);
      expect(await taskOf(who, handoff), `${who}: on the Team side`).toMatchObject({ shared: true });
      expect((await taskOf(who, handoff))?.sharedWith).toBeUndefined();
      expect(await inboxLines(who), `${who}: no inbox line`).toBe(before[who]);
    }
    for (const who of ["ana", "ben", "olive"] as const) expect(await notifications(who), `${who}: no notification`).toBe(notifiedBefore[who]);
    expect((await as("rui", "POST", `/api/bots/${scout}/tasks/${handoff}/share`, { with: { email: ANA.email } })).body.errorKey).toBe("serverError.share.alreadyTeam");
    for (const who of ["ben", "olive", "marta"] as const) expect((await messages(who, other)).status, `${who}: Rui's other private chat`).toBe(404);
  }, hostTimeout(90_000));

  it("a private conversation shared straight to the team: an admin can't do it for its person", async () => {
    const own = await opened("ana", scout, "Ana's own");
    await turn("ana", scout, own, "Ana's private line");
    expect((await as("olive", "POST", `/api/bots/${scout}/tasks/${own}/share`, { with: "team" })).status).toBe(404);
    expect((await as("ana", "POST", `/api/bots/${scout}/tasks/${own}/share`, { with: "team" })).status).toBe(200);
    expect((await messages("olive", own)).status).toBe(200);
  }, hostTimeout(90_000));
});

describe("saving to team memory", () => {
  let ruiEntry = "", benEntry = "";

  it("is refused from someone else's private conversation, for a member and an admin alike", async () => {
    const line = await lastLine("rui", other);
    for (const who of ["ben", "olive"] as const) {
      const refused = await as(who, "POST", `/api/bots/${scout}/memory/team`, { threadId: other, messageId: line, text: OTHER });
      expect(refused.status, `${who}: ${JSON.stringify(refused.body)}`).toBe(404);
    }
    expect(readFileSync(join(team.home, ".openmausbot", "workspaces", scout, "MEMORY.md"), "utf8")).not.toContain(OTHER);
  }, hostTimeout(60_000));

  it("from a person's own private conversation and from a shared one, saying who and when, and the next conversation with the bot reads it", async () => {
    const inboxBefore = { rui: await inboxLines("rui"), ben: await inboxLines("ben"), ana: await inboxLines("ana") };
    const saved = await as("rui", "POST", `/api/bots/${scout}/memory/team`, { threadId: other, messageId: await lastLine("rui", other), text: DECISION });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    ruiEntry = saved.body.entry.id;
    expect(saved.body.entry.text).toMatch(new RegExp(`^${DECISION} \\(saved by .+, \\d{4}-\\d{2}-\\d{2}\\)$`));
    const fromShared = await as("ben", "POST", `/api/bots/${scout}/memory/team`, { threadId: handoff, messageId: await lastLine("ben", handoff), text: "Ortega's number is in the CRM" });
    expect(fromShared.status, JSON.stringify(fromShared.body)).toBe(201);
    benEntry = fromShared.body.entry.id;
    const notes = readFileSync(join(team.home, ".openmausbot", "workspaces", scout, "MEMORY.md"), "utf8");
    expect(notes).toContain(DECISION);
    expect(notes, "nothing else of the private chat").not.toContain(OTHER);
    for (const who of ["rui", "ben", "ana"] as const) expect(await inboxLines(who), `${who}: no inbox line`).toBe(inboxBefore[who]);

    const fresh = await opened("ana", scout, "Launch questions");
    const dump = await turn("ana", scout, fresh, "When do we ship?");
    expect(said(dump)).toContain(DECISION);
  }, hostTimeout(120_000));

  it("keeps one note's worth of a very long message, saying it was shortened, rather than refusing it", async () => {
    const long = Array.from({ length: 600 }, (_, index) => `word${index}`).join(" ");
    const saved = await as("rui", "POST", `/api/bots/${scout}/memory/team`, { threadId: other, messageId: await lastLine("rui", other), text: long });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.entry.text).toMatch(/^word0 word1 .*… \(shortened; saved by .+, \d{4}-\d{2}-\d{2}\)$/);
    expect(saved.body.entry.text.length).toBeLessThan(1_100);
    expect((await as("rui", "DELETE", `/api/bots/${scout}/memory/team/${saved.body.entry.id}`)).status, "Undo").toBe(200);
    expect(readFileSync(join(team.home, ".openmausbot", "workspaces", scout, "MEMORY.md"), "utf8")).not.toContain("word0 word1 word2");
  }, hostTimeout(60_000));

  it("lists each person their own lines and an admin every line; only the author or an admin removes one", async () => {
    const mine = await as("rui", "GET", `/api/bots/${scout}/memory/team`);
    expect(mine.body.entries).toEqual([expect.objectContaining({ id: ruiEntry, yours: true })]);
    expect((await as("ana", "GET", `/api/bots/${scout}/memory/team`)).body.entries).toEqual([]);
    expect(((await as("olive", "GET", `/api/bots/${scout}/memory/team`)).body.entries as Array<{ id: string }>).map((entry) => entry.id).sort()).toEqual([ruiEntry, benEntry].sort());
    expect((await as("ben", "DELETE", `/api/bots/${scout}/memory/team/${ruiEntry}`)).status).toBe(403);
    expect((await as("ben", "PUT", `/api/bots/${scout}/memory/file`, { path: "MEMORY.md", text: "" })).status, "nor edit the notes").toBe(403);
    expect(readFileSync(join(team.home, ".openmausbot", "workspaces", scout, "MEMORY.md"), "utf8")).toContain(DECISION);
    expect((await as("rui", "DELETE", `/api/bots/${scout}/memory/team/${ruiEntry}`)).status).toBe(200);
    expect((await as("olive", "DELETE", `/api/bots/${scout}/memory/team/${benEntry}`)).status).toBe(200);
    const notes = readFileSync(join(team.home, ".openmausbot", "workspaces", scout, "MEMORY.md"), "utf8");
    expect(notes).not.toContain(DECISION);
    expect(notes).not.toContain("Ortega's number");
  }, hostTimeout(60_000));
});

describe("someone leaving", () => {
  it("hands a conversation shared with one person to the one who stays, as their own private chat", async () => {
    const plan = await opened("ben", scout, "Ben's plan");
    await turn("ben", scout, plan, "Ben's handover notes");
    expect((await as("ben", "POST", `/api/bots/${scout}/tasks/${plan}/share`, { with: { email: ANA.email } })).status).toBe(200);
    expect((await team.signed("POST", "/api/cloud/team/member-left", { email: BEN.email })).status).toBeLessThan(300);
    await expect.poll(async () => (await taskOf("ana", plan))?.private, { timeout: 10_000 }).toBe(true);
    expect(JSON.stringify((await messages("ana", plan)).body)).toContain("Ben's handover notes");
    expect((await messages("olive", plan)).status, "and nobody else's").toBe(404);
  }, hostTimeout(90_000));
});
