// A secret a member types into a bot's card in her own private chat is hers, on a real Team Cloud (OMB_CLOUD_ROLE=team)
// with the synthetic Claude CLI, tried as the people it must hold against: the same bot in another member's private chat,
// in its shared chat, in a group chat and in a routine run for that other member asks with a card, as if nothing were
// saved; no Admin or Owner lists, changes or deletes it; she lists and deletes hers; leaving deletes it. A secret an Admin
// saves stays the team's everywhere. No value is ever printed: each check says only whether it holds.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { decryptBrowserState } from "./browser-sites.ts";
import { personKey } from "./person-key.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { LOGINS_KEY_FILE, MEMBER_SECRETS_FILE } from "./vault-store.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ari@acme.test", role: "admin" as const };
const ADA = { email: "ada@acme.test", role: "member" as const };
const BEN = { email: "ben@acme.test", role: "member" as const };
const LATER = { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 };
const ADA_VALUE = `sk_test_fake-ada-${randomBytes(12).toString("hex")}`;
const ADA_SECOND = `sk_test_fake-ada-${randomBytes(12).toString("hex")}`;
const TEAM_VALUE = `sk_test_fake-team-${randomBytes(12).toString("hex")}`;
const LABEL = "Stripe secret key";

type Bot = { id: string; threadId: string };
type Run = { id: string; routineId: string; status: string; threadId?: string };
type Asked = { status: number; body: { messageId?: string; text?: string; savedAs?: string } };

let fx: CloudSendFixture, team: CloudTeamFixture;
let owner = "", admin = "", ada = "", ben = "";
let ledger: Bot;
let adaThread = "", benThread = "", roomThread = "", benRunThread = "";
const said: string[] = [];

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(done: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(150);
  }
}
const as = async (token: string, method: string, path: string, body?: unknown) => {
  const answer = await team.as(token, method, path, body);
  said.push(JSON.stringify(answer.body));
  return answer;
};
/** request_credential from Ledger's turn in this conversation, as its agents tools send it. */
async function ask(threadId: string, label = LABEL, delivery = "ref"): Promise<Asked> {
  const bearer = await team.capability(ledger.id, threadId);
  const answer = await fetch(`${team.base}/api/internal/request-credential`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ label, reason: "For test charges.", delivery }) });
  const text = await answer.text();
  said.push(text);
  return { status: answer.status, body: JSON.parse(text) };
}
const save = (token: string, threadId: string, messageId: string, value: string) =>
  as(token, "POST", `/api/bots/${ledger.id}/secret-cards/${messageId}/save`, { threadId, value });
const vaultOf = async (token: string) => (await as(token, "GET", "/api/vault")).body as { logins: unknown[]; secrets: Array<{ id: string; name: string }> };
/** Whether any answer, or the server's log, holds this value: never the value itself in a failure. */
const leaked = (value: string) => [...said, ...fx.answers, fx.logs()].some((text) => text.includes(value));

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-team-${randomBytes(8).toString("hex")}`, team: { id: "team-acme-secrets", name: "Acme" } });
  team = fx.team!;
  owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  ada = (await team.pair(ADA)).token!;
  ben = (await team.pair(BEN)).token!;
  ledger = (await as(owner, "POST", "/api/bots", { name: "Ledger", visibility: "everyone" })).body.bot;
  adaThread = (await as(ada, "POST", `/api/bots/${ledger.id}/tasks`, { title: "Billing" })).body.task.threadId;
  benThread = (await as(ben, "POST", `/api/bots/${ledger.id}/tasks`, { title: "Billing" })).body.task.threadId;
  const room = await as(owner, "POST", "/api/groups", { name: "Finance", memberIds: [ledger.id] });
  expect(room.status, JSON.stringify(room.body)).toBeLessThan(300);
  roomThread = room.body.group.threadId;
  const made = await as(ben, "POST", "/api/routines", { name: "Ben's billing check", prompt: "Check the invoices", botId: ledger.id, schedule: LATER, resultsThreadId: "just-me" });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const ran = await as(ben, "POST", `/api/routines/${made.body.routine.id}/run`);
  expect(ran.status, JSON.stringify(ran.body)).toBe(201);
  // Wait for the run to finish, not just for its thread: a bearer minted while the run's own turn is live belongs to that
  // turn and stops answering (401) the moment the run ends, so asking any earlier races the routine.
  let run: Run | undefined;
  await until(async () => {
    run = ((await as(ben, "GET", "/api/routines")).body.runs as Run[]).find((candidate) => candidate.id === ran.body.run.id);
    return Boolean(run?.threadId) && !["queued", "running", "waiting"].includes(run!.status);
  }, 90_000);
  expect(run!.status, "Ben's routine run").toBe("completed");
  benRunThread = run!.threadId!;

  const card = await ask(adaThread);
  expect(card.status, "the first ask in her chat is a card").toBe(201);
  expect((await save(ada, adaThread, card.body.messageId!, ADA_VALUE)).status).toBe(200);
}, hostTimeout(300_000));

afterAll(async () => {
  await fx?.close();
});

it("Ledger gets it again in her own chat with no card", async () => {
  const again = await ask(adaThread);
  expect(again.status).toBe(200);
  expect(again.body.text).toMatch(/secret-ref:[0-9a-f]{32}/u);
}, hostTimeout(30_000));

it("Ledger in Ben's private chat, its shared chat, a group chat and Ben's routine asks with a card, as if nothing were saved", async () => {
  for (const [where, threadId] of [["Ben's private chat", benThread], ["the shared chat", ledger.threadId], ["a group chat", roomThread], ["Ben's routine", benRunThread]] as const) {
    const asked = await ask(threadId);
    expect(asked.status, where).toBe(201);
    expect(asked.body.messageId, where).toBeTruthy();
    const file = await ask(threadId, LABEL, "file");
    expect([file.status, file.body.savedAs], `${where}, as a file`).toEqual([201, undefined]);
  }
  expect(leaked(ADA_VALUE), "her value in any answer or log").toBe(false);
}, hostTimeout(60_000));

it("no Admin, Owner or other member lists, changes or deletes it; she lists hers", async () => {
  const hers = await vaultOf(ada);
  expect(hers.secrets.map((one) => one.name)).toEqual([LABEL]);
  expect(hers.logins).toEqual([]);
  const id = hers.secrets[0]!.id;
  for (const [who, token] of [["an Admin", admin], ["the Owner", owner], ["Ben", ben]] as const) {
    const listed = await vaultOf(token);
    expect(listed.secrets.map((one) => one.id), `${who}: the Vault`).not.toContain(id);
    expect(JSON.stringify(listed).includes(LABEL), `${who}: her secret's name`).toBe(false);
    expect((await as(token, "DELETE", `/api/vault/secrets/${id}`)).status, `${who}: delete`).toBe(404);
    expect((await as(token, "PATCH", `/api/vault/secrets/${id}`, { bots: "all" })).status, `${who}: change`).toBeGreaterThanOrEqual(403);
  }
  for (const token of [admin, owner]) {
    expect((await as(token, "POST", "/api/vault/secrets", { id, name: LABEL, value: "fake-overwrite", bots: "all" })).status, "a move's secret by her id").toBe(404);
    for (const format of ["backup", "share"]) {
      const exported = await as(token, "POST", "/api/teams/export", { format });
      expect(JSON.stringify(exported.body).includes(id), `the team export as ${format}`).toBe(false);
    }
  }
  expect((await ask(adaThread)).status, "still hers after all that").toBe(200);
}, hostTimeout(60_000));

it("a secret an Admin saves stays the team's: every chat gets it, hers too", async () => {
  expect((await as(admin, "POST", "/api/vault/secrets", { name: "Team deploy key", value: TEAM_VALUE, bots: "all" })).status).toBe(201);
  for (const [where, threadId] of [["Ada's chat", adaThread], ["Ben's chat", benThread], ["the shared chat", ledger.threadId], ["a group chat", roomThread], ["Ben's routine", benRunThread]] as const) {
    expect((await ask(threadId, "Team deploy key")).status, where).toBe(200);
  }
  expect((await vaultOf(admin)).secrets.map((one) => one.name)).toEqual(["Team deploy key"]);
  expect((await vaultOf(ben)).secrets).toEqual([]);
  expect(leaked(TEAM_VALUE), "the team's value in any answer or log").toBe(false);
}, hostTimeout(60_000));

it("she deletes hers, and leaving deletes the rest of hers from the disk", async () => {
  const id = (await vaultOf(ada)).secrets[0]!.id;
  expect((await as(ada, "DELETE", `/api/vault/secrets/${id}`)).status).toBe(200);
  const card = await ask(adaThread);
  expect(card.status, "gone: Ledger asks again").toBe(201);
  expect((await save(ada, adaThread, card.body.messageId!, ADA_SECOND)).status).toBe(200);
  expect((await vaultOf(ada)).secrets).toHaveLength(1);

  const left = await team.signed("POST", "/api/cloud/team/member-left", { email: ADA.email });
  expect(left.status, JSON.stringify(left.body)).toBeLessThan(300);
  const dataDir = join(team.home, ".openmausbot");
  const key = readFileSync(join(dataDir, LOGINS_KEY_FILE), "utf8").trim();
  const kept = JSON.parse(decryptBrowserState(readFileSync(join(dataDir, MEMBER_SECRETS_FILE)), key)) as { secrets: Array<{ id: string; person: string }> };
  expect(kept.secrets.filter((one) => one.person === personKey({ id: "", email: ADA.email })).map((one) => one.id), "hers, sealed on the disk").toEqual([]);
  const back = (await team.pair(ADA)).token!;
  expect((await vaultOf(back)).secrets, "joining again restores nothing").toEqual([]);
  expect((await vaultOf(admin)).secrets.map((one) => one.name)).toEqual(["Team deploy key"]);
  expect(leaked(ADA_SECOND), "her second value in any answer or log").toBe(false);
}, hostTimeout(60_000));
