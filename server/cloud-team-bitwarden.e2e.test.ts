// Bitwarden on a real Team Cloud (OMB_CLOUD_ROLE=team), its tool a fake `bw` already where the server installs the real
// one: an Admin connects it in Settings → Vault for the whole team; a member's private chat and the bot's shared chat get
// its secrets by name and by bw:// reference with no card; a member neither sees nor manages it; the Admin's signed report
// names it with its server, never a value, the API key or the master password. No value is ever printed.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { CLOUD_TEAM_ADMIN_PATH } from "./cloud-team-admin.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ari@acme.test", role: "admin" as const };
const ADA = { email: "ada@acme.test", role: "member" as const };
const CLIENT_SECRET = `fake-bw-client-secret-${randomBytes(8).toString("hex")}`;
const MASTER = `fake-bw-master-${randomBytes(8).toString("hex")}`;
const STRIPE = `sk_test_fake-bw-${randomBytes(12).toString("hex")}`;
const GITHUB = `fake-github-${randomBytes(12).toString("hex")}`;
const NOTE = `fake-oauth-note-${randomBytes(12).toString("hex")}`;
const CREDENTIALS = { serverUrl: "https://vault.bitwarden.eu", clientId: "user.5b0e2c1a-fake", clientSecret: CLIENT_SECRET, password: MASTER };
const ACCOUNT = {
  clientId: CREDENTIALS.clientId, clientSecret: CLIENT_SECRET, password: MASTER, email: "acme-bots@acme.test",
  items: [
    { id: "i-github", name: "GitHub", type: 1 as const, login: { uris: [{ uri: "https://github.com/login" }], username: "deploy-bot", password: GITHUB } },
    { id: "i-stripe", name: "Stripe", type: 1 as const, login: { username: "acct_fake", password: `fake-dashboard-${randomBytes(6).toString("hex")}` },
      fields: [{ name: "secret key", value: STRIPE, type: 1 as const }] },
    { id: "i-oauth", name: "Acme OAuth", type: 2 as const, notes: NOTE },
  ],
};

type Asked = { status: number; body: { messageId?: string; text?: string } };

let fx: CloudSendFixture, team: CloudTeamFixture;
let admin = "", ada = "";
let ledger: { id: string; threadId: string };
let adaThread = "";
const said: string[] = [];

const as = async (token: string, method: string, path: string, body?: unknown) => {
  const answer = await team.as(token, method, path, body);
  said.push(JSON.stringify(answer.body));
  return answer;
};
async function ask(threadId: string, label: string): Promise<Asked> {
  const bearer = await team.capability(ledger.id, threadId);
  const answer = await fetch(`${team.base}/api/internal/request-credential`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ label, reason: "For test charges.", delivery: "ref" }) });
  const text = await answer.text();
  said.push(text);
  return { status: answer.status, body: JSON.parse(text) };
}
const leaked = (value: string) => [...said, ...fx.answers, fx.logs()].some((text) => text.includes(value));

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-${randomBytes(8).toString("hex")}`, bitwarden: ACCOUNT, team: { id: "team-acme-bitwarden", name: "Acme" } });
  team = fx.team!;
  const owner = (await team.pair(OWNER)).token!;
  admin = (await team.pair(ADMIN)).token!;
  ada = (await team.pair(ADA)).token!;
  ledger = (await as(owner, "POST", "/api/bots", { name: "Ledger", visibility: "everyone" })).body.bot;
  adaThread = (await as(ada, "POST", `/api/bots/${ledger.id}/tasks`, { title: "Billing" })).body.task.threadId;
}, hostTimeout(300_000));

afterAll(async () => {
  await fx?.close();
});

it("an Admin connects Bitwarden for the whole team; a wrong master password keeps nothing", async () => {
  const wrong = await as(admin, "POST", "/api/logins/bitwarden", { ...CREDENTIALS, password: "fake-wrong-master" });
  expect([wrong.status, wrong.body.error]).toEqual([400, "Bitwarden did not accept the master password. Check it and connect again."]);
  expect((await as(admin, "GET", "/api/vault")).body.bitwarden).toEqual({ connected: false });
  const connected = await as(admin, "POST", "/api/logins/bitwarden", CREDENTIALS);
  expect(connected.status, JSON.stringify(connected.body)).toBe(200);
  expect(connected.body.bitwarden).toEqual({ connected: true, server: "vault.bitwarden.eu", account: "acme-bots@acme.test", items: 3 });
  const vault = (await as(admin, "GET", "/api/vault")).body;
  expect(vault.secrets.map((one: { name: string }) => one.name).sort()).toEqual(["Acme OAuth", "Stripe"]);
  expect(vault.logins.map((one: { site: string; source: string }) => [one.site, one.source])).toEqual([["github.com", "bitwarden"]]);
}, hostTimeout(60_000));

it("a member's private chat and the shared chat get it by name and by bw:// reference with no card", async () => {
  for (const [where, threadId] of [["Ada's private chat", adaThread], ["the shared chat", ledger.threadId]] as const) {
    for (const label of ["Stripe", "Acme OAuth", "bw://Stripe/secret key", "bw://GitHub/password", "bw://i-github/username", "bw://Acme OAuth"]) {
      const asked = await ask(threadId, label);
      expect([asked.status, asked.body.messageId], `${where}: ${label}`).toEqual([200, undefined]);
      expect(asked.body.text, `${where}: ${label}`).toMatch(/secret-ref:[0-9a-f]{32}/u);
    }
  }
  expect((await ask(adaThread, "bw://Nothing/password")).status, "an item the account doesn't see").toBe(201);
  for (const value of [STRIPE, GITHUB, NOTE, CLIENT_SECRET, MASTER]) expect(leaked(value), "a value in an answer or log").toBe(false);
}, hostTimeout(60_000));

it("a member neither sees nor manages the team's Bitwarden", async () => {
  const mine = (await as(ada, "GET", "/api/vault")).body;
  expect([mine.bitwarden, mine.secrets, mine.logins]).toEqual([{ connected: false }, [], []]);
  for (const [method, path, body] of [["POST", "/api/logins/bitwarden", CREDENTIALS], ["POST", "/api/logins/bitwarden/refresh", {}], ["DELETE", "/api/logins/bitwarden", undefined],
    ["DELETE", "/api/logins/bitwarden:i-github:github.com", undefined]] as const) {
    expect((await as(ada, method, path, body)).status, `${method} ${path}`).toBe(403);
  }
  expect((await as(admin, "GET", "/api/vault")).body.bitwarden.connected, "still connected").toBe(true);
}, hostTimeout(30_000));

it("the Admin's signed report names Bitwarden and its server, never a value or a credential", async () => {
  const report = await team.signed("GET", CLOUD_TEAM_ADMIN_PATH);
  expect(report.status, JSON.stringify(report.body)).toBe(200);
  expect(report.body.vault.providers).toEqual([{ kind: "1password", connected: false, label: "" }, { kind: "bitwarden", connected: true, label: "vault.bitwarden.eu" }]);
  const text = JSON.stringify(report.body);
  for (const value of [STRIPE, GITHUB, NOTE, CLIENT_SECRET, MASTER, CREDENTIALS.clientId]) expect(text.includes(value), "a value or credential in the report").toBe(false);
}, hostTimeout(30_000));

it("an Admin disconnects it: the Vault lists none of it, and a reference asks with a card again", async () => {
  expect((await as(admin, "DELETE", "/api/logins/bitwarden")).body.bitwarden).toEqual({ connected: false });
  expect((await as(admin, "GET", "/api/vault")).body.secrets).toEqual([]);
  expect((await ask(adaThread, "bw://Stripe/secret key")).status).toBe(201);
}, hostTimeout(30_000));
