import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { teamSlackPhase } from "./host/team-slack-host.ts";
import type { Message } from "./store.ts";
import { TEAM_SLACK_FILE, TEAM_SLACK_REPORT_PATH, createTeamSlackMessages, createTeamSlackReporter, teamSlackMessageSchema, teamSlackOver, teamSlackSignature, type TeamSlackRecord, type TeamSlackReport } from "./team-slack.ts";

const ID = "6f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b", LATER = "7a1d2b3c-4d5e-4f6a-9b0c-1d2e3f4a5b6c";
let seq = 0;
const row = (fields: Partial<Message>): Message => ({ id: `m${++seq}`, at: seq, role: "user", kind: "text", text: "", ...fields } as Message);
const reply = (text: string, fields: Partial<Message> = {}) => row({ role: "bot", text, turnTerminal: true, ...fields });
const idle = { queued: false, busy: false, handedOn: false }, busy = { ...idle, busy: true };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("teamSlackSignature", () => {
  it("signs as the Admin checks: the Slack context, the machine, the time, the nonce and the body's hash", () => {
    // The value openmaus-cloud's teamSlackSignature gives for the same input.
    expect(teamSlackSignature("s3cret-s3cret", "machine-1", "1731662000", "nonce-nonce-nonce", '{"v":1}')).toBe("Ajtt5Il9oDl9T2EOM8ebLe5iTiDiES4oheQp2ZwcUTk");
  });
});

describe("teamSlackMessageSchema", () => {
  const message = { v: 1, id: ID, audience: "team", bot: { id: "bot_1" }, conversationId: null, text: "hello",
    slack: { workspace: "T1", channel: "C1", threadTs: "1731662000.000100", messageTs: "1731662000.000100", user: "U1" } };
  it("takes the contract's message, each way of naming the bot, and a channel's name", () => {
    expect(teamSlackMessageSchema.safeParse(message).success).toBe(true);
    for (const bot of [{ name: "Quotes" }, { default: true }]) expect(teamSlackMessageSchema.safeParse({ ...message, bot }).success).toBe(true);
    expect(teamSlackMessageSchema.safeParse({ ...message, slack: { ...message.slack, channelName: "sales" } }).success).toBe(true);
  });
  it("refuses another version, an id that is no uuid, an unknown audience and a bot named two ways", () => {
    for (const wrong of [{ v: 2 }, { id: "not-a-uuid" }, { audience: "room" }, { bot: { id: "bot_1", name: "Quotes" } }, { bot: { default: false } }, { text: "" }, { conversationId: "../etc" }]) {
      expect(teamSlackMessageSchema.safeParse({ ...message, ...wrong }).success, JSON.stringify(wrong)).toBe(false);
    }
  });
});

describe("teamSlackPhase", () => {
  it("is running while its line waits in the queue or its turn works, and unsettled when nothing yet says", () => {
    expect(teamSlackPhase([], ID, { ...idle, queued: true })).toEqual({ state: "running" });
    const path = [row({ sendId: ID, requestPending: true })];
    expect(teamSlackPhase(path, ID, busy)).toEqual({ state: "running" });
    expect(teamSlackPhase(path, ID, { ...idle, handedOn: true })).toEqual({ state: "running" });
    expect(teamSlackPhase(path, ID, idle)).toBe("unsettled");
    expect(teamSlackPhase([row({ sendId: ID })], ID, idle)).toBe("unsettled");
  });
  it("is completed with the turn's final reply once the request settled", () => {
    const path = [row({ sendId: ID, requestPending: false }), row({ role: "bot", text: "Looking…" }), reply("**Done**, it shipped.")];
    expect(teamSlackPhase(path, ID, idle)).toEqual({ state: "completed", text: "**Done**, it shipped." });
  });
  it("waits on an open approval or question, and no longer once it is answered", () => {
    const card = (fields: Record<string, unknown>) => row({ role: "bot", kind: "options", card: { title: "Run it?", subtitle: "", options: ["Allow"], requestId: "r1", ...fields } } as Partial<Message>);
    const line = row({ sendId: ID, requestPending: true }), approval = { requestType: "permission", tool: "Bash" }, question = { requestType: "question" };
    expect(teamSlackPhase([line, card(approval)], ID, busy)).toEqual({ state: "waiting", waiting: "approval" });
    expect(teamSlackPhase([line, card(question)], ID, busy)).toEqual({ state: "waiting", waiting: "question" });
    expect(teamSlackPhase([line, card({ ...approval, answered: "Allow" })], ID, busy)).toEqual({ state: "running" });
    // A question its turn left open is part of the reply, not a wait: the request settled.
    expect(teamSlackPhase([{ ...line, requestPending: false }, card(question), reply("Which one?")], ID, idle)).toEqual({ state: "completed", text: "Which one?" });
    expect(teamSlackPhase([line, card(question)], ID, idle)).toBe("unsettled");
  });
  it("is stopped when its request was cancelled, or its line is gone from the conversation", () => {
    expect(teamSlackPhase([row({ sendId: ID, requestPending: true, requestCancelled: true })], ID, busy)).toEqual({ state: "stopped" });
    expect(teamSlackPhase([row({ sendId: LATER, requestPending: true })], ID, busy)).toEqual({ state: "stopped" });
  });
  it("is failed when the next request began before this one settled", () => {
    const path = [row({ sendId: ID, requestPending: true }), row({ role: "bot", kind: "activity" }), row({ sendId: LATER, requestPending: true })];
    expect(teamSlackPhase(path, ID, busy)).toEqual({ state: "failed" });
    expect(teamSlackPhase(path, LATER, busy)).toEqual({ state: "running" });
  });
  it("a line that waited with a later one of the same person is answered by that one's turn, which carries the reply", () => {
    const path = [row({ sendId: ID }), row({ sendId: LATER, requestPending: false }), reply("Both answered.")];
    expect(teamSlackPhase(path, ID, idle)).toEqual({ state: "completed" });
    expect(teamSlackPhase(path, LATER, idle)).toEqual({ state: "completed", text: "Both answered." });
  });
  it("a line steered into a running request follows that request", () => {
    const path = [row({ sendId: LATER, requestPending: true }), row({ role: "bot", kind: "activity" }), row({ sendId: ID, steered: true })];
    expect(teamSlackPhase(path, ID, busy)).toEqual({ state: "running" });
    path[0] = { ...path[0]!, requestPending: false };
    expect(teamSlackPhase([...path, reply("Done.")], ID, idle)).toEqual({ state: "completed" });
  });
});

describe("the record of Slack messages", () => {
  it("is left out of a workspace export, by the name it is saved under", () => {
    expect(TEAM_SLACK_FILE).toBe("team-slack-messages.json");
    expect(readFileSync(new URL("./workspace-backup.ts", import.meta.url), "utf8")).toContain(`"${TEAM_SLACK_FILE}",`);
  });

  const record = (fields: Partial<TeamSlackRecord> = {}): TeamSlackRecord => ({ id: ID, person: "p_0123456789abcdefghijkl", botId: "bot_1", botName: "Quotes", threadId: "t_1", audience: "team", at: 1_000, state: "running", ...fields });
  const dir = () => { const made = mkdtempSync(join(tmpdir(), "team-slack-home-unit-")); dirs.push(made); return made; };
  it("survives a restart, is over once the Admin has the final state, and forgets a person who left", () => {
    const dataDir = dir();
    const first = createTeamSlackMessages({ dataDir, now: () => 2_000 });
    first.put(record());
    first.put(record({ id: LATER, person: "p_zyxwvutsrqponmlkjihgfe", audience: "member" }));
    const again = createTeamSlackMessages({ dataDir, now: () => 3_000 });
    expect(again.all().map((one) => one.id)).toEqual([ID, LATER]);
    expect(teamSlackOver(again.get(ID)!)).toBe(false);
    again.patch(ID, { state: "completed" });
    expect(teamSlackOver(again.get(ID)!)).toBe(false);
    again.patch(ID, { told: "completed" });
    expect(teamSlackOver(again.get(ID)!)).toBe(true);
    expect(again.forgetPerson("p_zyxwvutsrqponmlkjihgfe")).toEqual([LATER]);
    expect(JSON.parse(readFileSync(join(dataDir, TEAM_SLACK_FILE), "utf8")).messages.map((one: { id: string }) => one.id)).toEqual([ID]);
  });
  it("past its cap drops what is over before a run it still tracks", () => {
    const kept = createTeamSlackMessages({ dataDir: dir(), now: () => 1_000, max: 2 });
    const [first, second, third] = [ID, LATER, "8b2e3c4d-5e6f-4a7b-8c9d-2e3f4a5b6c7d"];
    kept.put(record({ id: first }));
    kept.put(record({ id: second, state: "completed", told: "completed" }));
    kept.put(record({ id: third }));
    expect(kept.all().map((one) => one.id)).toEqual([first, third]);
    kept.put(record({ id: second }));
    expect(kept.all().map((one) => one.id)).toEqual([third, second]);
  });
  it("drops what is over after a week and anything after a month", () => {
    const dataDir = dir(), day = 24 * 3_600_000;
    let now = 0;
    const kept = createTeamSlackMessages({ dataDir, now: () => now });
    kept.put(record({ at: 0, state: "completed", told: "completed" }));
    kept.put(record({ id: LATER, at: 0 }));
    now = 8 * day;
    kept.patch(LATER, {});
    expect(kept.all().map((one) => one.id)).toEqual([LATER]);
    now = 31 * day;
    kept.patch(LATER, {});
    expect(kept.all()).toEqual([]);
  });
});

describe("createTeamSlackReporter", () => {
  const report: TeamSlackReport = { id: ID, status: "completed", text: "Done.", conversationId: "t_1", bot: { id: "bot_1", name: "Quotes" }, openUrl: "https://acme.example.test/?thread=t_1&bot=bot_1" };
  const reporter = (answer: () => Response | Promise<Response>, seen: { url: string; init: RequestInit }[] = []) => createTeamSlackReporter({ machineId: "machine-1", adminOrigin: "https://cloud.example.test", secret: "s3cret-s3cret", now: () => 1_731_662_000_000,
    fetchImpl: (async (url: string, init: RequestInit) => { seen.push({ url, init }); return answer(); }) as typeof fetch });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("posts the contract's body to the Admin's report path, signed over exactly those bytes", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    expect(await reporter(() => json(200, { ok: true }), seen)(report)).toBe("told");
    const { url, init } = seen[0]!, headers = init.headers as Record<string, string>;
    expect(url).toBe(`https://cloud.example.test${TEAM_SLACK_REPORT_PATH}`);
    expect(JSON.parse(String(init.body))).toEqual({ v: 1, ...report });
    expect(headers["x-omb-cloud-machine"]).toBe("machine-1");
    expect(headers["x-omb-cloud-timestamp"]).toBe("1731662000");
    expect(headers["x-omb-cloud-nonce"]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(headers["x-omb-cloud-signature"]).toBe(`v1=${teamSlackSignature("s3cret-s3cret", "machine-1", "1731662000", headers["x-omb-cloud-nonce"]!, String(init.body))}`);
    expect(init.redirect).toBe("error");
  });
  it("reads the Admin's answers: over, later, refused; a Stop it mentions is never acted on", async () => {
    expect(await reporter(() => json(200, { ok: true, done: true }))(report)).toBe("over");
    expect(await reporter(() => json(200, { ok: true, stop: true }))(report)).toBe("told");
    expect(await reporter(() => json(404, { code: "unknown_message" }))(report)).toBe("over");
    for (const status of [429, 500, 503]) expect(await reporter(() => json(status, {}))(report)).toBe("later");
    expect(await reporter(() => { throw new TypeError("fetch failed"); })(report)).toBe("later");
    expect(await reporter(() => new Response("<html>", { status: 200 }))(report)).toBe("later");
    for (const status of [400, 401, 409]) expect(await reporter(() => json(status, {}))(report)).toBe("refused");
  });
});
