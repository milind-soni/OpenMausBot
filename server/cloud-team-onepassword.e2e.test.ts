// 1Password on a real Team Cloud (OMB_CLOUD_ROLE=team) with a fake SDK: an Admin connects it in Settings → Vault for the
// whole team; a member's private chat and the bot's shared chat get its secrets by name and by op:// reference with no
// card, never a Login's password; a member neither sees nor manages it; the Admin's signed report names the team's secrets
// and 1Password's state, never a value, the token or a member's own secret. No value is ever printed.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { launchCloudSendFixture, type CloudSendFixture, type CloudTeamFixture } from "../scripts/testing/cloud-send-fixture.ts";
import { CLOUD_TEAM_ADMIN_PATH } from "./cloud-team-admin.ts";
import { hostTimeout } from "./testing/host-timeout.ts";

const OWNER = { email: "olive@acme.test", role: "owner" as const };
const ADMIN = { email: "ari@acme.test", role: "admin" as const };
const ADA = { email: "ada@acme.test", role: "member" as const };
const TOKEN = `ops_fake-team-${randomBytes(12).toString("hex")}`;
const STRIPE = `sk_test_fake-1p-${randomBytes(12).toString("hex")}`;
const BANK_PASSWORD = `fake-bank-${randomBytes(12).toString("hex")}`;
const TEAM_VALUE = `fake-team-deploy-${randomBytes(12).toString("hex")}`;
const ADA_VALUE = `fake-ada-own-${randomBytes(12).toString("hex")}`;
const VAULT = "Shared with OpenMausBot";
const ITEMS = [
  { id: "i1", title: "Stripe secret key", category: "ApiCredentials", fields: [{ id: "credential", title: "credential", fieldType: "Concealed", value: STRIPE }] },
  { id: "i2", title: "Bank", category: "Login", fields: [{ id: "username", title: "username", fieldType: "Text", value: "treasurer" },
    { id: "password", title: "password", fieldType: "Concealed", value: BANK_PASSWORD }] },
];

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
/** request_credential from Ledger's turn in this conversation, as its agents tools send it. */
async function ask(threadId: string, label: string): Promise<Asked> {
  const bearer = await team.capability(ledger.id, threadId);
  const answer = await fetch(`${team.base}/api/internal/request-credential`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ label, reason: "For test charges.", delivery: "ref" }) });
  const text = await answer.text();
  said.push(text);
  return { status: answer.status, body: JSON.parse(text) };
}
/** Whether any answer, or the servers' logs, holds this value: never the value itself in a failure. */
const leaked = (value: string) => [...said, ...fx.answers, fx.logs()].some((text) => text.includes(value));

beforeAll(async () => {
  // Only the Team Cloud's own token matters here; the other servers' fakes accept another one.
  fx = await launchCloudSendFixture({ onePasswordToken: TOKEN, onePasswordItems: ITEMS, team: { id: "team-acme-1password", name: "Acme" } });
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

it("an Admin connects 1Password in Settings → Vault for the whole team", async () => {
  const connected = await as(admin, "POST", "/api/logins/1password", { token: TOKEN });
  expect(connected.status, JSON.stringify(connected.body)).toBe(200);
  expect(connected.body.onePassword).toMatchObject({ connected: true, vaults: [{ id: "v1", title: VAULT, bots: "all" }] });
  const vault = (await as(admin, "GET", "/api/vault")).body;
  expect(vault.onePassword.connected).toBe(true);
  expect(vault.secrets.map((one: { name: string }) => one.name)).toEqual(["Stripe secret key"]);
}, hostTimeout(30_000));

it("a member's private chat and the shared chat get it by name and by op:// reference with no card, never a Login's password", async () => {
  for (const [where, threadId] of [["Ada's private chat", adaThread], ["the shared chat", ledger.threadId]] as const) {
    for (const label of ["Stripe secret key", `op://${VAULT}/Stripe secret key`, `op://${VAULT}/Stripe secret key/credential`, "op://v1/i1"]) {
      const asked = await ask(threadId, label);
      expect([asked.status, asked.body.messageId], `${where}: ${label}`).toEqual([200, undefined]);
      expect(asked.body.text, `${where}: ${label}`).toMatch(/secret-ref:[0-9a-f]{32}/u);
    }
  }
  for (const label of [`op://${VAULT}/Bank/password`, `op://${VAULT}/Bank`, `op://${VAULT}/Bank/username`]) {
    expect((await ask(adaThread, label)).status, label).toBe(201);
  }
  expect(leaked(STRIPE), "the 1Password value in any answer or log").toBe(false);
  expect(leaked(BANK_PASSWORD), "the Login's password in any answer or log").toBe(false);
}, hostTimeout(60_000));

it("a member neither sees nor manages the team's 1Password", async () => {
  const mine = (await as(ada, "GET", "/api/vault")).body;
  expect(mine.onePassword).toEqual({ connected: false });
  expect(mine.secrets).toEqual([]);
  for (const [method, path, body] of [
    ["POST", "/api/logins/1password", { token: TOKEN }], ["POST", "/api/logins/1password/refresh", {}], ["DELETE", "/api/logins/1password", undefined],
    ["PATCH", "/api/logins/1password/vaults/v1", { bots: [] }], ["PATCH", "/api/logins/1password/items/v1/i1", { bots: [] }],
    ["PUT", "/api/logins/1password/items", { items: {} }], ["GET", "/api/logins", undefined],
  ] as const) {
    expect((await as(ada, method, path, body)).status, `${method} ${path}`).toBe(403);
  }
  expect((await as(admin, "GET", "/api/vault")).body.onePassword.connected, "still connected").toBe(true);
}, hostTimeout(30_000));

it("the Admin's signed report names the team's secrets and 1Password's state, never a value, the token or a member's own secret", async () => {
  expect((await as(admin, "POST", "/api/vault/secrets", { name: "Team deploy key", value: TEAM_VALUE, bots: "all" })).status).toBe(201);
  const card = await ask(adaThread, "Ada's own key");
  expect(card.status).toBe(201);
  expect((await as(ada, "POST", `/api/bots/${ledger.id}/secret-cards/${card.body.messageId}/save`, { threadId: adaThread, value: ADA_VALUE })).status).toBe(200);
  expect((await as(ada, "GET", "/api/vault")).body.secrets.map((one: { name: string }) => one.name)).toEqual(["Ada's own key"]);

  const report = await team.signed("GET", CLOUD_TEAM_ADMIN_PATH);
  expect(report.status, JSON.stringify(report.body)).toBe(200);
  expect(report.body.vault.providers).toEqual([{ kind: "1password", connected: true, label: VAULT }, { kind: "bitwarden", connected: false, label: "" }]);
  expect(report.body.vault.secrets).toEqual([{ name: "Team deploy key", addedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/u), usedBy: expect.arrayContaining(["Ledger"]) }]);
  const text = JSON.stringify(report.body);
  for (const [what, value] of [["a member's own secret", "Ada's own key"], ["the token", TOKEN], ["the team's value", TEAM_VALUE], ["1Password's value", STRIPE], ["her value", ADA_VALUE]] as const) {
    expect(text.includes(value), what).toBe(false);
  }
}, hostTimeout(60_000));
