import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BotLogins } from "../bot-logins.ts";
import { json, readBody } from "../harness/http.ts";
import { OnePasswordLogins, sdkOnePasswordClient } from "../onepassword.ts";
import { fakeOnePasswordSdk } from "../testing/fake-onepassword.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createVaultReaders } from "../host/vault-readers.ts";
import { TEAM_READER, VaultStore } from "../vault-store.ts";
import { createLoginRoutes } from "./logins.ts";
import { dispatchRoutes } from "./table.ts";
import { createVaultRoutes, VAULT_ERRORS } from "./vault.ts";

const VALUE = "sk_test_fake-route-secret-1";
const NEW_VALUE = "sk_test_fake-route-secret-2";
const LINKED_VALUE = "secret_fake-linked-route-3";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** `team`: a Team Cloud, where each call says who makes it (`as`: "admin" or "member", and their person key). */
async function serve(onePasswordToken: string | null = null, team = false) {
  const dir = mkdtempSync(join(tmpdir(), "omb-vault-routes-"));
  dirs.push(dir);
  const store = new VaultStore({ dataDir: dir });
  const { sdk } = fakeOnePasswordSdk({ token: "ops_fake-route-token", vaults: { v1: { title: "Shared", items: [
    { id: "n1", title: "Notion token", category: "ApiCredentials", urls: [], fields: [{ id: "credential", title: "credential", fieldType: "Concealed", value: LINKED_VALUE }] },
  ] } } });
  const onePassword = new OnePasswordLogins({ token: () => onePasswordToken, grants: () => ({}), connect: (token) => sdkOnePasswordClient(sdk, token, "0.0.0") });
  await onePassword.refresh();
  const botLogins = new BotLogins(store, onePassword);
  const logins = botLogins.routes((id) => ["pepper", "quill"].includes(id));
  const readers = createVaultReaders({ team, audienceOf: () => "team", personOf: (auth) => auth.session.id });
  const routes = [createLoginRoutes(logins), createVaultRoutes({ logins, secrets: store, linked: () => botLogins.linkedSecrets(), keys: { usedBy: (item) => store.serversUsingKey(item) }, reader: readers.viewer })];
  const answers: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const [role, person] = String(req.headers["x-test-as"] ?? "").split(":");
    const auth = (role ? { kind: "session", session: { id: person }, via: "bearer", scopes: role === "admin" ? ["admin", "client"] : ["client"] }
      : { kind: "loopback", scopes: ["admin"] }) as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, type = "application/json", as?: string) => {
    const response = await fetch(base + path, { method, headers: { "content-type": type, ...(as ? { "x-test-as": as } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    answers.push(text);
    return { status: response.status, body: JSON.parse(text), cache: response.headers.get("cache-control") };
  };
  return { store, call, answers };
}

describe("the Vault routes", () => {
  it("deleting a secret says which MCP servers lost their key, and a move's secret keeps its id and who may use it", async () => {
    const { store, call } = await serve();
    const added = await call("POST", "/api/vault/secrets", { id: "55555555-5555-4555-8555-555555555555", name: "Stripe", value: VALUE, bots: ["pepper"], source: "card", refOnly: true });
    expect(added).toMatchObject({ status: 201, body: { secret: { id: "55555555-5555-4555-8555-555555555555", source: "card", refOnly: true, bots: ["pepper"] } } });
    expect((await call("POST", "/api/vault/secrets", { id: "not an id!", name: "x", value: VALUE })).status).toBe(400);
    store.grantMcpKeys("stripe", ["55555555-5555-4555-8555-555555555555"]);
    expect(await call("DELETE", "/api/vault/secrets/55555555-5555-4555-8555-555555555555")).toMatchObject({ status: 200, body: { ok: true, keysOff: ["stripe"] } });
    const plain = await call("POST", "/api/vault/secrets", { name: "Other", value: VALUE });
    expect(await call("DELETE", `/api/vault/secrets/${plain.body.secret.id}`)).toMatchObject({ status: 200, body: { ok: true } });
  });

  it("add, list, change and delete a secret beside the logins, and never return its value", async () => {
    const { store, call, answers } = await serve();
    await call("POST", "/api/logins", { site: "example.com", username: "alice", password: "fake-route-login-pass" });
    const added = await call("POST", "/api/vault/secrets", { name: " Stripe secret key ", value: ` ${VALUE} ` });
    expect(added).toMatchObject({ status: 201, body: { secret: { name: "Stripe secret key", source: "settings", bots: "all" } } });
    const id = added.body.secret.id;
    expect(store.usableSecret("Stripe secret key", "pepper", "file", TEAM_READER)?.value).toBe(VALUE);

    const listed = await call("GET", "/api/vault");
    expect(listed).toMatchObject({ status: 200, cache: "no-store" });
    expect(listed.body.logins).toMatchObject([{ site: "example.com", username: "alice" }]);
    expect(listed.body.secrets).toEqual([added.body.secret]);
    expect(listed.body.onePassword).toEqual({ connected: false });

    expect((await call("PATCH", `/api/vault/secrets/${id}`, { value: NEW_VALUE, bots: ["quill"] })).body.secret).toMatchObject({ bots: ["quill"], name: "Stripe secret key" });
    expect(store.usableSecret("Stripe secret key", "quill", "ref", TEAM_READER)?.value).toBe(NEW_VALUE);
    expect(store.usableSecret("Stripe secret key", "pepper", "ref", TEAM_READER)).toBeNull();
    expect((await call("DELETE", `/api/vault/secrets/${id}`)).body).toEqual({ ok: true });
    expect((await call("DELETE", `/api/vault/secrets/${id}`)).status).toBe(404);
    expect(store.listSecrets(TEAM_READER)).toEqual([]);
    for (const answer of answers) {
      expect(answer).not.toContain(VALUE);
      expect(answer).not.toContain(NEW_VALUE);
      expect(answer).not.toContain("fake-route-login-pass");
    }
  });

  it("take JSON only, and refuse an empty name or value, bots that don't exist and other methods", async () => {
    const { store, call } = await serve();
    expect((await call("POST", "/api/vault/secrets", { name: "K", value: VALUE }, "text/plain")).status).toBe(415);
    expect(await call("POST", "/api/vault/secrets", { name: " ", value: VALUE })).toMatchObject({ status: 400, body: { error: VAULT_ERRORS.name } });
    expect(await call("POST", "/api/vault/secrets", { name: "K", value: " " })).toMatchObject({ status: 400, body: { error: VAULT_ERRORS.value } });
    expect(await call("POST", "/api/vault/secrets", { name: "K", value: "x".repeat(4_097) })).toMatchObject({ status: 400, body: { error: VAULT_ERRORS.value } });
    expect((await call("POST", "/api/vault/secrets", { name: "K", value: VALUE, bots: ["ghost"] })).status).toBe(400);
    const id = (await call("POST", "/api/vault/secrets", { name: "K", value: VALUE })).body.secret.id;
    expect((await call("PATCH", `/api/vault/secrets/${id}`, { value: "" })).status).toBe(400);
    expect((await call("PATCH", "/api/vault/secrets/missing", { name: "L" })).status).toBe(404);
    expect((await call("POST", "/api/vault")).status).toBe(405);
    expect((await call("PUT", `/api/vault/secrets/${id}`, {})).status).toBe(405);
    expect(store.secretValues()).toEqual([VALUE]);
  });

  it("list a linked 1Password secret beside the saved ones, by name only, and never change it", async () => {
    const { call, answers } = await serve("ops_fake-route-token");
    await call("POST", "/api/vault/secrets", { name: "Stripe secret key", value: VALUE });
    const listed = await call("GET", "/api/vault");
    expect(listed.body.secrets.map((secret: { name: string; source: string }) => [secret.name, secret.source])).toEqual([["Stripe secret key", "settings"], ["Notion token", "linked"]]);
    expect(listed.body.secrets[1]).toEqual({ id: "1password:v1:n1", name: "Notion token", fields: [], source: "linked", provider: "1password", bots: "all", readOnly: true,
      onePassword: { item: "v1:n1", ownBots: false } });
    expect((await call("DELETE", "/api/vault/secrets/1password:v1:n1")).status).toBe(404);
    expect((await call("PATCH", "/api/vault/secrets/1password:v1:n1", { name: "x" })).status).toBe(404);
    for (const answer of answers) expect(answer).not.toContain(LINKED_VALUE);
  });

  it("on a Team Cloud show a member only the secrets of their own, which they may delete, and an admin never those", async () => {
    const ADA = "p_ada0000000000000000000", BEN = "p_ben0000000000000000000", ARI = "p_ari0000000000000000000";
    const { store, call, answers } = await serve(null, true);
    const as = (who: string) => (method: string, path: string, body?: unknown) => call(method, path, body, "application/json", who);
    const ada = as(`member:${ADA}`), ben = as(`member:${BEN}`), ari = as(`admin:${ARI}`);
    const team = (await ari("POST", "/api/vault/secrets", { name: "Team key", value: VALUE })).body.secret;
    const own = store.saveSecret({ name: "Stripe secret key", value: NEW_VALUE, source: "card", bots: ["pepper"], refOnly: true, person: ADA });
    await ari("POST", "/api/logins", { site: "example.com", username: "ops", password: "fake-route-login-pass" });

    expect((await ari("GET", "/api/vault")).body.secrets.map((one: { id: string }) => one.id)).toEqual([team.id]);
    expect(await ada("GET", "/api/vault")).toMatchObject({ status: 200, cache: "no-store", body: { logins: [], secrets: [{ id: own.id, name: "Stripe secret key" }], onePassword: { connected: false } } });
    expect((await ben("GET", "/api/vault")).body).toEqual({ logins: [], secrets: [], onePassword: { connected: false } });

    for (const [who, caller] of [["an admin", ari], ["another member", ben]] as const) {
      expect((await caller("DELETE", `/api/vault/secrets/${own.id}`)).status, who).toBe(404);
      expect((await caller("PATCH", `/api/vault/secrets/${own.id}`, { value: "fake-overwrite", bots: "all" })).status, who).toBeGreaterThanOrEqual(403);
    }
    expect((await ari("POST", "/api/vault/secrets", { id: own.id, name: "Stripe secret key", value: "fake-overwrite", bots: "all" })).status).toBe(404);
    expect((await ada("DELETE", `/api/vault/secrets/${team.id}`)).status, "a member never deletes the team's").toBe(404);
    expect((await ada("POST", "/api/vault/secrets", { name: "Mine", value: VALUE })).status).toBe(403);
    expect((await ada("PATCH", `/api/vault/secrets/${own.id}`, { bots: "all" })).status).toBe(403);
    expect(store.secret(own.id)).toMatchObject({ value: NEW_VALUE, bots: ["pepper"], person: ADA });

    expect(await ada("DELETE", `/api/vault/secrets/${own.id}`)).toMatchObject({ status: 200, body: { ok: true } });
    expect(store.secret(own.id)).toBeNull();
    expect(store.secret(team.id)).not.toBeNull();
    for (const answer of answers) {
      expect(answer).not.toContain(NEW_VALUE);
      expect(answer).not.toContain(VALUE);
    }
  });

  it("off a Team Cloud show a session without admin nothing, and a member's own never exist there", async () => {
    const { call } = await serve();
    await call("POST", "/api/vault/secrets", { name: "Stripe secret key", value: VALUE });
    expect((await call("GET", "/api/vault", undefined, "application/json", "member:p_phone000000000000000000")).body).toEqual({ logins: [], secrets: [], onePassword: { connected: false } });
    expect((await call("GET", "/api/vault")).body.secrets).toHaveLength(1);
  });
});
