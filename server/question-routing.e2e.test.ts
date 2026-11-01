// Who answers a teammate's question, end to end on a Team Cloud (docs/runtime-contract.md §2, docs/team-cloud.md):
// Marco's Chief Fuchs, whose chat is his inbox, hands work to Dachs and Otter. At Full access ("Just do it", every
// bot's default) nothing a bot can settle reaches Marco: Dachs's question goes to Fuchs, and Dachs goes on with its
// default when Fuchs sends no answer; only a sign-in, which only Marco can do, reaches him, once, while the rest of the
// work moves on. On "Ask me first" a question waits for Marco however long it takes: an answer he gives through Fuchs
// settles it, a restart neither drops nor posts it again, and a question whose turn is gone leaves Needs you and his
// inbox. The engine is the scripted synthetic Claude CLI, so this proves where things land, not a model's judgement.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const MARCO = { email: "marco@acme.test", role: "owner" as const };
const SETTLED = "Your downstream room requests have settled.";
const ENGINE = `const dir = process.env.FAKE_CLAUDE_FIXTURE_DIR;
process.env.FAKE_CLAUDE_ROOM_PLAN = dir + "/room-plan.json";`;
const TOKEN = `ops_fake-team-${randomBytes(8).toString("hex")}`;

type Card = { requestId?: string; requestType?: string; subtitle?: string; options?: string[]; answered?: string; answeredText?: string; dismissed?: boolean;
  answeredBy?: { kind: string; name?: string } };
type Row = { id: string; role: string; kind: string; at: number; text?: string; card?: Card; tool?: { name: string }; signIn?: { site: string; answeredInChat?: boolean };
  inbox?: { kind: string } };
type Task = { threadId: string; title: string; inbox?: true; openedBy?: { botId: string } };
type Bot = { id: string; name: string; threadId: string; busy?: boolean; activity?: string; tasks?: Task[] };
type Note = { kind: string; botId: string; threadId: string; title: string; body: string; forPerson?: string };

let fx: CloudSendFixture, team: CloudTeamFixture;
let browserTools = "";
let marco = "";
let fuchs: Bot, dachs: Bot, otter: Bot;
let inbox = "";

const file = (name: string) => join(team.home, name);
const plan: Record<string, { script: unknown[] }> = {};
const script = (botId: string, ...entries: unknown[]) => {
  (plan[botId] ??= { script: [] }).script.push(...entries);
  writeFileSync(file("room-plan.json"), JSON.stringify(plan));
};
const turns = (botId: string): Array<{ planKey?: string; prompt: unknown }> => {
  const path = file("room-plan.json.evidence.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((turn) => turn.botId === botId) : [];
};
const keys = (botId: string, job: string) => turns(botId).map((turn) => turn.planKey).filter((key) => key?.startsWith(job));
const told = (botId: string, key: string) => JSON.stringify(turns(botId).find((turn) => turn.planKey === key)?.prompt ?? "");
const messages = async (threadId: string) => ((await team.as(marco, "GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages ?? []) as Row[];
const bots = async () => (await team.as(marco, "GET", "/api/bots")).body.bots as Bot[];
const idle = async () => (await bots()).every((bot) => !bot.busy && bot.activity !== "working");
const notes = async () => ((await team.as(marco, "GET", "/api/notifications")).body.notifications ?? []) as Note[];
const needsYou = async () => ((await team.as(marco, "GET", "/api/needs-you")).body.items ?? []) as Array<{ kind: string; text?: string; threadId?: string }>;
const inboxRows = async () => ((await team.as(marco, "GET", "/api/inbox")).body.rows ?? []) as Array<{ id: string; tab: string; card?: Card }>;
/** Dachs's work thread from Fuchs: every hand-off from Marco's inbox goes to this one. */
const workThread = async () => ((await bots()).find((bot) => bot.id === dachs.id)!.tasks ?? []).find((task) => task.openedBy?.botId === fuchs.id)?.threadId;

async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function say(bot: Bot, threadId: string, text: string) {
  const sent = await team.as(marco, "POST", `/api/bots/${bot.id}/messages`, { text, threadId });
  expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  return sent.body as { message?: Row };
}
const handOn = (job: string, to: Bot, brief: string) => ({ key: `${job}-L`, match: [`${job}-JOB`], steps: [{ arguments: { bot_ids: [to.id], message: brief } }], reply: `${job}-L: weitergegeben.` });
const done = (job: string) => ({ key: `${job}-L-DONE`, match: [SETTLED, `${job}-JOB`], reply: `${job}-L-DONE: fertig.` });

beforeAll(async () => {
  browserTools = mkdtempSync(join(tmpdir(), "omb-question-routing-"));
  const binaryPath = join(browserTools, "agent-browser");
  // Answers the saved-login check a browser mount makes; every other command succeeds silently.
  writeFileSync(binaryPath, `#!/bin/sh\nif [ "$1" = session ] && [ "$2" = list ]; then printf '{"success":true,"data":{"sessions":[]}}'; fi\nexit 0\n`, { mode: 0o755 });
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, team: { id: "team-acme-qr", name: "Acme", engine: ENGINE,
    env: { OMB_AGENT_BROWSER_PATH: binaryPath, AGENT_BROWSER_EXECUTABLE_PATH: join(browserTools, "chrome") } } });
  team = fx.team!;
  writeFileSync(file("room-plan.json"), "{}");
  marco = (await team.pair(MARCO)).token!;
  expect((await team.as(marco, "PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
  const create = async (body: Record<string, unknown>) => {
    const created = await team.as(marco, "POST", "/api/bots", body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.bot as Bot;
  };
  fuchs = await create({ name: "Fuchs", reportsTo: MARCO.email });
  expect((await team.as(marco, "PATCH", `/api/bots/${fuchs.id}`, { chiefOfStaff: true })).status).toBe(200);
  dachs = await create({ name: "Dachs", reportsTo: MARCO.email });
  otter = await create({ name: "Otter", reportsTo: MARCO.email });
  expect((await team.as(marco, "PATCH", `/api/bots/${dachs.id}`, { computer: "browser" })).status).toBe(200);
  const opened = await team.as(marco, "POST", `/api/bots/${fuchs.id}/tasks`, { title: "Marco und Fuchs" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  inbox = opened.body.task.threadId as string;
}, hostTimeout(180_000));

afterAll(async () => {
  await fx?.close();
  if (browserTools) await removeTempDir(browserTools);
});

describe("Just do it: nothing a bot can settle reaches the person", () => {
  it("hands Dachs's question to Fuchs, and with no answer from Fuchs Dachs goes on with its default and says so: no card, notification or inbox line for Marco", async () => {
    script(fuchs.id, handOn("JD1", dachs, "JD1-BRIEF: Exportiere den Monatsbericht."), done("JD1"),
      { key: "JD1-L-ASKED", match: ["yours to answer", "JD1-JOB"], reply: "JD1-L-ASKED: keine Vorgabe von mir." });
    script(dachs.id,
      { key: "JD1-B2", match: ["JD1-BRIEF", "Nobody was asked"], reply: "JD1-B2: Als CSV exportiert; CSV war die Vorgabe, niemand wurde gefragt." },
      { key: "JD1-B", match: ["JD1-BRIEF"], reply: "Zwei Formate gehen.\nNEEDS INPUT: CSV oder Excel?\nDefault: CSV" });
    const before = (await notes()).length;
    await say(fuchs, inbox, "JD1-JOB: Lass Dachs den Monatsbericht exportieren.");
    await until(async () => (await messages(inbox)).some((line) => line.text === "JD1-L-DONE: fertig."), 90_000);

    expect(keys(fuchs.id, "JD1"), "Fuchs hears the question once, then the result").toEqual(["JD1-L", "JD1-L-ASKED", "JD1-L-DONE"]);
    expect(told(fuchs.id, "JD1-L-ASKED")).toContain('It asks: \\"CSV oder Excel?\\". Its default: \\"CSV\\".');
    expect(told(fuchs.id, "JD1-L-ASKED")).toContain("is not asked: answer it yourself from what you know, by sending your answer to @Dachs with coordinate_bots");
    expect(told(dachs.id, "JD1-B"), "Dachs was told to decide, and whom to hand a real choice to").toMatch(/At this level do not stop to ask .*the question and `Default:` your pick, and @Fuchs decides/);
    expect(told(dachs.id, "JD1-B2")).toContain('Nobody was asked, at this level: go on with your default, \\"CSV\\", and say in one plain line what you chose.');
    expect(told(fuchs.id, "JD1-L-DONE")).toContain("CSV war die Vorgabe");

    const work = (await workThread())!;
    const decided = (await messages(work)).find((line) => line.card?.requestId?.startsWith("needs-input-"));
    expect(decided?.card, "the card says what was picked, and by whom, and waits on nobody").toMatchObject({ subtitle: "CSV oder Excel?", answered: "answer", answeredText: "CSV", answeredBy: { kind: "bot", name: "Dachs" } });
    expect((await messages(work)).some((line) => line.text?.includes("NEEDS INPUT")), "no raw NEEDS INPUT line").toBe(false);
    const since = (await notes()).slice(0, (await notes()).length - before);
    expect(since.filter((note) => note.kind === "question" || note.kind === "approval"), "no question reached Marco").toEqual([]);
    expect((await inboxRows()).filter((row) => row.tab === "needs-you")).toEqual([]);
    expect((await needsYou()).filter((item) => item.kind === "question")).toEqual([]);
    await until(idle);
  }, hostTimeout(150_000));

  it("takes Fuchs's own answer, sent to Dachs with coordinate_bots, as the answer: no new work, and Dachs's card says Fuchs picked it", async () => {
    const tasksBefore = ((await bots()).find((bot) => bot.id === dachs.id)!.tasks ?? []).length;
    script(fuchs.id, handOn("JD2", dachs, "JD2-BRIEF: Exportiere den Quartalsbericht."), done("JD2"),
      { key: "JD2-L-ASKED", match: ["yours to answer", "JD2-JOB"], steps: [{ arguments: { bot_ids: [dachs.id], message: "Excel, die Tabelle geht an die Buchhaltung." } }], reply: "JD2-L-ASKED: Excel gewählt." });
    script(dachs.id,
      { key: "JD2-B2", match: ["JD2-BRIEF", "@Fuchs answered"], reply: "JD2-B2: Als Excel exportiert, wie Fuchs entschieden hat." },
      { key: "JD2-B", match: ["JD2-BRIEF"], reply: "NEEDS INPUT: CSV oder Excel?\nDefault: CSV" });
    await say(fuchs, inbox, "JD2-JOB: Lass Dachs den Quartalsbericht exportieren.");
    await until(async () => (await messages(inbox)).some((line) => line.text === "JD2-L-DONE: fertig."), 90_000);

    expect(keys(dachs.id, "JD2")).toEqual(["JD2-B", "JD2-B2"]);
    expect(told(dachs.id, "JD2-B2")).toContain('@Fuchs answered: \\"Excel, die Tabelle geht an die Buchhaltung.\\"');
    const relayed = turns(fuchs.id).find((turn) => turn.planKey === "JD2-L-ASKED") as unknown as { evidence: Array<{ response?: { result?: { content?: Array<{ text?: string }> } } }> };
    expect(JSON.stringify(relayed.evidence), "the receipt says the message answered the question").toContain("answered its question");
    expect(((await bots()).find((bot) => bot.id === dachs.id)!.tasks ?? []).length, "no new thread was opened for it").toBe(tasksBefore);
    const card = (await messages((await workThread())!)).findLast((line) => line.card?.requestId?.startsWith("needs-input-"))!.card!;
    expect(card).toMatchObject({ answeredText: "Excel, die Tabelle geht an die Buchhaltung.", answeredBy: { kind: "bot", name: "Fuchs" } });
    expect((await messages(inbox)).some((line) => line.tool?.name === "Answered Dachs's question")).toBe(true);
    await until(idle);
  }, hostTimeout(150_000));

  it("asks Marco only for the sign-in he alone can do, once, while Otter's part finishes and Fuchs carries on; his line in Dachs's chat carries Dachs on", async () => {
    script(fuchs.id,
      { key: "JD3-L", match: ["JD3-JOB"], steps: [
        { arguments: { bot_ids: [dachs.id], message: "JD3-BRIEF-B: Lade die Notion-Seite herunter." } },
        { arguments: { bot_ids: [otter.id], message: "JD3-BRIEF-O: Fasse die Notizen zusammen." } }], reply: "JD3-L: verteilt." },
      { key: "JD3-L-MID", match: ["[OpenMausBot note from @Dachs", "JD3-JOB"], reply: "JD3-L-MID: Otter ist fertig; Dachs wartet auf deine Notion-Anmeldung." },
      done("JD3"));
    script(dachs.id,
      { key: "JD3-B2", match: ["JD3-BRIEF-B", "instead of pressing Done"], reply: "JD3-B2: Seite geladen." },
      { key: "JD3-B", match: ["JD3-BRIEF-B"], delayMs: 2_000, steps: [{ tool: "request_sign_in", arguments: { site: "notion.so", reason: "Die Seite liegt hinter einer Anmeldung." } }],
        reply: "JD3-B: Ich brauche deine Anmeldung bei Notion." });
    script(otter.id, { key: "JD3-O", match: ["JD3-BRIEF-O"], reply: "JD3-O: Zusammenfassung fertig." });
    const before = (await notes()).length;
    await say(fuchs, inbox, "JD3-JOB: Lass Dachs die Notion-Seite laden und Otter die Notizen zusammenfassen.");
    await until(() => keys(fuchs.id, "JD3").includes("JD3-L-MID"), 90_000);

    expect(told(fuchs.id, "JD3-L-MID"), "Fuchs carries on with Otter's result while the sign-in waits").toContain("JD3-O: Zusammenfassung fertig.");
    expect(told(fuchs.id, "JD3-L-MID")).toContain("can do that and it is already in front of them: do not ask them again.");
    const work = (await workThread())!;
    const signIns = (await messages(work)).filter((line) => line.kind === "signin");
    expect(signIns.map((line) => line.signIn?.site)).toEqual(["notion.so"]);
    const since = () => notes().then((all) => all.slice(0, all.length - before));
    await until(async () => (await since()).some((note) => note.kind === "sign-in"));
    expect((await since()).filter((note) => note.kind === "sign-in" || note.kind === "question" || note.kind === "approval").map((note) => note.kind),
      "Marco is asked once, for the sign-in").toEqual(["sign-in"]);
    expect((await needsYou()).filter((item) => item.kind === "question").map((item) => item.text)).toEqual(["Waiting on the person: sign in to notion.so"]);

    await say(dachs, work, "Bin jetzt bei Notion angemeldet.");
    await until(async () => (await messages(inbox)).some((line) => line.text === "JD3-L-DONE: fertig."), 90_000);
    expect(keys(dachs.id, "JD3")).toEqual(["JD3-B", "JD3-B2"]);
    expect(told(dachs.id, "JD3-B2")).toContain("Bin jetzt bei Notion angemeldet.");
    expect((await messages(work)).find((line) => line.kind === "signin")?.signIn).toMatchObject({ answeredInChat: true });
    expect(told(fuchs.id, "JD3-L-DONE")).toContain("JD3-B2: Seite geladen.");
    await until(async () => (await needsYou()).filter((item) => item.kind === "question").length === 0);
    await until(idle);
  }, hostTimeout(180_000));
});

describe("Ask me first: a question waits for the person, and an answer counts wherever they give it", () => {
  beforeAll(async () => {
    for (const bot of [fuchs, dachs]) expect((await team.as(marco, "PATCH", `/api/bots/${bot.id}`, { approvalMode: "ask", applyToAllThreads: true })).status).toBe(200);
  });

  const parkedQuestion = async (job: string, question: string) => {
    script(fuchs.id, handOn(job, dachs, `${job}-BRIEF: Prüfe den Abschlusstext.`), done(job),
      { key: `${job}-L-ASKED`, match: ["stopped on a question for", `${job}-JOB`], reply: `${job}-L-ASKED` });
    script(dachs.id,
      { key: `${job}-B2`, match: [`${job}-BRIEF`, "answered: "], reply: `${job}-B2: erledigt.` },
      { key: `${job}-B`, match: [`${job}-BRIEF`], reply: `Geprüft.\nNEEDS INPUT: ${question}` });
    await say(fuchs, inbox, `${job}-JOB: Lass Dachs den Abschlusstext prüfen.`);
    await until(() => keys(fuchs.id, job).includes(`${job}-L-ASKED`), 90_000);
    const work = (await workThread())!;
    await until(async () => (await messages(work)).some((line) => line.card?.subtitle === question && !line.card.answered));
    await until(async () => (await messages(inbox)).some((line) => line.inbox?.kind === "ask" && line.card?.subtitle === question));
    return work;
  };

  it("settles Dachs's question with Marco's answer passed on by Fuchs: no new task, the card and its inbox copy follow, and Needs you clears", async () => {
    const question = "Welche Formulierung soll der Abschlusstext bekommen?";
    const work = await parkedQuestion("AF1", question);
    expect((await needsYou()).filter((item) => item.kind === "question").map((item) => item.text)).toEqual([question]);
    const tasksBefore = ((await bots()).find((bot) => bot.id === dachs.id)!.tasks ?? []).length;

    const asked = (await messages(work)).find((line) => line.card?.subtitle === question)!.card!.requestId!.slice("needs-input-".length).replace(/-\d+$/, "");
    expect(told(fuchs.id, "AF1-L-ASKED"), "Fuchs was told how to pass Marco's answer on").toContain(`with coordinate_bots and answers \\"${asked}\\": that answers it.`);
    script(fuchs.id, { key: "AF1-RELAY", match: ["AF1-SAG"], steps: [{ arguments: { bot_ids: [dachs.id], message: "Marco sagt: kurz und freundlich.", answers: asked } }], reply: "AF1-RELAY: weitergegeben." });
    await say(fuchs, inbox, "AF1-SAG: Sag Dachs, kurz und freundlich.");
    await until(() => keys(dachs.id, "AF1").includes("AF1-B2"), 90_000);
    expect(told(dachs.id, "AF1-B2")).toContain('@Fuchs answered: \\"Marco sagt: kurz und freundlich.\\"');
    await until(async () => (await messages(inbox)).some((line) => line.text === "AF1-L-DONE: fertig."), 90_000);

    expect(((await bots()).find((bot) => bot.id === dachs.id)!.tasks ?? []).length, "the answer opened no new work").toBe(tasksBefore);
    expect((await messages(work)).find((line) => line.card?.subtitle === question)!.card).toMatchObject({ answered: "answer", answeredText: "Marco sagt: kurz und freundlich." });
    await until(async () => (await messages(inbox)).find((line) => line.inbox?.kind === "ask" && line.card?.subtitle === question)?.card?.answered === "answer");
    expect((await inboxRows()).filter((row) => row.tab === "needs-you")).toEqual([]);
    expect((await needsYou()).filter((item) => item.kind === "question")).toEqual([]);
    await until(idle);
  }, hostTimeout(180_000));

  it("keeps a waiting question across a restart without posting it again: one card, one inbox line, no second notification; the answer after it reaches Dachs", async () => {
    const question = "Soll der Abschlusstext das Datum nennen?";
    const work = await parkedQuestion("AF2", question);
    const count = async () => ({
      cards: (await messages(work)).filter((line) => line.card?.subtitle === question).length,
      copies: (await messages(inbox)).filter((line) => line.inbox?.kind === "ask" && line.card?.subtitle === question).length,
      chips: (await messages(inbox)).filter((line) => line.tool?.name.includes(question)).length,
      notified: (await notes()).filter((note) => note.kind === "question" && note.body.includes(question)).length,
    });
    const before = await count();
    expect(before).toEqual({ cards: 1, copies: 1, chips: 0, notified: 1 });

    await team.relaunch();
    await until(async () => (await team.as(marco, "GET", "/api/auth/session")).status === 200, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await count(), "nothing was posted again").toEqual(before);
    expect((await needsYou()).filter((item) => item.text === question)).toHaveLength(1);

    const copy = (await messages(inbox)).find((line) => line.inbox?.kind === "ask" && line.card?.subtitle === question)!;
    const answered = await team.as(marco, "POST", `/api/threads/${inbox}/respond`, { requestId: copy.card!.requestId, behavior: "answer", message: "Ja, mit Datum" });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await until(() => keys(dachs.id, "AF2").includes("AF2-B2"), 90_000);
    expect(told(dachs.id, "AF2-B2")).toContain('The person answered: \\"Ja, mit Datum\\"');
    await until(async () => (await messages(inbox)).some((line) => line.text === "AF2-L-DONE: fertig."), 90_000);
    await until(idle);
  }, hostTimeout(240_000));

  it("drops a question whose asking turn is gone from Needs you and the inbox once the work goes on without it", async () => {
    const question = "Nur den Abschlusstext oder auch den Einladungstext?";
    script(fuchs.id, handOn("AF3", dachs, "AF3-BRIEF: Setz den Fix um."), done("AF3"));
    script(dachs.id,
      { key: "AF3-B2", match: ["AF3-BRIEF", "OpenMausBot restarted"], reply: "AF3-B2: Beides angepasst, wie im Auftrag." },
      { key: "AF3-B", match: ["AF3-BRIEF"], timeoutMs: 120_000, steps: [{ server: "ogb", tool: "ask_user", arguments: { question, choices: ["Nur den Abschlusstext", "Beides"] } }], reply: "AF3-B: nie erreicht." });
    await say(fuchs, inbox, "AF3-JOB: Lass Dachs den Fix umsetzen.");
    const work = await (async () => { await until(async () => Boolean(await workThread())); return (await workThread())!; })();
    await until(async () => (await messages(work)).some((line) => line.card?.subtitle === question && !line.card.answered), 90_000);
    await until(async () => (await needsYou()).some((item) => item.kind === "question" && item.text === question));
    await until(async () => (await inboxRows()).some((row) => row.tab === "needs-you" && row.card?.subtitle === question));

    await team.relaunch();
    await until(async () => (await team.as(marco, "GET", "/api/auth/session")).status === 200, 60_000);
    await until(() => keys(dachs.id, "AF3").includes("AF3-B2"), 90_000);
    await until(async () => (await messages(inbox)).some((line) => line.text === "AF3-L-DONE: fertig."), 90_000);

    expect((await messages(work)).find((line) => line.card?.subtitle === question)!.card, "the question its turn left closed with its work")
      .toMatchObject({ answered: "unavailable", dismissed: true });
    expect((await needsYou()).filter((item) => item.text === question)).toEqual([]);
    expect((await inboxRows()).filter((row) => row.tab === "needs-you" && row.card?.subtitle === question)).toEqual([]);
    await until(idle);
  }, hostTimeout(240_000));
});
