import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BotLogins } from "../bot-logins.ts";
import { json, readBody } from "../harness/http.ts";
import { LoginStore } from "../login-store.ts";
import { ONE_PASSWORD_REFUSED, OnePasswordLogins, sdkOnePasswordClient } from "../onepassword.ts";
import { fakeOnePasswordSdk } from "../testing/fake-onepassword.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createLoginRoutes, LOGIN_ERRORS } from "./logins.ts";
import { dispatchRoutes } from "./table.ts";

const PASSWORD = "fake-Settings-pass-1";
const NEW_PASSWORD = "fake-Settings-pass-2";
const KEY = "JBSWY3DPEHPK3PXP";
const TOKEN = "ops_fake-route-token";
const VAULT_PASSWORD = "fake-vault-pass";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve() {
  const dir = mkdtempSync(join(tmpdir(), "omb-login-routes-"));
  dirs.push(dir);
  const store = new LoginStore({ dataDir: dir });
  const { sdk } = fakeOnePasswordSdk({ token: TOKEN, vaults: { v1: { title: "Shared with OMB", items: [
    { id: "i1", title: "Example", urls: ["https://vault.example.com"], username: "vault-user", password: VAULT_PASSWORD },
  ] } } });
  const onePassword = new OnePasswordLogins({ token: () => store.onePasswordToken(), grants: () => store.onePasswordGrants(), connect: (token) => sdkOnePasswordClient(sdk, token, "0.0.0") });
  const logins = new BotLogins(store, onePassword);
  const routes = [createLoginRoutes(logins.routes((id) => ["pepper", "quill"].includes(id)))];
  const answers: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
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
  return { store, logins, call, answers };
}

describe("Settings → Logins routes", () => {
  it("are for admins only", () => {
    for (const method of ["GET", "POST"]) expect(requiredScope(method, "/api/logins")).toBe("admin");
    for (const method of ["PATCH", "DELETE"]) expect(requiredScope(method, "/api/logins/abc")).toBe("admin");
    expect(requiredScope("PATCH", "/api/logins/1password/vaults/v1")).toBe("admin");
  });

  it("add, list, change and delete a login, and never return its password or 2FA key", async () => {
    const { store, call, answers } = await serve();
    const added = await call("POST", "/api/logins", { site: "https://accounts.example.com/login", username: " alice@example.com ", password: PASSWORD, totp: KEY, bots: ["pepper"] });
    expect(added.status).toBe(201);
    expect(added.body.login).toMatchObject({ site: "example.com", hosts: ["accounts.example.com"], exactHost: false, username: "alice@example.com", hasTotp: true, source: "settings", bots: ["pepper"] });
    const id = added.body.login.id;

    const listed = await call("GET", "/api/logins");
    expect(listed).toMatchObject({ status: 200, cache: "no-store" });
    expect(listed.body).toEqual({ logins: [added.body.login], onePassword: { connected: false } });

    expect((await call("PATCH", `/api/logins/${id}`, { password: NEW_PASSWORD, bots: "all" })).body.login).toMatchObject({ bots: "all", hasTotp: true });
    expect(store.get(id)?.password).toBe(NEW_PASSWORD);
    expect((await call("PATCH", `/api/logins/${id}`, { totp: null })).body.login.hasTotp).toBe(false);
    expect((await call("PATCH", `/api/logins/${id}`, {})).status).toBe(200);
    expect(store.get(id)?.password).toBe(NEW_PASSWORD);

    for (const answer of answers) for (const secret of [PASSWORD, NEW_PASSWORD, KEY]) expect(answer).not.toContain(secret);

    expect((await call("PATCH", `/api/logins/${id}`, { exactHost: true })).body.login).toMatchObject({ exactHost: true, hosts: ["accounts.example.com"] });
    expect((await call("PATCH", `/api/logins/${id}`, { exactHost: "yes" })).body).toEqual({ error: LOGIN_ERRORS.exactHost });
    expect(store.get(id)?.exactHost).toBe(true);

    expect(await call("DELETE", `/api/logins/${id}`)).toMatchObject({ status: 200, body: { ok: true } });
    expect((await call("GET", "/api/logins")).body.logins).toEqual([]);
    expect((await call("DELETE", `/api/logins/${id}`)).status).toBe(404);
  });

  it.each([
    [{ site: "not a site", username: "a", password: PASSWORD }, LOGIN_ERRORS.site],
    [{ site: "javascript:alert(1)", username: "a", password: PASSWORD }, LOGIN_ERRORS.site],
    [{ site: "example.com", username: "a" }, LOGIN_ERRORS.password],
    [{ site: "example.com", username: "a", password: "" }, LOGIN_ERRORS.password],
    [{ site: "example.com", username: "a", password: "x".repeat(513) }, LOGIN_ERRORS.long],
    [{ site: "example.com", username: "a", password: PASSWORD, totp: "not a key" }, LOGIN_ERRORS.totp],
    [{ site: "example.com", username: "a", password: PASSWORD, bots: ["nobody"] }, LOGIN_ERRORS.bots],
    [{ site: "example.com", username: "a", password: PASSWORD, exactHost: 1 }, LOGIN_ERRORS.exactHost],
  ])("refuses a login it cannot save: %j", async (body, error) => {
    const { call } = await serve();
    expect(await call("POST", "/api/logins", body)).toMatchObject({ status: 400, body: { error } });
    expect((await call("GET", "/api/logins")).body.logins).toEqual([]);
  });

  it("connects 1Password with a token it checks first, lists its logins read-only, and never returns the token", async () => {
    const { store, call, answers } = await serve();
    expect((await call("GET", "/api/logins")).body).toEqual({ logins: [], onePassword: { connected: false } });
    for (const token of ["", "ops_ has spaces", "ops_wrong-fake-token", "eyJhbGciOiJFUzI1NiJ9.fake-connect-token"]) {
      expect((await call("POST", "/api/logins/1password", { token })).status, token).toBe(400);
    }
    expect((await call("POST", "/api/logins/1password", { token: "ops_wrong-fake-token" })).body.error).toBe(ONE_PASSWORD_REFUSED);
    // A Connect token or a password is not a service account token: said so before 1Password is asked.
    expect((await call("POST", "/api/logins/1password", { token: "eyJhbGciOiJFUzI1NiJ9.fake-connect-token" })).body.error).toBe(LOGIN_ERRORS.notServiceAccount);
    expect(store.onePasswordToken()).toBeNull();

    expect(await call("POST", "/api/logins/1password", { token: TOKEN })).toMatchObject({ status: 200, body: { onePassword: { connected: true, vaults: [{ id: "v1", title: "Shared with OMB", items: 1, bots: "all" }], items: 1 } } });
    expect(store.onePasswordToken()).toBe(TOKEN);
    const listed = await call("GET", "/api/logins");
    expect(listed.body.logins).toEqual([expect.objectContaining({ site: "example.com", hosts: ["vault.example.com"], username: "vault-user", source: "1password", bots: "all" })]);
    const id = listed.body.logins[0].id as string;
    for (const method of ["PATCH", "DELETE"]) {
      expect(await call(method, `/api/logins/${encodeURIComponent(id)}`, method === "PATCH" ? { password: "fake-x-pass" } : undefined))
        .toMatchObject({ status: 409, body: { error: LOGIN_ERRORS.readOnly } });
    }
    expect((await call("POST", "/api/logins/1password/refresh", {})).body.onePassword).toMatchObject({ connected: true, items: 1 });

    expect(await call("DELETE", "/api/logins/1password")).toMatchObject({ status: 200, body: { onePassword: { connected: false } } });
    expect(store.onePasswordToken()).toBeNull();
    expect((await call("GET", "/api/logins")).body.logins).toEqual([]);
    for (const answer of answers) for (const secret of [TOKEN, VAULT_PASSWORD]) expect(answer).not.toContain(secret);
  });

  it("keeps a vault's logins to the bots chosen for it, and only for a vault the token reads", async () => {
    const { store, logins, call } = await serve();
    await call("POST", "/api/logins/1password", { token: TOKEN });
    expect(await call("PATCH", "/api/logins/1password/vaults/v1", { bots: ["quill"] }))
      .toMatchObject({ status: 200, body: { onePassword: { vaults: [{ id: "v1", bots: ["quill"] }] } } });
    expect(store.onePasswordGrants()).toEqual({ v1: ["quill"] });
    expect(await logins.candidates("pepper", "vault.example.com")).toEqual([]);
    expect(logins.sitesFor("pepper")).toEqual([]);
    expect((await logins.candidates("quill", "vault.example.com")).map((login) => login.username)).toEqual(["vault-user"]);
    expect((await call("GET", "/api/logins")).body.logins[0].bots).toEqual(["quill"]);
    expect((await call("PATCH", "/api/logins/1password/vaults/v1", { bots: ["nobody"] })).body).toEqual({ error: LOGIN_ERRORS.bots });
    expect((await call("PATCH", "/api/logins/1password/vaults/v1", {})).status).toBe(400);
    expect((await call("PATCH", "/api/logins/1password/vaults/v9", { bots: "all" })).status).toBe(404);
    expect((await call("PATCH", "/api/logins/1password/vaults/v1", { bots: "all" })).body.onePassword.vaults[0].bots).toBe("all");
    expect(store.onePasswordGrants()).toEqual({});
    expect((await logins.candidates("pepper", "vault.example.com")).map((login) => login.username)).toEqual(["vault-user"]);
  });

  it("takes changes as JSON only, so another page's form cannot post one", async () => {
    const { call } = await serve();
    expect((await call("POST", "/api/logins", { site: "example.com", password: PASSWORD }, "text/plain")).status).toBe(415);
    expect((await call("POST", "/api/logins/1password", { token: TOKEN }, "text/plain")).status).toBe(415);
  });
});
