import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BotLogins } from "../bot-logins.ts";
import { json, readBody } from "../harness/http.ts";
import type { OnePasswordLogins } from "../onepassword.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createLoginRoutes, LOGIN_ERRORS, parseBitwardenSecretsCredentials } from "../routes/logins.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { createVaultRoutes } from "../routes/vault.ts";
import { encryptForBitwarden, fakeBws, type FakeBwsSecret } from "../testing/fake-bws.ts";
import { parseTotpKey } from "../totp.ts";
import { TEAM_READER, VaultStore } from "../vault-store.ts";
import { findLinkedSecret, linkedCandidates, linkedSecrets, linkedSites, readLinkedSecret } from "../vault/providers.ts";
import { BITWARDEN_SECRETS_BAD_TOKEN, BitwardenSecrets, BitwardenSecretsProblem, loginFromNote, parseBitwardenSecretsReference } from "./bitwarden-secrets.ts";
import { accessTokenKey, decryptEncString, parseAccessToken, SecretsApiError, SecretsManagerClient, secretsServer, type SecretsFetch } from "./bitwarden-secrets-api.ts";

// Obvious fakes only; no network.
const SERVER = "https://vault.bitwarden.com";
const GITHUB_PASSWORD = "fake-github-Passw0rd";
const TOTP = "otpauth://totp/GitHub:bot?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";
const STRIPE_KEY = "sk_test_fake-bws-stripe-123";
const SECRETS: FakeBwsSecret[] = [
  { key: "GitHub deploy", value: GITHUB_PASSWORD, note: `url: https://github.com/login\nusername: deploy-bot\ntotp: ${TOTP}` },
  { key: "STRIPE_KEY", value: STRIPE_KEY, note: "Live key for billing" },
  { key: "Twin", value: "fake-twin-1" },
  { key: "twin", value: "fake-twin-2" },
];

function setup(secrets = SECRETS) {
  const fake = fakeBws({ secrets });
  let saved: { serverUrl: string; accessToken: string } | null = { serverUrl: SERVER, accessToken: fake.accessToken };
  let now = Date.UTC(2026, 10, 21, 12);
  const vault = new BitwardenSecrets({ credentials: () => saved, fetch: fake.fetch, now: () => now });
  return { vault, fake, setSaved: (value: typeof saved) => { saved = value; }, later: (ms: number) => { now += ms; } };
}

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a Secrets Manager access token", () => {
  it("is read as version 0, a machine account id, its client secret and a 16-byte seed", () => {
    const seed = randomBytes(16);
    const id = "0f3c1a2b-1111-4222-8333-444455556666";
    const token = parseAccessToken(`0.${id}.fakeClientSecret:${seed.toString("base64")}`);
    expect(token).toMatchObject({ id, clientSecret: "fakeClientSecret" });
    expect(parseAccessToken(`0.${id}.fakeClientSecret:${seed.toString("base64").replace(/=+$/u, "")}`), "the seed without padding").not.toBeNull();
    for (const bad of ["", "ops_fake", `1.${id}.secret:${seed.toString("base64")}`, `0.not-a-uuid.secret:${seed.toString("base64")}`, `0.${id}.:${seed.toString("base64")}`,
      `0.${id}.secret`, `0.${id}.secret:${randomBytes(15).toString("base64")}`, `0.${id}.secret:${seed.toString("base64")}:x`, `0.${id}.sec ret:${seed.toString("base64")}`,
      `0.${id}.secret:${"A".repeat(1100)}`]) {
      expect(parseAccessToken(bad), bad).toBeNull();
    }
  });

  it("derives its key with HKDF-SHA256, salt bitwarden-accesstoken and info sm-access-token", () => {
    const seed = randomBytes(16);
    const prk = createHmac("sha256", "bitwarden-accesstoken").update(seed).digest();
    const first = createHmac("sha256", prk).update(Buffer.concat([Buffer.from("sm-access-token"), Buffer.from([1])])).digest();
    const second = createHmac("sha256", prk).update(Buffer.concat([first, Buffer.from("sm-access-token"), Buffer.from([2])])).digest();
    expect(accessTokenKey(seed)).toEqual({ enc: first, mac: second });
  });

  it("decrypts a type 2 EncString only when its MAC is right", () => {
    const key = accessTokenKey(randomBytes(16));
    const encrypted = encryptForBitwarden("fake-text-ü", key);
    expect(decryptEncString(encrypted, key).toString("utf8")).toBe("fake-text-ü");
    const [iv, data, mac] = encrypted.slice(2).split("|");
    const flipped = Buffer.from(data!, "base64");
    flipped[0]! ^= 1;
    for (const bad of [`2.${iv}|${flipped.toString("base64")}|${mac}`, `0.${iv}|${data}`, `2.${iv}|${data}`, "not an EncString", null]) {
      expect(() => decryptEncString(bad, key)).toThrow(SecretsApiError);
    }
    expect(() => decryptEncString(encrypted, accessTokenKey(randomBytes(16))), "another key").toThrow(SecretsApiError);
  });

  it("talks to bitwarden.com and bitwarden.eu on their identity and api hosts, a self-hosted server under its address", () => {
    expect(secretsServer("https://vault.bitwarden.com")).toEqual({ identity: "https://identity.bitwarden.com", api: "https://api.bitwarden.com" });
    expect(secretsServer("https://vault.bitwarden.eu")).toEqual({ identity: "https://identity.bitwarden.eu", api: "https://api.bitwarden.eu" });
    expect(secretsServer("https://bw.example.test")).toEqual({ identity: "https://bw.example.test/identity", api: "https://bw.example.test/api" });
  });
});

describe("Bitwarden Secrets Manager in the Vault", () => {
  it("connects with the access token and lists a secret whose note names a site as a login, the others by name, never a value", async () => {
    const { vault, fake } = setup();
    expect(await vault.connect({ serverUrl: SERVER, accessToken: fake.accessToken }, () => {})).toEqual({ connected: true, server: "vault.bitwarden.com", items: 4 });
    expect(fake.state.calls).toEqual(["POST identity/connect/token", expect.stringMatching(/^GET api\/organizations\/[0-9a-f-]{36}\/secrets$/u), "POST api/secrets/get-by-ids"]);
    const text = JSON.stringify(vault.items());
    for (const value of [GITHUB_PASSWORD, STRIPE_KEY, "JBSWY3DPEHPK3PXP", "fake-twin-1", fake.accessToken]) expect(text).not.toContain(value);
    expect(linkedSites(vault, "pepper")).toEqual([{ site: "github.com", hosts: ["github.com"], exactHost: false, username: "deploy-bot" }]);
    expect(linkedSecrets(vault).map((secret) => [secret.name, secret.provider, secret.readOnly]).sort()).toEqual([
      ["STRIPE_KEY", "bitwarden-secrets", true], ["Twin", "bitwarden-secrets", true], ["twin", "bitwarden-secrets", true]]);
  });

  it("fills a login with the secret's value as the password and the note's 2FA key, read from Bitwarden at fill time", async () => {
    const { vault, fake } = setup();
    await vault.refresh();
    expect(linkedCandidates(vault, "evil-github.com.example", "pepper")).toEqual([]);
    const [candidate] = linkedCandidates(vault, "github.com", "pepper");
    expect(candidate).toMatchObject({ site: "github.com", username: "deploy-bot", source: "bitwarden-secrets" });
    fake.state.calls.length = 0;
    expect(await candidate!.secrets()).toEqual({ password: GITHUB_PASSWORD, totp: parseTotpKey(TOTP) });
    expect(fake.state.calls).toEqual(["POST api/secrets/get-by-ids"]);
  });

  it("reads a secret by name or by bws:// reference, and not one whose name two secrets share", async () => {
    const { vault, fake } = setup();
    await vault.refresh();
    const stripe = findLinkedSecret([vault], "stripe_key", "pepper");
    expect(stripe?.secret.name).toBe("STRIPE_KEY");
    expect(await readLinkedSecret(stripe!)).toBe(STRIPE_KEY);
    const byName = findLinkedSecret([vault], "bws://STRIPE_KEY", "pepper");
    expect(await readLinkedSecret(byName!)).toBe(STRIPE_KEY);
    const byId = findLinkedSecret([vault], `bws://${fake.secrets[1]!.id}`, "pepper");
    expect(await readLinkedSecret(byId!)).toBe(STRIPE_KEY);
    expect(findLinkedSecret([vault], "bws://twin", "pepper"), "two secrets of that name").toBeNull();
    expect(findLinkedSecret([vault], "bws://nothing", "pepper")).toBeNull();
    expect(parseBitwardenSecretsReference("bws://a/b")).toBeNull();
    expect(parseBitwardenSecretsReference("op://vault/item")).toBeNull();
  });

  it("says the token was not accepted, and keeps nothing, for a revoked token or one whose seed was changed", async () => {
    for (const pick of ["revoked", "wrongSeed"] as const) {
      const { vault, fake, setSaved } = setup();
      setSaved(null);
      const save = vi.fn();
      await expect(vault.connect({ serverUrl: SERVER, accessToken: fake[pick] }, save), pick).rejects.toThrow(BITWARDEN_SECRETS_BAD_TOKEN);
      expect(save).not.toHaveBeenCalled();
      expect(vault.items()).toEqual([]);
      expect(vault.status()).toEqual({ connected: false });
    }
  });

  it("signs in again once when the bearer token ended, and renews it before Bitwarden says it ends", async () => {
    const { vault, fake, later } = setup();
    await vault.refresh();
    fake.expire();
    fake.state.calls.length = 0;
    const [candidate] = linkedCandidates(vault, "github.com", "pepper");
    expect((await candidate!.secrets()).password).toBe(GITHUB_PASSWORD);
    expect(fake.state.calls).toEqual(["POST api/secrets/get-by-ids", "POST identity/connect/token", "POST api/secrets/get-by-ids"]);
    fake.state.calls.length = 0;
    later(3_600_000 - 59_000);
    await candidate!.secrets();
    expect(fake.state.calls).toEqual(["POST identity/connect/token", "POST api/secrets/get-by-ids"]);
  });

  it("says Bitwarden is limiting requests on a 429, and keeps the list it had", async () => {
    const { vault, fake } = setup();
    await vault.refresh();
    fake.state.status = 429;
    expect((await vault.refresh()).error).toBe("Bitwarden is limiting requests right now. Try again in a few minutes.");
    expect(vault.failure()).toBe("rate-limited");
    expect(linkedSites(vault, "pepper")).toHaveLength(1);
  });

  it("never keeps a list that was being read when it was disconnected", async () => {
    const { vault, fake, setSaved } = setup();
    let open!: () => void;
    fake.state.gate = new Promise((done) => { open = done; });
    const reading = vault.refresh();
    setSaved(null);
    vault.clear();
    setSaved({ serverUrl: SERVER, accessToken: fake.accessToken });
    open();
    await reading;
    expect(vault.items()).toEqual([]);
  });

  it("reads the others of a batch when Bitwarden refuses it for one secret that is gone", async () => {
    const fake = fakeBws({ secrets: SECRETS });
    const client = new SecretsManagerClient({ serverUrl: SERVER, token: parseAccessToken(fake.accessToken)!, fetch: fake.fetch });
    const ids = fake.secrets.map((secret) => secret.id);
    const gone = "00000000-0000-4000-8000-000000000000";
    expect((await client.get([ids[0]!, gone, ids[1]!])).map((secret) => secret.value)).toEqual([GITHUB_PASSWORD, STRIPE_KEY]);
    expect(await client.get([gone])).toEqual([]);
  });

  it("says Bitwarden could not be read, and keeps nothing, when the list answer is not a list", async () => {
    for (const answer of [{ status: 200, body: {} }, { status: 404, body: {} }]) {
      const fake = fakeBws({ secrets: SECRETS });
      const fetch: SecretsFetch = (url, init) => (url.includes("/organizations/") ? Promise.resolve({ status: answer.status, text: async () => JSON.stringify(answer.body) }) : fake.fetch(url, init));
      const vault = new BitwardenSecrets({ credentials: () => null, fetch });
      const save = vi.fn();
      await expect(vault.connect({ serverUrl: SERVER, accessToken: fake.accessToken }, save), String(answer.status)).rejects.toThrow(BitwardenSecretsProblem);
      expect(save).not.toHaveBeenCalled();
    }
  });

  it("lists every secret by name past the first 1,000, which are the ones read for login notes", async () => {
    const many = Array.from({ length: 1_001 }, (_, index) => ({ key: `KEY_${index}`, value: `fake-value-${index}` }));
    const { vault, fake } = setup(many);
    expect((await vault.refresh()).items).toBe(1_001);
    expect(fake.state.calls.filter((call) => call === "POST api/secrets/get-by-ids")).toHaveLength(10);
    expect(await readLinkedSecret(findLinkedSecret([vault], `bws://${fake.secrets[1_000]!.id}`, "pepper")!)).toBe("fake-value-1000");
  });

  it("keeps the connection it had when the new token could not be saved, and a list read for the old one never replaces the new", async () => {
    const old = fakeBws({ secrets: SECRETS });
    const next = fakeBws({ secrets: [{ key: "NEXT_KEY", value: "fake-next" }], serverUrl: "https://bw.example.test" });
    const fetch: SecretsFetch = (url, init) => (url.startsWith("https://bw.example.test") ? next.fetch(url, init) : old.fetch(url, init));
    let saved = { serverUrl: SERVER, accessToken: old.accessToken };
    const vault = new BitwardenSecrets({ credentials: () => saved, fetch });
    await vault.refresh();
    const nextCredentials = { serverUrl: "https://bw.example.test", accessToken: next.accessToken };
    await expect(vault.connect(nextCredentials, () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    expect(linkedSecrets(vault).map((secret) => secret.name).sort()).toEqual(["STRIPE_KEY", "Twin", "twin"]);
    expect(vault.status()).toMatchObject({ server: "vault.bitwarden.com" });

    let open!: () => void;
    const connecting = vault.connect(nextCredentials, () => { saved = nextCredentials; });
    old.state.gate = new Promise((done) => { open = done; });
    const oldList = vault.refresh();
    await connecting;
    open();
    await oldList;
    expect(linkedSecrets(vault).map((secret) => secret.name)).toEqual(["NEXT_KEY"]);
  });

  it("drops a value that arrives after it was disconnected", async () => {
    const { vault, fake, setSaved } = setup();
    await vault.refresh();
    const stripe = findLinkedSecret([vault], "STRIPE_KEY", "pepper")!;
    let open!: () => void;
    try {
      fake.state.gate = new Promise((done) => { open = done; });
      const reading = readLinkedSecret(stripe);
      setSaved(null);
      vault.clear();
      open();
      await expect(reading).rejects.toThrow("no longer in");
    } finally { open(); }
  });

  it("gives a login's password only to the site its note still names", async () => {
    const { vault, fake } = setup();
    await vault.refresh();
    const [candidate] = linkedCandidates(vault, "github.com", "pepper");
    fake.secrets[0]!.note = "url: https://other.example\nusername: deploy-bot";
    await expect(candidate!.secrets()).rejects.toThrow("no longer in");
    fake.secrets[0]!.note = "url: https://github.com/session\nusername: deploy-bot";
    fake.secrets[0]!.value = "fake-rotated-Passw0rd";
    expect((await candidate!.secrets()).password, "a new password on the same site").toBe("fake-rotated-Passw0rd");
  });

  it("gives a login's password only while its note still names the same username", async () => {
    const { vault, fake } = setup();
    await vault.refresh();
    const [candidate] = linkedCandidates(vault, "github.com", "pepper");
    fake.secrets[0]!.note = "url: https://github.com/login\nusername: replacement-bot";
    fake.secrets[0]!.value = "fake-replacement-Passw0rd";
    await expect(candidate!.secrets()).rejects.toThrow("no longer in");
  });

  it("refuses a login picked before its username changed, even after the list is read again", async () => {
    const { vault, fake } = setup();
    await vault.refresh();
    const [candidate] = linkedCandidates(vault, "github.com", "pepper");
    fake.secrets[0]!.note = "url: https://github.com/login\nusername: replacement-bot";
    fake.secrets[0]!.value = "fake-replacement-Passw0rd";
    await vault.refresh();
    await expect(candidate!.secrets()).rejects.toThrow("no longer in");
    const [replacement] = linkedCandidates(vault, "github.com", "pepper");
    expect((await replacement!.secrets()).password, "the login as it is listed now").toBe("fake-replacement-Passw0rd");
  });

  it("reads the new connection on a refresh asked for after connecting, not an old read started while connecting", async () => {
    const old = fakeBws({ secrets: SECRETS });
    const next = fakeBws({ secrets: [{ key: "NEXT_KEY", value: "fake-next" }], serverUrl: "https://bw.example.test" });
    const fetch: SecretsFetch = (url, init) => (url.startsWith("https://bw.example.test") ? next.fetch(url, init) : old.fetch(url, init));
    const nextCredentials = { serverUrl: "https://bw.example.test", accessToken: next.accessToken };
    let saved: { serverUrl: string; accessToken: string } | null = { serverUrl: SERVER, accessToken: old.accessToken };
    const vault = new BitwardenSecrets({ credentials: () => saved, fetch });
    let openNext!: () => void;
    let openOld!: () => void;
    next.state.gate = new Promise((done) => { openNext = done; });
    old.state.gate = new Promise((done) => { openOld = done; });
    try {
      const connecting = vault.connect(nextCredentials, () => { saved = nextCredentials; });
      const oldList = vault.refresh();
      openNext();
      await connecting;
      next.secrets.push({ id: "0f3c1a2b-1111-4222-8333-444455556666", key: "LATER_KEY", value: "fake-later" });
      const after = vault.refresh();
      openOld();
      expect((await after).items, "the refresh read the new connection").toBe(2);
      await oldList.catch(() => undefined);
      expect(linkedSecrets(vault).map((secret) => secret.name).sort()).toEqual(["LATER_KEY", "NEXT_KEY"]);
    } finally { openNext(); openOld(); }
  });

  it("reads the new connection on a refresh asked for after a reconnect, not the old one still being read", async () => {
    const old = fakeBws({ secrets: SECRETS });
    const next = fakeBws({ secrets: [{ key: "NEXT_KEY", value: "fake-next" }], serverUrl: "https://bw.example.test" });
    const fetch: SecretsFetch = (url, init) => (url.startsWith("https://bw.example.test") ? next.fetch(url, init) : old.fetch(url, init));
    let saved: { serverUrl: string; accessToken: string } | null = { serverUrl: SERVER, accessToken: old.accessToken };
    const vault = new BitwardenSecrets({ credentials: () => saved, fetch });
    let open!: () => void;
    old.state.gate = new Promise((done) => { open = done; });
    try {
      const oldList = vault.refresh();
      saved = null;
      vault.clear();
      saved = { serverUrl: "https://bw.example.test", accessToken: next.accessToken };
      expect((await vault.refresh()).items).toBe(1);
      expect(linkedSecrets(vault).map((secret) => secret.name)).toEqual(["NEXT_KEY"]);
      open();
      await oldList.catch(() => undefined);
      expect(linkedSecrets(vault).map((secret) => secret.name)).toEqual(["NEXT_KEY"]);
    } finally { open(); }
  });

  it("reads a login only from the note's url: or site: lines, its username and 2FA key", () => {
    expect(loginFromNote("Site: example.com\nUSERNAME: a@example.com\nurl: https://login.example.com/x")).toEqual({ hosts: ["example.com", "login.example.com"], username: "a@example.com", totp: null });
    expect(loginFromNote("username: someone\njust words")).toBeNull();
    expect(loginFromNote("")).toBeNull();
  });
});

describe("Settings → Vault → Bitwarden Secrets Manager", () => {
  async function serve(team = true) {
    const dir = mkdtempSync(join(tmpdir(), "omb-bws-routes-"));
    dirs.push(dir);
    const store = new VaultStore({ dataDir: dir });
    const fake = fakeBws({ secrets: SECRETS });
    const secrets = new BitwardenSecrets({ credentials: () => store.bitwardenSecretsCredentials(), fetch: fake.fetch });
    const onePassword = { id: "1password", label: "1Password", fresh: async () => {}, items: () => [], read: async () => ({}), markUsed: () => {},
      list: () => [], status: () => ({ connected: false }) } as unknown as OnePasswordLogins;
    const logins = new BotLogins(store, onePassword, () => [], () => {}, null, secrets);
    const deps = logins.routes((id) => id === "pepper");
    const routes = [createLoginRoutes(deps), createVaultRoutes({ logins: deps, secrets: store, linked: () => logins.linkedSecrets(), reader: () => (team ? TEAM_READER : { person: "m1", team: false }) })];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) };
    };
    return { store, fake, logins, call };
  }

  it("is for admins only", () => {
    for (const method of ["POST", "DELETE"]) expect(requiredScope(method, "/api/logins/bitwarden-secrets")).toBe("admin");
    expect(requiredScope("POST", "/api/logins/bitwarden-secrets/refresh")).toBe("admin");
  });

  it("checks the server address and the token before trying them", () => {
    const token = fakeBws({ secrets: [] }).accessToken;
    expect(parseBitwardenSecretsCredentials({ serverUrl: SERVER, accessToken: ` ${token} ` })).toEqual({ ok: true, value: { serverUrl: SERVER, accessToken: token } });
    expect(parseBitwardenSecretsCredentials({ serverUrl: "ftp://x", accessToken: token })).toEqual({ ok: false, error: LOGIN_ERRORS.bitwardenServer });
    expect(parseBitwardenSecretsCredentials({ serverUrl: SERVER, accessToken: "ops_fake" })).toEqual({ ok: false, error: LOGIN_ERRORS.bitwardenAccessToken });
  });

  it("connects, lists its logins in Settings and the Vault, keeps them read-only, and disconnects", async () => {
    const { store, fake, logins, call } = await serve();
    expect((await call("POST", "/api/logins/bitwarden-secrets", { serverUrl: SERVER, accessToken: "0.bad" })).status).toBe(400);
    const wrong = await call("POST", "/api/logins/bitwarden-secrets", { serverUrl: SERVER, accessToken: fake.revoked });
    expect(wrong).toMatchObject({ status: 400, body: { error: BITWARDEN_SECRETS_BAD_TOKEN } });
    expect(store.bitwardenSecretsCredentials(), "a token Bitwarden refused is not kept").toBeNull();
    const connected = await call("POST", "/api/logins/bitwarden-secrets", { serverUrl: SERVER, accessToken: fake.accessToken });
    expect(connected.body).toEqual({ bitwardenSecrets: { connected: true, server: "vault.bitwarden.com", items: 4 } });
    expect(store.secretValues()).toContain(fake.accessToken);
    const vault = await call("GET", "/api/vault");
    expect(vault.body.logins).toEqual([expect.objectContaining({ site: "github.com", source: "bitwarden-secrets", username: "deploy-bot" })]);
    expect(vault.body.secrets.map((secret: { name: string }) => secret.name).sort()).toEqual(["STRIPE_KEY", "Twin", "twin"]);
    expect(vault.body.bitwardenSecrets).toEqual(connected.body.bitwardenSecrets);
    for (const value of [GITHUB_PASSWORD, STRIPE_KEY, fake.accessToken]) expect(vault.text).not.toContain(value);
    expect((await call("GET", "/api/logins")).body.bitwardenSecrets).toEqual(connected.body.bitwardenSecrets);
    const id = vault.body.logins[0].id as string;
    expect((await call("PATCH", `/api/logins/${encodeURIComponent(id)}`, { bots: ["pepper"] })).status).toBe(409);
    expect((await call("DELETE", `/api/logins/${encodeURIComponent(id)}`)).status).toBe(409);
    expect(logins.secretsPrompt("pepper", TEAM_READER)).toContain("bws://secret");
    expect(await call("DELETE", "/api/logins/bitwarden-secrets")).toMatchObject({ status: 200, body: { bitwardenSecrets: { connected: false } } });
    expect(store.bitwardenSecretsCredentials()).toBeNull();
    expect((await call("GET", "/api/vault")).body).toMatchObject({ logins: [], secrets: [] });
  });

  it("keeps no token when it was disconnected while Bitwarden was checking it", async () => {
    const { store, fake, call } = await serve();
    let open!: () => void;
    fake.state.gate = new Promise((done) => { open = done; });
    const connecting = call("POST", "/api/logins/bitwarden-secrets", { serverUrl: SERVER, accessToken: fake.accessToken });
    try {
      await vi.waitFor(() => expect(fake.state.calls).toContain("POST identity/connect/token"));
      expect((await call("DELETE", "/api/logins/bitwarden-secrets")).body).toEqual({ bitwardenSecrets: { connected: false } });
    } finally { open(); }
    expect((await connecting).status).toBe(400);
    expect(store.bitwardenSecretsCredentials()).toBeNull();
    expect((await call("GET", "/api/vault")).body).toMatchObject({ logins: [], secrets: [], bitwardenSecrets: { connected: false } });
  });

  it("shows a member nothing of it", async () => {
    const { fake, logins, call } = await serve(false);
    expect((await call("POST", "/api/logins/bitwarden-secrets", { serverUrl: SERVER, accessToken: fake.accessToken })).status).toBe(200);
    expect(logins.linkedSecrets().map((secret) => secret.name)).toContain("STRIPE_KEY");
    const answer = await call("GET", "/api/vault");
    expect(answer.body).toMatchObject({ logins: [], secrets: [], bitwardenSecrets: { connected: false } });
    expect(answer.text).not.toContain("STRIPE_KEY");
  });
});
