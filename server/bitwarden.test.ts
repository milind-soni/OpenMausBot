import { describe, expect, it } from "vitest";

import type { LoginBots } from "../shared/logins.ts";
import {
  BITWARDEN_DEFAULT_SERVER, BITWARDEN_DISCONNECTED, BITWARDEN_KEY_REFUSED, bitwardenLoginPlaces, BITWARDEN_PASSWORD_REFUSED, BitwardenCliMissingError, BitwardenLogins, bitwardenProblem, bitwardenServer,
  bitwardenSecretFields, bwRunner, cliBitwardenClient, type BitwardenAccount, type BitwardenItem, type BwResult,
} from "./bitwarden.ts";
import { parseTotpKey } from "./totp.ts";
import { findLinkedSecret, linkedCandidates, linkedSecrets, linkedSites, readLinkedSecret } from "./vault/providers.ts";

// Obvious fakes only; no network and no real `bw`.
const ACCOUNT: BitwardenAccount = { server: "https://vault.example.test", clientId: "user.fake-client-id", clientSecret: "fake-client-secret-abc", password: "fake-master-Passw0rd" };
const SESSION = "fake-session-key-xyz";
const KEY = "otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example";
const SITE_PASSWORD = "fake-site-Passw0rd";
const NOTE = "fake-note-text-456";
const API_KEY = "fake-api-key-789";

const ITEMS: BitwardenItem[] = [
  { id: "a1", type: 1, name: "Example", login: { username: "alice@example.com", password: SITE_PASSWORD, totp: KEY, uris: [{ uri: "https://accounts.example.com/login" }, { uri: "https://www.example.com" }] } },
  { id: "a2", type: 1, name: "Two sites", login: { username: "team", password: "fake-crm-pass", uris: [{ uri: "https://crm.example.org" }, { uri: "https://shop.example.net" }] } },
  { id: "a3", type: 1, name: "No website", login: { username: "x", password: "fake-x-pass", uris: [] } },
  { id: "a4", type: 1, name: "No password", login: { username: "nobody", uris: [{ uri: "https://empty.example.com" }] } },
  { id: "a5", type: 2, name: "Acme OAuth", notes: NOTE, fields: [{ name: "client secret", value: "fake-acme-secret", type: 1 }, { name: "flag", value: "true", type: 2 }] },
  { id: "a6", type: 1, name: "Deploy API", login: { username: "deployer", password: "fake-deploy-pass", uris: [{ uri: "https://deploy.example.io" }] },
    fields: [{ name: "api key", value: API_KEY, type: 1 }, { name: "region", value: "eu", type: 0 }] },
  { id: "a7", type: 3, name: "A card" },
];

function fakeClient(items: BitwardenItem[] = ITEMS, fail: { error: Error | null } = { error: null }) {
  const calls: string[] = [];
  const client = {
    items: async () => { calls.push("items"); if (fail.error) throw fail.error; return items; },
    item: async (id: string) => { calls.push(`item ${id}`); if (fail.error) throw fail.error; return items.find((item) => item.id === id) ?? null; },
  };
  return { client, calls };
}

function setup(options: { account?: BitwardenAccount | null; items?: BitwardenItem[]; grants?: LoginBots; itemGrants?: Record<string, LoginBots>; now?: () => number } = {}) {
  const fail = { error: null as Error | null };
  const { client, calls } = fakeClient(options.items, fail);
  const connects: BitwardenAccount[] = [];
  let account = options.account === undefined ? ACCOUNT : options.account;
  const bitwarden = new BitwardenLogins({
    account: () => account,
    connect: async (one) => { connects.push(one); if (fail.error) throw fail.error; return client; },
    grants: () => options.grants ?? "all",
    itemGrants: () => options.itemGrants ?? {},
    now: options.now,
  });
  return { bitwarden, calls, connects, fail, setAccount: (next: BitwardenAccount | null) => { account = next; } };
}

describe("BitwardenLogins", () => {
  it("lists website logins by site and secrets by name, never a value", async () => {
    const { bitwarden } = setup();
    const status = await bitwarden.refresh();
    expect(status).toEqual({ connected: true, server: "https://vault.example.test", items: 4, bots: "all" });
    const listed = bitwarden.items();
    expect(listed.filter((item) => item.kind === "login").map((item) => item.kind === "login" && `${item.site} ${item.username} ${item.hasTotp}`))
      .toEqual(["example.com alice@example.com true", "example.io deployer false", "example.net team false", "example.org team false"]);
    expect(listed.filter((item) => item.kind === "secret").map((item) => item.kind === "secret" && `${item.name}: ${item.fields.join(",")}`))
      .toEqual(["Acme OAuth: client secret", "Deploy API: region"]);
    const text = JSON.stringify(listed);
    for (const secret of [SITE_PASSWORD, NOTE, API_KEY, "fake-acme-secret", ACCOUNT.password, ACCOUNT.clientSecret]) expect(text).not.toContain(secret);
    expect(listed.every((item) => (item.kind === "login" ? item.source === "bitwarden" : item.source === "linked" && item.provider === "bitwarden"))).toBe(true);
  });

  it("reads a login's password and 2FA key and a secret's value only when used", async () => {
    const { bitwarden, calls } = setup();
    await bitwarden.refresh();
    calls.length = 0;
    const [candidate] = linkedCandidates(bitwarden, "accounts.example.com", "bot-1");
    expect(candidate).toMatchObject({ site: "example.com", username: "alice@example.com", source: "bitwarden" });
    expect(await candidate!.secrets()).toEqual({ password: SITE_PASSWORD, totp: parseTotpKey(KEY) });
    expect(calls).toEqual(["item a1"]);
    const note = findLinkedSecret([bitwarden], "acme oauth", "bot-1");
    expect(note && await readLinkedSecret(note)).toBe(NOTE);
    const field = findLinkedSecret([bitwarden], "Acme OAuth client secret", "bot-1");
    expect(field && await readLinkedSecret(field)).toBe("fake-acme-secret");
    const extra = findLinkedSecret([bitwarden], "Deploy API", "bot-1");
    expect(extra && await readLinkedSecret(extra)).toBe(API_KEY);
    expect(bitwarden.items().find((item) => item.id === "bitwarden:a5")).toHaveProperty("lastUsedAt");
  });

  it("gives each item the account's bots unless it has its own", async () => {
    const { bitwarden } = setup({ grants: ["bot-1"], itemGrants: { a2: ["bot-2"] } });
    await bitwarden.refresh();
    expect(linkedSites(bitwarden, "bot-1").map((login) => login.site)).toEqual(["example.com", "example.io"]);
    expect(linkedSites(bitwarden, "bot-2").map((login) => login.site)).toEqual(["example.net", "example.org"]);
    expect(linkedSecrets(bitwarden, "bot-2")).toEqual([]);
    const crm = bitwarden.items().find((item) => item.id === "bitwarden:a2:example.org");
    expect(crm).toMatchObject({ bots: ["bot-2"], bitwarden: { item: "a2", ownBots: true } });
    expect(bitwarden.items().find((item) => item.id === "bitwarden:a5")).toMatchObject({ bots: ["bot-1"], bitwarden: { item: "a5", ownBots: false } });
  });

  it("says a deleted item is gone instead of filling an old password", async () => {
    const items = [...ITEMS];
    const { bitwarden } = setup({ items });
    await bitwarden.refresh();
    items.splice(0, 1);
    const [candidate] = linkedCandidates(bitwarden, "www.example.com", "bot-1");
    await expect(candidate!.secrets()).rejects.toThrow("This login is no longer in Bitwarden, or has no password there.");
  });

  it("lists nothing and reads nothing when not connected", async () => {
    const { bitwarden, connects } = setup({ account: null });
    expect(await bitwarden.refresh()).toEqual({ connected: false });
    await bitwarden.fresh();
    expect(bitwarden.items()).toEqual([]);
    expect(await bitwarden.read("bitwarden:a1:example.com")).toEqual({});
    expect(connects).toEqual([]);
  });

  it("checks a new account only after a read of the old one ends, since both use one bw folder", async () => {
    let release = () => {};
    const gate = new Promise<void>((done) => { release = done; });
    const connects: string[] = [];
    const bitwarden = new BitwardenLogins({
      account: () => ACCOUNT,
      connect: async (one) => {
        connects.push(one.clientId);
        return { items: async () => { if (one === ACCOUNT) await gate; return ITEMS; }, item: async () => null };
      },
    });
    const old = bitwarden.refresh();
    const next = bitwarden.refresh({ ...ACCOUNT, clientId: "user.fake-next" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connects).toEqual([ACCOUNT.clientId]);
    release();
    await Promise.all([old, next]);
    expect(connects).toEqual([ACCOUNT.clientId, "user.fake-next"]);
  });

  it("checks a new account before it is kept and throws plain words when it fails", async () => {
    const { bitwarden, fail } = setup({ account: null });
    fail.error = new Error("Invalid master password.");
    await expect(bitwarden.refresh(ACCOUNT)).rejects.toThrow(BITWARDEN_PASSWORD_REFUSED);
    fail.error = null;
    expect(await bitwarden.refresh(ACCOUNT)).toMatchObject({ connected: true, items: 4 });
  });

  it("keeps the last list with an error when a later read fails, and reads again once it is stale", async () => {
    let now = 0;
    const { bitwarden, fail, calls } = setup({ now: () => now });
    await bitwarden.fresh();
    expect(calls).toEqual(["items"]);
    await bitwarden.fresh();
    expect(calls).toEqual(["items"]);
    now = 11 * 60_000;
    fail.error = Object.assign(new Error("getaddrinfo ENOTFOUND vault.example.test"), {});
    await bitwarden.fresh();
    expect(bitwarden.status().error).toBe("Could not reach the Bitwarden server. Check the server address and the internet connection, then try again.");
    expect(bitwarden.list()).toHaveLength(4);
  });

  it("finds an item before its bots change, and says so when the vault cannot be read instead of calling it gone", async () => {
    const { bitwarden, fail, setAccount } = setup();
    expect(await bitwarden.readsItem("a1")).toBe(true);
    expect(await bitwarden.readsItem("a5")).toBe(true);
    expect(await bitwarden.readsItem("missing")).toBe(false);
    fail.error = new Error("fetch failed");
    expect(await bitwarden.readsItem("missing")).toBeNull();
    setAccount(null);
    expect(await bitwarden.readsItem("a1")).toBe(false);
  });

  it("connects again when the account changes", async () => {
    const { bitwarden, connects, setAccount } = setup();
    await bitwarden.refresh();
    await bitwarden.refresh();
    expect(connects).toHaveLength(1);
    setAccount({ ...ACCOUNT, password: "fake-other-Passw0rd" });
    await bitwarden.refresh();
    expect(connects).toHaveLength(2);
  });
});

describe("bitwardenSecretFields", () => {
  it("takes a note's text, else the first hidden field, as the main value", () => {
    expect([...bitwardenSecretFields(ITEMS[4]!)]).toEqual([["", NOTE], ["client secret", "fake-acme-secret"]]);
    expect([...bitwardenSecretFields(ITEMS[5]!)]).toEqual([["", API_KEY], ["region", "eu"]]);
    expect(bitwardenSecretFields(ITEMS[0]!).size).toBe(0);
  });
});

describe("bitwardenServer", () => {
  it("defaults to bitwarden.com and keeps only a plain web address", () => {
    expect(bitwardenServer(undefined)).toBe(BITWARDEN_DEFAULT_SERVER);
    expect(bitwardenServer(" ")).toBe(BITWARDEN_DEFAULT_SERVER);
    expect(bitwardenServer("https://vault.example.test/")).toBe("https://vault.example.test");
    expect(bitwardenServer("https://example.test/vw/")).toBe("https://example.test/vw");
    expect(bitwardenServer("ftp://example.test")).toBeNull();
    expect(bitwardenServer("https://user:pass@example.test")).toBeNull();
    expect(bitwardenServer("not a url")).toBeNull();
  });
});

describe("bitwardenProblem", () => {
  it("puts each failure in plain words and never repeats what bw printed", () => {
    expect(bitwardenProblem(new BitwardenCliMissingError())).toMatch(/not installed on this computer/u);
    expect(bitwardenProblem(new Error("client_id or client_secret is incorrect. Try again."))).toBe(BITWARDEN_KEY_REFUSED);
    expect(bitwardenProblem(new Error("Invalid master password."))).toBe(BITWARDEN_PASSWORD_REFUSED);
    expect(bitwardenProblem(new Error(`weird ${ACCOUNT.password}`))).toBe("Bitwarden could not be read. Try again, or connect it again.");
  });
});

/** A stand-in for `bw`: answers like the real CLI and records each call's arguments and environment. */
function fakeBw(options: { status?: string; serverUrl?: string | null; items?: BitwardenItem[]; locked?: number; password?: string } = {}) {
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  let state = options.status ?? "unauthenticated";
  let lockedLeft = options.locked ?? 0;
  const ok = (stdout: string): BwResult => ({ code: 0, stdout, stderr: "" });
  const no = (stdout: string): BwResult => ({ code: 1, stdout, stderr: "" });
  const run = async (args: string[], env: Record<string, string>): Promise<BwResult> => {
    calls.push({ args, env });
    const [command] = args;
    if (command === "status") return ok(JSON.stringify({ serverUrl: options.serverUrl ?? null, status: state }));
    if (command === "logout") { state = "unauthenticated"; return ok("You have logged out."); }
    if (command === "config") return ok("Saved setting `config`.");
    if (command === "login") {
      if (env.BW_CLIENTID !== ACCOUNT.clientId || env.BW_CLIENTSECRET !== ACCOUNT.clientSecret) return no("client_id or client_secret is incorrect. Try again.");
      state = "locked"; return ok("You are logged in!");
    }
    if (command === "unlock") return env.BW_PASSWORD === (options.password ?? ACCOUNT.password) ? ok(SESSION) : no("Invalid master password.");
    if (env.BW_SESSION !== SESSION) return no("Vault is locked.");
    if (lockedLeft > 0) { lockedLeft--; return no("Vault is locked."); }
    if (command === "sync") return ok("Syncing complete.");
    if (command === "list") return ok(JSON.stringify(options.items ?? ITEMS));
    if (command === "get") { const item = (options.items ?? ITEMS).find((one) => one.id === args[2]); return item ? ok(JSON.stringify(item)) : no("Not found."); }
    return no("unknown command");
  };
  return { run, calls };
}

describe("cliBitwardenClient", () => {
  it("logs in with the API key and unlocks with the master password through the environment only", async () => {
    const bw = fakeBw();
    const client = await cliBitwardenClient(ACCOUNT, { run: bw.run, appDir: "/data/bw" });
    expect(await client.items()).toHaveLength(ITEMS.length);
    expect((await client.item("a1"))?.login?.password).toBe(SITE_PASSWORD);
    expect(await client.item("gone")).toBeNull();
    expect(bw.calls.map((call) => call.args.join(" "))).toEqual([
      "status", "config server https://vault.example.test", "login --apikey", "unlock --passwordenv BW_PASSWORD --raw", "sync", "list items", "sync", "get item a1", "sync", "get item gone",
    ]);
    for (const call of bw.calls) {
      expect(call.env.BITWARDENCLI_APPDATA_DIR).toBe("/data/bw");
      const argv = call.args.join(" ");
      for (const secret of [ACCOUNT.clientSecret, ACCOUNT.password, SESSION]) expect(argv).not.toContain(secret);
    }
    // Each secret goes only to the command that needs it.
    expect(bw.calls.filter((call) => call.env.BW_PASSWORD).map((call) => call.args[0])).toEqual(["unlock"]);
    expect(bw.calls.filter((call) => call.env.BW_CLIENTSECRET).map((call) => call.args[0])).toEqual(["login"]);
  });

  it("logs out first so the folder never keeps another account, and leaves the server when it is already set", async () => {
    const bw = fakeBw({ status: "locked", serverUrl: "https://vault.example.test/" });
    await cliBitwardenClient(ACCOUNT, { run: bw.run, appDir: "/data/bw" });
    expect(bw.calls.map((call) => call.args[0])).toEqual(["status", "logout", "login", "unlock"]);
  });

  it("unlocks again when the CLI locked itself in between", async () => {
    const bw = fakeBw({ locked: 1 });
    const client = await cliBitwardenClient(ACCOUNT, { run: bw.run, appDir: "/data/bw" });
    expect((await client.item("a1"))?.id).toBe("a1");
    expect(bw.calls.slice(-4).map((call) => call.args[0])).toEqual(["sync", "unlock", "sync", "get"]);
  });

  it("fails with the person's words for a wrong key or master password", async () => {
    await expect(cliBitwardenClient({ ...ACCOUNT, clientSecret: "fake-wrong" }, { run: fakeBw().run, appDir: "/data/bw" }).catch((error: unknown) => { throw new Error(bitwardenProblem(error)); }))
      .rejects.toThrow(BITWARDEN_KEY_REFUSED);
    await expect(cliBitwardenClient(ACCOUNT, { run: fakeBw({ password: "fake-other" }).run, appDir: "/data/bw" }).catch((error: unknown) => { throw new Error(bitwardenProblem(error)); }))
      .rejects.toThrow(BITWARDEN_PASSWORD_REFUSED);
  });

  it("says bw is missing when it is not installed", async () => {
    await expect(bwRunner("/nonexistent/omb-test-bw")(["status"], {})).rejects.toBeInstanceOf(BitwardenCliMissingError);
  });
});

describe("Bitwarden review fixes", () => {
  const login = (uris: Array<{ uri: string; match?: number | null }>): BitwardenItem => ({ id: "m1", type: 1, name: "Matched", login: { username: "u", password: "fake-matched-pass", uris } });

  it("keeps each saved address's match rule: a host address fills only on that host", async () => {
    expect(bitwardenLoginPlaces(login([{ uri: "https://accounts.example.com", match: 1 }]))).toEqual([{ site: "example.com", hosts: ["accounts.example.com"], exactHost: true }]);
    expect(bitwardenLoginPlaces(login([{ uri: "https://accounts.example.com", match: null }, { uri: "https://www.example.com", match: 0 }])))
      .toEqual([{ site: "example.com", hosts: ["accounts.example.com", "www.example.com"], exactHost: false }]);
    // Starts with, exact, regular expression and never can't be kept by a site-or-hosts place, so they fill nowhere.
    expect(bitwardenLoginPlaces(login([2, 3, 4, 5].map((match) => ({ uri: `https://m${match}.example.org/login`, match }))))).toEqual([]);
    // A base-domain address on the same site already opens it all.
    expect(bitwardenLoginPlaces(login([{ uri: "https://a.example.com", match: 1 }, { uri: "https://example.com", match: 0 }]))).toEqual([{ site: "example.com", hosts: ["example.com"], exactHost: false }]);

    const { bitwarden } = setup({ items: [login([{ uri: "https://accounts.example.com", match: 1 }])] });
    await bitwarden.refresh();
    expect(bitwarden.items()).toMatchObject([{ kind: "login", site: "example.com", hosts: ["accounts.example.com"], exactHost: true }]);
    expect(linkedCandidates(bitwarden, "shop.example.com", "bot-1")).toEqual([]);
    expect(linkedCandidates(bitwarden, "accounts.example.com", "bot-1")).toHaveLength(1);
  });

  it("leaves out a host address kept to a port of its own, since a place cannot keep the port", () => {
    expect(bitwardenLoginPlaces(login([{ uri: "https://accounts.example.com:4000", match: 1 }]))).toEqual([]);
    expect(bitwardenLoginPlaces(login([{ uri: "https://accounts.example.com:443/login", match: 1 }]))).toEqual([{ site: "example.com", hosts: ["accounts.example.com"], exactHost: true }]);
  });

  it("gives a password only to the page its candidate was picked for, even after a refresh narrows the item", async () => {
    const items = [login([{ uri: "https://example.com" }])];
    const { bitwarden } = setup({ items });
    await bitwarden.refresh();
    const [picked] = linkedCandidates(bitwarden, "shop.example.com", "bot-1");
    items[0] = login([{ uri: "https://accounts.example.com", match: 1 }]);
    await bitwarden.refresh();
    await expect(picked!.secrets()).rejects.toThrow("no longer in Bitwarden");
    const [now] = linkedCandidates(bitwarden, "accounts.example.com", "bot-1");
    expect(await now!.secrets()).toMatchObject({ password: "fake-matched-pass" });
  });

  it("gives a password only where its item still fills now, not where it was listed", async () => {
    const items = [login([{ uri: "https://accounts.example.com" }])];
    const { bitwarden } = setup({ items });
    await bitwarden.refresh();
    const [candidate] = linkedCandidates(bitwarden, "accounts.example.com", "bot-1");
    items[0] = login([{ uri: "https://other.example.org" }]);
    await expect(candidate!.secrets()).rejects.toThrow("This login is no longer in Bitwarden, or has no password there.");
    items[0] = login([{ uri: "https://accounts.example.com", match: 1 }]);
    await expect(candidate!.secrets(), "narrowed to one host after it was listed for the whole site").rejects.toThrow("no longer in Bitwarden");
    items[0] = login([{ uri: "https://accounts.example.com" }, { uri: "https://new.example.com" }]);
    expect(await candidate!.secrets()).toMatchObject({ password: "fake-matched-pass" });
  });

  it("reads an item only after a check of another account ends, since both use one bw folder", async () => {
    let release = () => {};
    const gate = new Promise<void>((done) => { release = done; });
    const order: string[] = [];
    const bitwarden = new BitwardenLogins({
      account: () => ACCOUNT,
      connect: async (one) => ({
        items: async () => { if (one !== ACCOUNT) { await gate; order.push("checked next"); } return ITEMS; },
        item: async (id) => { order.push(`read ${id}`); return ITEMS.find((item) => item.id === id) ?? null; },
      }),
    });
    await bitwarden.refresh();
    const checking = bitwarden.refresh({ ...ACCOUNT, clientId: "user.fake-next" });
    const reading = bitwarden.read("bitwarden:a1:example.com");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([]);
    release();
    await Promise.all([checking, reading]);
    expect(order).toEqual(["checked next", "read a1"]);
  });

  it("keeps nothing a read finds after Disconnect, fails a check under way, and removes the CLI copy only once bw is done", async () => {
    let release = () => {};
    const gate = new Promise<void>((done) => { release = done; });
    const order: string[] = [];
    let account: BitwardenAccount | null = ACCOUNT;
    const bitwarden = new BitwardenLogins({
      account: () => account,
      connect: async () => ({ items: async () => { await gate; order.push("listed"); return ITEMS; }, item: async () => null }),
      dropCopy: () => { order.push("copy removed"); },
    });
    const checking = bitwarden.refresh({ ...ACCOUNT, clientId: "user.fake-new" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    account = null;
    const forgotten = bitwarden.forget();
    release();
    await expect(checking).rejects.toThrow(BITWARDEN_DISCONNECTED);
    await forgotten;
    expect(order).toEqual(["listed", "copy removed"]);
    expect(bitwarden.items()).toEqual([]);
    expect(bitwarden.status()).toEqual({ connected: false });

    // Nor does a plain refresh under way bring the old account's list back.
    account = ACCOUNT;
    let again = () => {};
    const held = new Promise<void>((done) => { again = done; });
    const slow = new BitwardenLogins({ account: () => account, connect: async () => ({ items: async () => { await held; return ITEMS; }, item: async () => null }) });
    const read = slow.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    account = null;
    void slow.forget();
    again();
    expect(await read).toEqual({ connected: false });
    account = ACCOUNT;
    expect(slow.items(), "the list read before Disconnect was dropped").toEqual([]);
  });

  it("does not let a check queued behind another bw use run after Disconnect", async () => {
    let release = () => {};
    const gate = new Promise<void>((done) => { release = done; });
    let account: BitwardenAccount | null = ACCOUNT;
    const connects: string[] = [];
    const bitwarden = new BitwardenLogins({
      account: () => account,
      connect: async (one) => {
        connects.push(one.clientId);
        return { items: async () => ITEMS, item: async (id) => { await gate; return ITEMS.find((item) => item.id === id) ?? null; } };
      },
    });
    await bitwarden.refresh();
    const reading = bitwarden.read("bitwarden:a1:example.com");
    const checking = bitwarden.refresh({ ...ACCOUNT, clientId: "user.fake-queued" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    account = null;
    const forgotten = bitwarden.forget();
    release();
    await expect(checking).rejects.toThrow(BITWARDEN_DISCONNECTED);
    expect(await reading).toEqual({});
    await forgotten;
    expect(connects, "the queued check never signed in to bw").toEqual([ACCOUNT.clientId]);
    account = ACCOUNT;
    expect(bitwarden.items(), "nothing listed after Disconnect").toEqual([]);
  });
});
