import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { loginPlace } from "../shared/logins.ts";
import { addHeldSecretScrubber, redactSecretsInText } from "../shared/redact.ts";
import { decryptBrowserState, encryptBrowserState } from "./browser-sites.ts";
import { HeldSecrets, LOGINS_FILE, LOGINS_KEY_FILE, MEMBER_SECRETS_FILE, TEAM_READER, VaultStore, secretForms } from "./vault-store.ts";
import { parseTotpKey } from "./totp.ts";

// Obvious fakes only: nothing here is anyone's real login.
const PASSWORD = "fake-Pa55word&<\"quoted\">";
const TOTP = parseTotpKey("JBSWY3DPEHPK3PXP")!;
const KEY = "ab".repeat(32);

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-logins-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const at = (host: string, hosts: string[] = [], exactHost = false) => loginPlace(host, hosts, exactHost);

/** The file as the previous release wrote and reads it: one exact host per login. */
const previousRelease = z.object({
  version: z.literal(1),
  logins: z.array(z.object({
    id: z.string().min(1), host: z.string().min(1), username: z.string(), password: z.string().min(1),
    source: z.enum(["card", "settings"]), bots: z.union([z.literal("all"), z.array(z.string())]), createdAt: z.number(), updatedAt: z.number(),
  })),
});

describe("the saved logins store", () => {
  it("round-trips a login and keeps nothing readable on disk", () => {
    const store = new VaultStore({ dataDir: dir, now: () => 1_000 });
    const saved = store.create({ ...at("accounts.example.com"), username: "alice@example.com", password: PASSWORD, totp: TOTP, source: "settings", bots: "all" });
    expect(saved).toEqual({ id: saved.id, site: "example.com", hosts: ["accounts.example.com"], exactHost: false, username: "alice@example.com", hasTotp: true, source: "settings", bots: "all", createdAt: 1_000 });
    expect(JSON.stringify(saved)).not.toContain(PASSWORD);

    const reopened = new VaultStore({ dataDir: dir });
    expect(reopened.list()).toEqual([saved]);
    expect(reopened.usableFor("accounts.example.com", "any-bot")[0]).toMatchObject({ password: PASSWORD, totp: TOTP });

    expect(readdirSync(dir).sort()).toEqual([LOGINS_KEY_FILE, LOGINS_FILE].sort());
    const sealed = readFileSync(join(dir, LOGINS_FILE));
    for (const word of [PASSWORD, "fake-Pa55word", "alice@example.com", "accounts.example.com", TOTP.secret, "password", "username"]) {
      expect(sealed.includes(Buffer.from(word)), word).toBe(false);
    }
    if (process.platform !== "win32") {
      expect(statSync(join(dir, LOGINS_FILE)).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, LOGINS_KEY_FILE)).mode & 0o777).toBe(0o600);
    }
  });

  it("makes no key and no file until something is saved", () => {
    const store = new VaultStore({ dataDir: dir });
    expect(store.list()).toEqual([]);
    expect(store.secretValues()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("opens nothing, and says so once, when the key does not fit", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    new VaultStore({ dataDir: dir }).create({ ...at("example.com"), username: "a", password: PASSWORD, source: "card", bots: ["b1"] });
    writeFileSync(join(dir, LOGINS_KEY_FILE), `${"0".repeat(64)}\n`);
    const store = new VaultStore({ dataDir: dir });
    expect(store.list()).toEqual([]);
    expect(store.list()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).not.toContain(PASSWORD);
    warn.mockRestore();
  });

  it("gives a login saved for one host its site, so it fills on www and other subdomains, and keeps the file readable by the previous release", () => {
    writeFileSync(join(dir, LOGINS_KEY_FILE), `${KEY}\n`, { mode: 0o600 });
    writeFileSync(join(dir, LOGINS_FILE), encryptBrowserState(JSON.stringify({ version: 1, logins: [
      { id: "old-1", host: "example.com", username: "alice", password: PASSWORD, source: "card", bots: ["pepper"], createdAt: 5, updatedAt: 5 },
      { id: "old-2", host: "alice.github.io", username: "alice", password: "fake-pages-pass", source: "settings", bots: "all", createdAt: 6, updatedAt: 6 },
      { id: "old-3", host: "login.example.org", username: "ops", password: "fake-org-pass", source: "settings", bots: "all", createdAt: 7, updatedAt: 7 },
    ], onePassword: { token: "ops_fake-token", connectedAt: 7 } }), KEY), { mode: 0o600 });
    const store = new VaultStore({ dataDir: dir, now: () => 9 });
    expect(store.list().map(({ id, site, hosts, exactHost }) => ({ id, site, hosts, exactHost }))).toEqual([
      { id: "old-2", site: "alice.github.io", hosts: ["alice.github.io"], exactHost: false },
      { id: "old-1", site: "example.com", hosts: ["example.com"], exactHost: false },
      { id: "old-3", site: "example.org", hosts: ["login.example.org"], exactHost: false },
    ]);
    expect(store.usableFor("accounts.example.com", "pepper").map((login) => login.id)).toEqual(["old-1"]);
    expect(store.usableFor("www.example.com", "pepper").map((login) => login.id)).toEqual(["old-1"]);
    expect(store.usableFor("bob.github.io", "pepper")).toEqual([]);
    expect(store.usableFor("www.example.org", "pepper").map((login) => login.id)).toEqual(["old-3"]);

    store.markUsed("old-1");
    const written = JSON.parse(decryptBrowserState(readFileSync(join(dir, LOGINS_FILE)), KEY));
    expect(written.logins[0]).toMatchObject({ id: "old-1", host: "example.com", site: "example.com", hosts: ["example.com"], exactHost: false, lastUsedAt: 9 });
    expect(previousRelease.parse(written).logins.map((login) => login.host)).toEqual(["example.com", "alice.github.io", "login.example.org"]);
    expect(new VaultStore({ dataDir: dir }).onePasswordToken()).toBe("ops_fake-token");
  });

  it("fills a login on its site and its sign-in hosts, for the bots allowed", () => {
    const store = new VaultStore({ dataDir: dir });
    store.create({ ...at("example.com", ["example.com", "login.microsoftonline.com"]), username: "card-user", password: PASSWORD, source: "card", bots: ["pepper"] });
    store.create({ ...at("example.com"), username: "shared", password: "fake-other-1", source: "settings", bots: "all" });
    store.create({ ...at("acme.okta.com", [], true), username: "tenant", password: "fake-okta-1", source: "settings", bots: "all" });
    expect(store.usableFor("accounts.example.com", "pepper").map((login) => login.username).sort()).toEqual(["card-user", "shared"]);
    expect(store.usableFor("www.example.com", "quill").map((login) => login.username)).toEqual(["shared"]);
    expect(store.usableFor("login.microsoftonline.com", "pepper").map((login) => login.username)).toEqual(["card-user"]);
    expect(store.usableFor("acme.okta.com", "quill").map((login) => login.username)).toEqual(["tenant"]);
    for (const host of ["example.com.evil.test", "ample.com", "evil.okta.com", "other.microsoftonline.com"]) expect(store.usableFor(host, "pepper"), host).toEqual([]);
    expect(store.sitesFor("quill")).toEqual([
      { site: "example.com", hosts: ["example.com"], exactHost: false, username: "shared" },
      { site: "okta.com", hosts: ["acme.okta.com"], exactHost: true, username: "tenant" },
    ]);
  });

  it("saving the same account again replaces the password, adds its sign-in hosts and widens who may use it", () => {
    const store = new VaultStore({ dataDir: dir });
    const first = store.create({ ...at("example.com"), username: "Alice", password: "fake-old-pass", source: "card", bots: ["pepper"] });
    const second = store.create({ ...at("example.com", ["accounts.example.com"]), username: "alice", password: "fake-new-pass", source: "card", bots: ["quill"] });
    expect(second.id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
    expect(store.get(first.id)).toMatchObject({ password: "fake-new-pass", bots: ["pepper", "quill"], hosts: ["example.com", "accounts.example.com"] });
    expect(store.secretValues()).not.toContain("fake-old-pass");
  });

  it("keeps two tenants of one site apart when either is kept to its exact host", () => {
    const store = new VaultStore({ dataDir: dir });
    const one = store.create({ ...at("one.okta.com", [], true), username: "alice", password: "fake-one-pass", source: "settings", bots: "all" });
    const two = store.create({ ...at("two.okta.com", [], true), username: "alice", password: "fake-two-pass", source: "settings", bots: "all" });
    expect(two.id).not.toBe(one.id);
    expect(store.usableFor("one.okta.com", "pepper").map((login) => login.password)).toEqual(["fake-one-pass"]);
    expect(store.update(one.id, { exactHost: false })).toMatchObject({ exactHost: false });
    expect(store.usableFor("two.okta.com", "pepper").map((login) => login.password).sort()).toEqual(["fake-one-pass", "fake-two-pass"]);
  });

  it("replaces a password or 2FA key, changes who may use it, and forgets a deleted login's secrets", () => {
    const store = new VaultStore({ dataDir: dir });
    const login = store.create({ ...at("example.com"), username: "a", password: "fake-one-pass", totp: TOTP, source: "settings", bots: "all" });
    expect(store.update(login.id, { password: "fake-two-pass", bots: ["pepper"] })).toMatchObject({ hasTotp: true, bots: ["pepper"] });
    expect(store.update(login.id, { totp: null })).toMatchObject({ hasTotp: false });
    expect(store.secretValues()).toEqual(["fake-two-pass"]);
    expect(store.remove(login.id)).toBe(true);
    expect(store.secretValues()).toEqual([]);
    expect(store.update("missing", { password: "x-x-x-x" })).toBeNull();
  });

  it("keeps the 1Password token in the same sealed file, and which bots each vault is for across reconnects", () => {
    const store = new VaultStore({ dataDir: dir });
    store.setOnePasswordToken("ops_fake-service-account-token");
    expect(new VaultStore({ dataDir: dir }).onePasswordToken()).toBe("ops_fake-service-account-token");
    expect(readFileSync(join(dir, LOGINS_FILE)).includes(Buffer.from("ops_fake"))).toBe(false);
    expect(store.onePasswordGrants()).toEqual({});
    store.setOnePasswordGrant("v1", ["pepper"]);
    store.setOnePasswordGrant("v2", []);
    store.setOnePasswordToken(null);
    expect(new VaultStore({ dataDir: dir }).onePasswordToken()).toBeNull();
    expect(new VaultStore({ dataDir: dir }).onePasswordGrants()).toEqual({ v1: ["pepper"], v2: [] });
    store.setOnePasswordGrant("v1", "all");
    expect(new VaultStore({ dataDir: dir }).onePasswordGrants()).toEqual({ v2: [] });
  });
});

describe("the Vault's saved secrets", () => {
  const STRIPE = "sk_test_fake-vault-secret-1";

  it("live in the same sealed file beside the logins, still version 1, which the previous release reads without losing a login", () => {
    const store = new VaultStore({ dataDir: dir, now: () => 5 });
    store.create({ ...at("example.com"), username: "alice", password: PASSWORD, source: "settings", bots: "all" });
    const saved = store.saveSecret({ name: "Stripe secret key", value: STRIPE, source: "card", bots: ["pepper"], refOnly: true });
    expect(saved).toEqual({ id: saved.id, name: "Stripe secret key", source: "card", bots: ["pepper"], refOnly: true, createdAt: 5, updatedAt: 5 });
    expect(readdirSync(dir).sort()).toEqual([LOGINS_KEY_FILE, LOGINS_FILE].sort());
    expect(readFileSync(join(dir, LOGINS_FILE)).includes(Buffer.from(STRIPE))).toBe(false);
    const reopened = new VaultStore({ dataDir: dir });
    expect(reopened.listSecrets(TEAM_READER)).toEqual([saved]);
    expect(JSON.stringify(reopened.listSecrets(TEAM_READER))).not.toContain(STRIPE);
    const key = readFileSync(join(dir, LOGINS_KEY_FILE), "utf8").trim();
    const written = JSON.parse(decryptBrowserState(readFileSync(join(dir, LOGINS_FILE)), key));
    expect(written.version).toBe(1);
    expect(previousRelease.parse(written).logins.map((login) => login.username)).toEqual(["alice"]);
  });

  it("are always masked, not only while a card's copy lives", () => {
    const store = new VaultStore({ dataDir: dir });
    const held = new HeldSecrets(store);
    expect(held.scrub(`key=${STRIPE}`)).toBe(`key=${STRIPE}`);
    const saved = store.saveSecret({ name: "Stripe secret key", value: STRIPE, source: "settings", bots: "all" });
    expect(held.scrub(`key=${STRIPE}`)).toBe("key=••••••");
    store.updateSecret(saved.id, { value: "sk_test_fake-vault-secret-2" });
    expect(held.scrub("sk_test_fake-vault-secret-2")).toBe("••••••");
    store.removeSecret(saved.id);
    expect(store.secretValues()).toEqual([]);
  });

  it("are found by name for the bots that may use them, one kept to the bot first, and a ref-only one never as a file", () => {
    const store = new VaultStore({ dataDir: dir, now: () => 1 });
    const shared = store.saveSecret({ name: "Stripe secret key", value: "sk_test_fake-shared", source: "settings", bots: "all" });
    expect(store.usableSecret("stripe-secret-key", "pepper", "file", TEAM_READER)?.id).toBe(shared.id);
    const own = store.saveSecret({ name: "STRIPE secret key", value: "sk_test_fake-own", source: "card", bots: ["pepper"], refOnly: true });
    expect(store.usableSecret("Stripe  secret key", "pepper", "ref", TEAM_READER)?.id).toBe(own.id);
    expect(store.usableSecret("Stripe secret key", "pepper", "file", TEAM_READER)?.id).toBe(shared.id);
    expect(store.usableSecret("Stripe secret key", "quill", "ref", TEAM_READER)?.id).toBe(shared.id);
    store.removeSecret(shared.id);
    expect(store.usableSecret("Stripe secret key", "quill", "ref", TEAM_READER)).toBeNull();
    expect(store.usableSecret("Stripe publishable key", "pepper", "ref", TEAM_READER)).toBeNull();
  });

  it("saving one name again for the same bots replaces its value; for other bots it is another secret", () => {
    const store = new VaultStore({ dataDir: dir });
    const first = store.saveSecret({ name: "Notion key", value: "ntn_fake-one", source: "card", bots: ["pepper"], refOnly: true });
    const again = store.saveSecret({ name: "notion key", value: "ntn_fake-two", source: "card", bots: ["pepper"] });
    expect(again).toMatchObject({ id: first.id, name: "Notion key" });
    expect(again.refOnly).toBeUndefined();
    expect(store.secretValues()).toEqual(["ntn_fake-two"]);
    expect(store.saveSecret({ name: "Notion key", value: "ntn_fake-three", source: "card", bots: ["quill"] }).id).not.toBe(first.id);
    expect(store.listSecrets(TEAM_READER)).toHaveLength(2);
    expect(store.updateSecret("missing", { name: "x" })).toBeNull();
    expect(store.removeSecret("missing")).toBe(false);
  });
});

describe("a Team Cloud member's own secrets", () => {
  const ADA = "p_ada0000000000000000000", BEN = "p_ben0000000000000000000";
  const own = (store: VaultStore, person = ADA, name = "Stripe secret key") =>
    store.saveSecret({ name, value: `sk_test_fake-${person}`, source: "card", bots: ["pepper"], refOnly: true, person });

  it("are sealed in a file of their own, which the previous release never opens, and read back as theirs", () => {
    const store = new VaultStore({ dataDir: dir, now: () => 9 });
    store.saveSecret({ name: "Team key", value: "fake-team-value", source: "settings", bots: "all" });
    const saved = own(store);
    expect(saved).toEqual({ id: saved.id, name: "Stripe secret key", source: "card", bots: ["pepper"], refOnly: true, createdAt: 9, updatedAt: 9 });
    expect(readdirSync(dir).sort()).toEqual([LOGINS_KEY_FILE, LOGINS_FILE, MEMBER_SECRETS_FILE].sort());
    const key = readFileSync(join(dir, LOGINS_KEY_FILE), "utf8").trim();
    expect(JSON.parse(decryptBrowserState(readFileSync(join(dir, LOGINS_FILE)), key)).secrets.map((one: { name: string }) => one.name)).toEqual(["Team key"]);
    for (const word of ["sk_test_fake", ADA, "Stripe"]) expect(readFileSync(join(dir, MEMBER_SECRETS_FILE)).includes(Buffer.from(word)), word).toBe(false);
    if (process.platform !== "win32") expect(statSync(join(dir, MEMBER_SECRETS_FILE)).mode & 0o777).toBe(0o600);
    const reopened = new VaultStore({ dataDir: dir });
    expect(reopened.listSecrets({ person: ADA, team: false })).toEqual([saved]);
    expect(reopened.secret(saved.id)).toMatchObject({ person: ADA, value: `sk_test_fake-${ADA}` });
    expect(reopened.secretValues()).toContain(`sk_test_fake-${ADA}`);
  });

  it("reach only turns and views of that person: not another member's, not the team's, not an admin's list", () => {
    const store = new VaultStore({ dataDir: dir });
    const team = store.saveSecret({ name: "Notion key", value: "fake-notion", source: "settings", bots: "all" });
    const ada = own(store);
    expect(store.usableSecret("Stripe secret key", "pepper", "ref", { person: ADA, team: true })?.id).toBe(ada.id);
    for (const reader of [{ person: BEN, team: true }, TEAM_READER, { person: null, team: false }]) {
      expect(store.usableSecret("Stripe secret key", "pepper", "ref", reader), JSON.stringify(reader)).toBeNull();
      expect(store.secretNamesFor("pepper", reader).map((one) => one.name), JSON.stringify(reader)).toEqual(reader.team ? ["Notion key"] : []);
    }
    expect(store.secretNamesFor("pepper", { person: ADA, team: true }).map((one) => one.name).sort()).toEqual(["Notion key", "Stripe secret key"]);
    expect(store.listSecrets(TEAM_READER).map((one) => one.id)).toEqual([team.id]);
    expect(store.listSecrets({ person: BEN, team: true }).map((one) => one.id)).toEqual([team.id]);
    expect(store.listSecrets({ person: BEN, team: false })).toEqual([]);
    expect(store.listSecrets({ person: ADA, team: false }).map((one) => one.id)).toEqual([ada.id]);
  });

  it("are another secret than the team's or another member's of the same name, and are never replaced from elsewhere", () => {
    const store = new VaultStore({ dataDir: dir });
    const team = store.saveSecret({ name: "Stripe secret key", value: "fake-team", source: "card", bots: ["pepper"], refOnly: true });
    const ada = own(store);
    const ben = own(store, BEN);
    expect(new Set([team.id, ada.id, ben.id]).size).toBe(3);
    expect(own(store).id, "saved again by her, it replaces hers").toBe(ada.id);
    expect(store.secret(team.id)?.value).toBe("fake-team");
    expect(store.receiveSecret({ id: ada.id, name: "Stripe secret key", value: "fake-moved", source: "settings", bots: "all" })).toBeNull();
    expect(store.secret(ada.id)).toMatchObject({ value: `sk_test_fake-${ADA}`, person: ADA });
  });

  it("go when the person leaves, and only theirs", () => {
    const changed: string[] = [];
    const store = new VaultStore({ dataDir: dir, secretChanged: (id) => changed.push(id) });
    const team = store.saveSecret({ name: "Team key", value: "fake-team-value", source: "settings", bots: "all" });
    const ada = [own(store), own(store, ADA, "GitHub token")];
    const ben = own(store, BEN);
    expect(store.forgetPerson(ADA)).toBe(2);
    expect(changed.sort()).toEqual(ada.map((one) => one.id).sort());
    expect(store.forgetPerson(ADA)).toBe(0);
    const reopened = new VaultStore({ dataDir: dir });
    expect(reopened.listSecrets({ person: ADA, team: true }).map((one) => one.id)).toEqual([team.id]);
    expect(reopened.listSecrets({ person: BEN, team: false }).map((one) => one.id)).toEqual([ben.id]);
    expect(reopened.secretValues()).not.toContain(`sk_test_fake-${ADA}`);
  });
});

describe("what saved secrets go with", () => {
  it("a deleted bot leaves every secret kept to it, and a secret kept only to it goes with it", () => {
    const changed: string[] = [];
    const store = new VaultStore({ dataDir: dir, secretChanged: (id) => changed.push(id) });
    const shared = store.saveSecret({ name: "Shared", value: "fake-shared-value", source: "card", bots: ["ada", "kit"] });
    const only = store.saveSecret({ name: "Only Ada", value: "fake-only-value", source: "card", bots: ["ada"] });
    const everyone = store.saveSecret({ name: "Everyone", value: "fake-all-value", source: "settings", bots: "all" });
    store.forgetBot("ada");
    expect(store.secret(shared.id)?.bots).toEqual(["kit"]);
    expect(store.secret(only.id)).toBeNull();
    expect(store.secret(everyone.id)?.bots).toBe("all");
    expect(changed.sort()).toEqual([shared.id, only.id].sort());
  });

  it("a secret from the person's other computer keeps its id and bots, and sent again replaces what it first made", () => {
    const store = new VaultStore({ dataDir: dir });
    const id = "22222222-2222-4222-8222-222222222222";
    expect(store.receiveSecret({ id, name: "Stripe", value: "fake-first", source: "card", bots: ["ada"], refOnly: true })).toMatchObject({ id, refOnly: true, source: "card", bots: ["ada"] });
    expect(store.secret(id)?.value).toBe("fake-first");
    store.receiveSecret({ id, name: "Stripe key", value: "fake-second", source: "settings", bots: "all" });
    expect(store.listSecrets(TEAM_READER)).toHaveLength(1);
    expect(store.secret(id)).toMatchObject({ name: "Stripe key", value: "fake-second", bots: "all" });
    expect(store.secret(id)?.refOnly).toBeUndefined();
  });

  it("which MCP servers may read each item is sealed in the same file and forgotten with its server", () => {
    const item = "33333333-3333-4333-8333-333333333333";
    const store = new VaultStore({ dataDir: dir });
    store.grantMcpKeys("stripe", [item]);
    store.grantMcpKeys("stripe", [item, "44444444-4444-4444-8444-444444444444"]);
    const reopened = new VaultStore({ dataDir: dir });
    expect(reopened.mcpServerKeys("stripe")).toEqual([item, "44444444-4444-4444-8444-444444444444"]);
    expect(reopened.serversUsingKey(item)).toEqual(["stripe"]);
    expect(readFileSync(join(dir, LOGINS_FILE)).includes("stripe")).toBe(false);
    reopened.forgetMcpServer("stripe");
    expect(new VaultStore({ dataDir: dir }).mcpServerKeys("stripe")).toEqual([]);
  });

  it("a file holding MCP keys still opens on the previous release, which skips what it does not know", () => {
    const store = new VaultStore({ dataDir: dir });
    store.create({ ...at("example.com"), username: "alice", password: PASSWORD, source: "settings", bots: "all" });
    store.grantMcpKeys("stripe", ["33333333-3333-4333-8333-333333333333"]);
    const plain = JSON.parse(decryptBrowserState(readFileSync(join(dir, LOGINS_FILE)), readFileSync(join(dir, LOGINS_KEY_FILE), "utf8").trim()));
    expect(previousRelease.safeParse(plain).success).toBe(true);
  });
});

describe("the held-secret scrubber", () => {
  it("masks a saved password in every form a page or a log can show it", () => {
    const store = new VaultStore({ dataDir: dir });
    store.create({ ...at("example.com"), username: "alice", password: PASSWORD, source: "settings", bots: "all" });
    const held = new HeldSecrets(store);
    const shown = [
      `value: ${PASSWORD}`,
      JSON.stringify({ result: PASSWORD }),
      `https://example.com/login?password=${encodeURIComponent(PASSWORD)}`,
      `<input value="${secretForms(PASSWORD)[2]}">`,
    ];
    for (const text of shown) {
      const scrubbed = held.scrub(text);
      expect(scrubbed, text).toContain("••••••");
      for (const form of secretForms(PASSWORD)) expect(scrubbed, text).not.toContain(form);
    }
    expect(held.scrub("alice signed in")).toBe("alice signed in");
  });

  it("masks a password a submitted form carried in a URL, with ! ' ( ) ~ percent-encoded", () => {
    const store = new VaultStore({ dataDir: dir });
    store.create({ ...at("example.com"), username: "alice", password: "Hunter2!(x)~", source: "settings", bots: "all" });
    const url = `https://example.com/login?${new URLSearchParams({ user: "alice", password: "Hunter2!(x)~" })}`;
    expect(new HeldSecrets(store).scrub(url)).toBe("https://example.com/login?user=alice&password=••••••");
  });

  it("masks a one-time code only as a whole number, and only for a few minutes", () => {
    let now = 0;
    const held = new HeldSecrets(new VaultStore({ dataDir: dir }), () => now);
    held.remember("492039", "code");
    expect(held.scrub("Code 492039 accepted")).toBe("Code •••••• accepted");
    expect(held.scrub("order 14920391")).toBe("order 14920391");
    now = 6 * 60_000;
    expect(held.scrub("Code 492039 accepted")).toBe("Code 492039 accepted");
  });

  it("says where text still being written has begun a held password or code, and nothing once it goes another way", () => {
    let now = 0;
    const held = new HeldSecrets(new VaultStore({ dataDir: dir }), () => now);
    held.remember("correct horse battery", "password");
    held.remember("492039", "code");
    expect(held.pendingAt("Use correct horse ")).toBe(4);
    expect(held.pendingAt("Use correct horse racing ")).toBe(-1);
    expect(held.pendingAt("Use correct horse battery ")).toBe(-1);
    expect(held.pendingAt("Code 4920")).toBe(5);
    now = 6 * 60_000;
    expect(held.pendingAt("Code 4920")).toBe(-1);
  });

  it("masks a password filled from elsewhere for the rest of the run, and ignores values too short to be one", () => {
    const held = new HeldSecrets(new VaultStore({ dataDir: dir }));
    held.remember("fake-vault-pass", "password");
    held.remember("abc", "password");
    expect(held.scrub("x fake-vault-pass y abc")).toBe("x •••••• y abc");
  });

  it("runs inside every redaction once registered, short text included", () => {
    const store = new VaultStore({ dataDir: dir });
    store.create({ ...at("example.com"), username: "alice", password: "fake-hunter2", source: "settings", bots: "all" });
    const held = new HeldSecrets(store);
    const remove = addHeldSecretScrubber((text) => held.scrub(text));
    held.remember("555123", "code");
    try {
      expect(redactSecretsInText("My password is fake-hunter2, enjoy.")).toBe("My password is ••••••, enjoy.");
      expect(redactSecretsInText("555123")).toBe("••••••");
    } finally { remove(); }
    expect(redactSecretsInText("My password is fake-hunter2, enjoy.")).toBe("My password is fake-hunter2, enjoy.");
  });
});
