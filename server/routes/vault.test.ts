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
import { VaultStore } from "../vault-store.ts";
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

async function serve(onePasswordToken: string | null = null) {
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
  const routes = [createLoginRoutes(logins), createVaultRoutes({ logins, secrets: store, linked: () => botLogins.linkedSecrets() })];
  const answers: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, type = "application/json") => {
    const response = await fetch(base + path, { method, headers: { "content-type": type }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    answers.push(text);
    return { status: response.status, body: JSON.parse(text), cache: response.headers.get("cache-control") };
  };
  return { store, call, answers };
}

describe("the Vault routes", () => {
  it("add, list, change and delete a secret beside the logins, and never return its value", async () => {
    const { store, call, answers } = await serve();
    await call("POST", "/api/logins", { site: "example.com", username: "alice", password: "fake-route-login-pass" });
    const added = await call("POST", "/api/vault/secrets", { name: " Stripe secret key ", value: ` ${VALUE} ` });
    expect(added).toMatchObject({ status: 201, body: { secret: { name: "Stripe secret key", source: "settings", bots: "all" } } });
    const id = added.body.secret.id;
    expect(store.usableSecret("Stripe secret key", "pepper", "file")?.value).toBe(VALUE);

    const listed = await call("GET", "/api/vault");
    expect(listed).toMatchObject({ status: 200, cache: "no-store" });
    expect(listed.body.logins).toMatchObject([{ site: "example.com", username: "alice" }]);
    expect(listed.body.secrets).toEqual([added.body.secret]);
    expect(listed.body.onePassword).toEqual({ connected: false });

    expect((await call("PATCH", `/api/vault/secrets/${id}`, { value: NEW_VALUE, bots: ["quill"] })).body.secret).toMatchObject({ bots: ["quill"], name: "Stripe secret key" });
    expect(store.usableSecret("Stripe secret key", "quill", "ref")?.value).toBe(NEW_VALUE);
    expect(store.usableSecret("Stripe secret key", "pepper", "ref")).toBeNull();
    expect((await call("DELETE", `/api/vault/secrets/${id}`)).body).toEqual({ ok: true });
    expect((await call("DELETE", `/api/vault/secrets/${id}`)).status).toBe(404);
    expect(store.listSecrets()).toEqual([]);
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
    expect(listed.body.secrets[1]).toEqual({ id: "1password:v1:n1", name: "Notion token", fields: [], source: "linked", provider: "1password", bots: "all", readOnly: true });
    expect((await call("DELETE", "/api/vault/secrets/1password:v1:n1")).status).toBe(404);
    expect((await call("PATCH", "/api/vault/secrets/1password:v1:n1", { name: "x" })).status).toBe(404);
    for (const answer of answers) expect(answer).not.toContain(LINKED_VALUE);
  });
});
