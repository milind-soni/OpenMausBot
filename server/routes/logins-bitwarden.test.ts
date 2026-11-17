import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BITWARDEN_DISCONNECTED, BITWARDEN_PASSWORD_REFUSED, BitwardenLogins, type BitwardenAccount, type BitwardenItem } from "../bitwarden.ts";
import { BotLogins } from "../bot-logins.ts";
import { json, readBody } from "../harness/http.ts";
import { OnePasswordLogins } from "../onepassword.ts";
import type { RequestAuth } from "../request-auth.ts";
import { VaultStore } from "../vault-store.ts";
import { createLoginRoutes, LOGIN_ERRORS } from "./logins.ts";
import { dispatchRoutes } from "./table.ts";

// Obvious fakes only; no network and no real `bw`.
const CLIENT_ID = "user.fake-route-client";
const CLIENT_SECRET = "fake-route-client-secret";
const MASTER = "fake-route-master-pass";
const SITE_PASSWORD = "fake-route-site-pass";
const ITEMS: BitwardenItem[] = [
  { id: "b1", type: 1, name: "Example", login: { username: "vault-user", password: SITE_PASSWORD, uris: [{ uri: "https://vault.example.com" }] } },
];

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(options: { bitwarden?: boolean; gate?: Promise<void>; checking?: () => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-bitwarden-routes-"));
  dirs.push(dir);
  const store = new VaultStore({ dataDir: dir });
  let down: Error | null = null;
  const connects: BitwardenAccount[] = [];
  const bitwarden = new BitwardenLogins({
    account: () => store.bitwardenAccount(), grants: () => store.bitwardenGrants(), itemGrants: () => store.bitwardenItemGrants(),
    connect: async (account) => {
      connects.push(account);
      options.checking?.();
      await options.gate;
      if (account.password !== MASTER) throw new Error("Invalid master password.");
      return {
        items: async () => { if (down) throw down; return ITEMS; },
        item: async (id) => { if (down) throw down; return ITEMS.find((item) => item.id === id) ?? null; },
      };
    },
  });
  const onePassword = new OnePasswordLogins({ token: () => null, connect: async () => { throw new Error("not used"); } });
  const logins = new BotLogins(store, onePassword, () => [], () => {}, options.bitwarden === false ? null : bitwarden);
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
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    answers.push(text);
    return { status: response.status, body: JSON.parse(text) };
  };
  return { store, logins, call, answers, connects, setDown: (error: Error | null) => { down = error; } };
}

const CONNECT = { server: "https://vault.example.org/", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, password: MASTER };

describe("Settings → Logins: Bitwarden", () => {
  it("connects an account it checks first, lists its logins read-only, and never returns the key or a password", async () => {
    const { store, call, answers, connects } = await serve();
    expect((await call("GET", "/api/logins")).body.bitwarden).toEqual({ connected: false });

    const wrong = await call("POST", "/api/logins/bitwarden", { ...CONNECT, password: "fake-wrong-master" });
    expect(wrong).toEqual({ status: 400, body: { error: BITWARDEN_PASSWORD_REFUSED } });
    expect(store.bitwardenAccount()).toBeNull();

    const connected = await call("POST", "/api/logins/bitwarden", CONNECT);
    expect(connected.status).toBe(200);
    expect(connected.body.bitwarden).toEqual({ connected: true, server: "https://vault.example.org", items: 1, bots: "all" });
    expect(connects.at(-1)).toEqual({ server: "https://vault.example.org", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, password: MASTER });
    expect(store.bitwardenAccount()?.password).toBe(MASTER);

    const listed = await call("GET", "/api/logins");
    expect(listed.body.logins).toMatchObject([{ id: "bitwarden:b1:example.com", site: "example.com", username: "vault-user", source: "bitwarden" }]);
    expect((await call("DELETE", "/api/logins/bitwarden:b1:example.com")).body).toEqual({ error: LOGIN_ERRORS.bitwardenReadOnly });

    const gone = await call("DELETE", "/api/logins/bitwarden");
    expect(gone.body.bitwarden).toEqual({ connected: false });
    expect(store.bitwardenAccount()).toBeNull();
    expect((await call("GET", "/api/logins")).body.logins).toEqual([]);
    for (const answer of answers) for (const secret of [CLIENT_SECRET, MASTER, SITE_PASSWORD]) expect(answer).not.toContain(secret);
  });

  it("refuses a form without a personal API key, a master password or a plain server address", async () => {
    const { call } = await serve();
    expect((await call("POST", "/api/logins/bitwarden", { ...CONNECT, clientId: "organization.fake" })).body).toEqual({ error: LOGIN_ERRORS.bitwardenKey });
    expect((await call("POST", "/api/logins/bitwarden", { ...CONNECT, clientSecret: "has space" })).body).toEqual({ error: LOGIN_ERRORS.bitwardenKey });
    expect((await call("POST", "/api/logins/bitwarden", { ...CONNECT, password: "" })).body).toEqual({ error: LOGIN_ERRORS.bitwardenPassword });
    expect((await call("POST", "/api/logins/bitwarden", { ...CONNECT, server: "ftp://vault.example.org" })).body).toEqual({ error: LOGIN_ERRORS.bitwardenServer });
  });

  it("keeps the account to chosen bots, and one item to its own bots, only for an item in the vault", async () => {
    const { store, call, setDown } = await serve();
    await call("POST", "/api/logins/bitwarden", CONNECT);
    expect((await call("PATCH", "/api/logins/bitwarden", { bots: ["ghost"] })).status).toBe(400);
    expect((await call("PATCH", "/api/logins/bitwarden", { bots: ["pepper"] })).body.bitwarden.bots).toEqual(["pepper"]);
    expect(store.bitwardenGrants()).toEqual(["pepper"]);

    const own = await call("PATCH", "/api/logins/bitwarden/items/b1", { bots: ["quill"] });
    expect(own.status).toBe(200);
    expect(own.body.logins[0]).toMatchObject({ bots: ["quill"], bitwarden: { item: "b1", ownBots: true } });
    expect((await call("PATCH", "/api/logins/bitwarden/items/missing", { bots: ["quill"] })).status).toBe(404);

    setDown(new Error("fetch failed"));
    await call("POST", "/api/logins/bitwarden/refresh");
    expect((await call("PATCH", "/api/logins/bitwarden/items/missing", { bots: ["quill"] })).status).toBe(503);
    // Handing an item back is kept even while Bitwarden cannot be read.
    expect((await call("PATCH", "/api/logins/bitwarden/items/b1", { bots: null })).status).toBe(200);
    expect(store.bitwardenItemGrants()).toEqual({});
  });

  it("does not let a connect still being checked undo a Disconnect", async () => {
    let release = () => {};
    let checking = () => {};
    const started = new Promise<void>((done) => { checking = done; });
    const { store, call } = await serve({ gate: new Promise<void>((done) => { release = done; }), checking });
    const connecting = call("POST", "/api/logins/bitwarden", CONNECT);
    await started;
    expect((await call("DELETE", "/api/logins/bitwarden")).body.bitwarden).toEqual({ connected: false });
    release();
    expect(await connecting).toEqual({ status: 400, body: { error: BITWARDEN_DISCONNECTED } });
    expect(store.bitwardenAccount()).toBeNull();
    expect((await call("GET", "/api/logins")).body.bitwarden).toEqual({ connected: false });
  });

  it("is not there where Bitwarden cannot be linked", async () => {
    const { call } = await serve({ bitwarden: false });
    expect((await call("GET", "/api/logins")).body).not.toHaveProperty("bitwarden");
    expect((await call("POST", "/api/logins/bitwarden", CONNECT)).status).toBe(404);
  });
});
