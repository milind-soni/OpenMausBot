import { afterEach, describe, expect, it } from "vitest";

import type { LoginBots } from "../shared/logins.ts";
import { fillLogin, type FillCandidate } from "./login-fill.ts";
import { loginExtraFields, loginFields, ONE_PASSWORD_MALFORMED, ONE_PASSWORD_REFUSED, OnePasswordLogins, onePasswordProblem, onePasswordUnavailable, OnePasswordUnavailableError, sdkOnePasswordClient, secretFields } from "./onepassword.ts";
import { FakeLoginPage, LOGIN_FORM } from "./testing/fake-login-page.ts";
import { fakeOnePasswordSdk } from "./testing/fake-onepassword.ts";
import { parseTotpKey, totpCode } from "./totp.ts";
import { findLinkedSecret, linkedCandidates, linkedSecrets, linkedSites, readLinkedSecret } from "./vault/providers.ts";

// Obvious fakes only; no network.
const TOKEN = "ops_fake-service-account-token";
const VAULT_PASSWORD = "fake-1P-Passw0rd";
const KEY = "otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example";
const STRIPE = "sk_test_fake-stripe-key-123";
const DEPLOY = "fake-deploy-Passw0rd";
const NOTE = "fake-note-text-456";
const ACME_SECRET = "fake-acme-client-secret-789";
const CLIENT_ID = "fake-client-id-abc";
const CLIENT_SECRET = "fake-client-secret-def";
const PLAIN_TOKEN = "fake-plain-text-token-ghi";

function setup(options: { token?: string | null; fail?: () => Error | null; now?: () => number; grants?: Record<string, LoginBots> } = {}) {
  const { sdk, calls } = fakeOnePasswordSdk({
    token: TOKEN,
    fail: options.fail,
    vaults: {
      v2: { title: "Finance", items: [
        { id: "f1", title: "Bank", urls: ["https://bank.example.net/login"], username: "treasurer", password: "fake-bank-pass" },
      ] },
      v1: { title: "Shared with OMB", items: [
        { id: "i1", title: "Example", urls: ["https://accounts.example.com/login", "accounts.example.com"], username: "alice@example.com", password: VAULT_PASSWORD, totp: KEY },
        { id: "i2", title: "Two sites", urls: ["https://crm.example.org", "https://www.crm.example.org/"], username: "team", password: "fake-crm-pass" },
        { id: "i3", title: "No website", urls: [], username: "x", password: "fake-x-pass" },
        { id: "i4", title: "A note", category: "SecureNote", urls: ["https://notes.example.com"] },
        { id: "i5", title: "No password", urls: ["https://empty.example.com"], username: "nobody" },
        { id: "i6", title: "Stripe secret key", category: "ApiCredentials", urls: [], username: "acct_fake",
          fields: [{ id: "credential", title: "credential", fieldType: "Concealed", value: STRIPE }] },
        { id: "i7", title: "Deploy", category: "Password", urls: ["https://deploy.example.io"], password: DEPLOY },
        { id: "i8", title: "Acme OAuth", category: "SecureNote", urls: [], notes: NOTE,
          fields: [{ id: "s1", title: "client_secret", fieldType: "Concealed", value: ACME_SECRET }] },
        { id: "i9", title: "A card", category: "CreditCard", urls: [], fields: [{ id: "n", title: "number", fieldType: "Concealed", value: "4111" }] },
        { id: "i10", title: "Partner API", urls: [], username: "svc", password: "fake-partner-pass",
          fields: [{ id: "c1", title: "Client ID", fieldType: "Text", value: CLIENT_ID }, { id: "c2", title: "Client Secret", fieldType: "Concealed", value: CLIENT_SECRET }] },
        { id: "i11", title: "Plain token", category: "ApiCredentials", urls: [], fields: [{ id: "t1", title: "token", fieldType: "Text", value: PLAIN_TOKEN }] },
      ] },
    },
  });
  let token: string | null = options.token === undefined ? TOKEN : options.token;
  const grants = options.grants ?? {};
  const source = new OnePasswordLogins({ token: () => token, grants: () => grants, connect: (value) => sdkOnePasswordClient(sdk, value, "9.9.9"), now: options.now });
  return { source, calls, setToken: (value: string | null) => { token = value; } };
}

let page: FakeLoginPage | null = null;
afterEach(() => { page?.close(); page = null; });

describe("the 1Password SDK adapter", () => {
  it("reads a Login item's username, password and one-time-password field, by id first, then by type and title", () => {
    expect(loginFields([
      { id: "username", title: "username", fieldType: "Text", value: "alice" },
      { id: "password", title: "password", fieldType: "Concealed", value: "fake-pw" },
      { id: "x", title: "one-time password", fieldType: "Totp", value: KEY },
    ])).toEqual({ username: "alice", password: "fake-pw", totp: KEY });
    expect(loginFields([
      { id: "a", title: "Email", fieldType: "Email", value: "bob@example.com" },
      { id: "b", title: "Password", fieldType: "Concealed", value: "fake-pw-2" },
    ])).toEqual({ username: "bob@example.com", password: "fake-pw-2", totp: null });
    expect(loginFields([
      { id: "x", title: "Email", fieldType: "Email", value: "other@example.com" },
      { id: "username", title: "Account", fieldType: "Text", value: "alice" },
      { id: "password", title: "Password", fieldType: "Concealed", value: "fake-pw-3" },
    ]).username).toBe("alice");
    expect(loginFields([])).toEqual({ username: "", password: "", totp: null });
  });
});

describe("1Password logins", () => {
  it("lists every Login item with a website and a password by site, read-only, with each vault for every bot", async () => {
    const { source, calls } = setup();
    expect(await source.refresh()).toEqual({ connected: true, items: 3, vaults: [
      { id: "v2", title: "Finance", items: 1, bots: "all" },
      { id: "v1", title: "Shared with OMB", items: 2, bots: "all" },
    ] });
    expect(calls).toEqual(["createClient OpenMausBot", "vaults.list", "items.list v2", "items.getAll v2 f1", "items.list v1", "items.getAll v1 i1,i2,i4,i5,i6,i7,i8,i11,i3,i10"]);
    const rows = source.list();
    expect(rows.map((row) => [row.site, row.hosts, row.username, row.hasTotp, row.source, row.bots])).toEqual([
      ["example.com", ["accounts.example.com"], "alice@example.com", true, "1password", "all"],
      ["example.net", ["bank.example.net"], "treasurer", false, "1password", "all"],
      ["example.org", ["crm.example.org", "www.crm.example.org"], "team", false, "1password", "all"],
    ]);
    expect(JSON.stringify(rows)).not.toContain(VAULT_PASSWORD);
    expect(JSON.stringify(source.status())).not.toContain(TOKEN);
    expect(linkedSites(source, "pepper")).toContainEqual({ site: "example.com", hosts: ["accounts.example.com"], exactHost: false, username: "alice@example.com" });
  });

  it("offers a login on its site, and reads its password and 2FA key from 1Password at fill time", async () => {
    const { source, calls } = setup();
    await source.refresh();
    expect(linkedCandidates(source, "example.org.evil.test", "pepper")).toEqual([]);
    expect(linkedCandidates(source, "login.accounts.example.com", "pepper")).toHaveLength(1);
    const [candidate] = linkedCandidates(source, "example.com", "pepper");
    expect(candidate).toMatchObject({ site: "example.com", hosts: ["accounts.example.com"], username: "alice@example.com", source: "1password" });
    calls.length = 0;
    expect(await candidate!.secrets()).toEqual({ password: VAULT_PASSWORD, totp: parseTotpKey(KEY) });
    expect(calls).toEqual(["items.getAll v1 i1"]);
  });

  it("hides a vault narrowed to other bots from every bot it is not for", async () => {
    const { source } = setup({ grants: { v2: ["quill"], v1: [] } });
    await source.refresh();
    expect(source.status().vaults).toEqual([
      { id: "v2", title: "Finance", items: 1, bots: ["quill"] },
      { id: "v1", title: "Shared with OMB", items: 2, bots: [] },
    ]);
    expect(linkedCandidates(source, "bank.example.net", "pepper")).toEqual([]);
    expect(linkedCandidates(source, "accounts.example.com", "pepper")).toEqual([]);
    expect(linkedSites(source, "pepper")).toEqual([]);
    expect(linkedCandidates(source, "bank.example.net", "quill").map((candidate) => candidate.username)).toEqual(["treasurer"]);
    expect(linkedSites(source, "quill").map((login) => login.site)).toEqual(["example.net"]);
    expect(linkedSecrets(source, "pepper")).toEqual([]);
    expect(findLinkedSecret([source], "Stripe secret key", "pepper")).toBeNull();
    expect(linkedSecrets(source).map((secret) => [secret.name, secret.bots])).toContainEqual(["Stripe secret key", []]);
    expect(source.list().find((row) => row.site === "example.net")?.bots).toEqual(["quill"]);
    expect(source.hasVault("v2")).toBe(true);
    expect(source.hasVault("v9")).toBe(false);
  });

  it("is filled through the same path as a saved login: same origin rule, same TOTP, nothing back to the bot", async () => {
    const { source } = setup();
    await source.refresh();
    const now = 1_700_000_010_000;
    page = new FakeLoginPage("https://accounts.example.com/login", `${LOGIN_FORM}<input name="otp" autocomplete="one-time-code">`);
    const remembered: string[] = [];
    const saved: FillCandidate = { id: "local", site: "example.org", hosts: ["other.example.org"], exactHost: true, username: "local", source: "settings", secrets: async () => ({ password: "fake-local", totp: null }) };
    const fill = () => fillLogin({
      submit: false,
      candidates: async (host) => [...[saved].filter((login) => login.hosts.includes(host)), ...linkedCandidates(source, host, "pepper")],
      available: async () => [{ ...saved }, ...linkedSites(source, "pepper")],
    }, {
      engine: (args) => page!.engine(args), insertText: (text) => page!.insertText(text), press: (key) => page!.press(key), click: (selector) => page!.click(selector),
      remember: (value) => { remembered.push(value); }, now: () => now, sleep: async () => undefined,
    });
    const outcome = await fill();
    expect(outcome).toMatchObject({ ok: true, filled: ["username", "password", "code"] });
    expect(outcome.text).toContain("for alice@example.com (from 1Password) on accounts.example.com.");
    expect(page.field("#password").value).toBe(VAULT_PASSWORD);
    expect(page.field("input[name=otp]").value).toBe(totpCode(parseTotpKey(KEY)!, now));
    expect(remembered).toEqual(expect.arrayContaining([VAULT_PASSWORD, totpCode(parseTotpKey(KEY)!, now)]));
    expect(JSON.stringify(outcome)).not.toContain(VAULT_PASSWORD);
    expect(JSON.stringify(page.engineCalls)).not.toContain(VAULT_PASSWORD);

    page.navigate("https://crm.example.org.evil.test/login", LOGIN_FORM);
    const typed = page.typed.length;
    const refused = await fill();
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("No saved login for crm.example.org.evil.test.");
    expect(page.typed).toHaveLength(typed);
  });

  it("refuses a token 1Password does not accept, in words, without keeping anything", async () => {
    const { source } = setup({ token: null });
    await expect(source.refresh("ops_wrong-fake-token")).rejects.toThrow(ONE_PASSWORD_REFUSED);
    expect(source.status()).toEqual({ connected: false });
    expect(source.list()).toEqual([]);
  });

  it("never blames the token when this installation cannot load 1Password, and says so plainly", async () => {
    const logged: string[] = [];
    // As the server connects: a require that fails becomes onePasswordUnavailable.
    const connect = async () => { throw onePasswordUnavailable(new Error("Cannot find module '@1password/sdk'\nRequire stack:\n- /app/dist-server/index.js"), (line) => logged.push(line)); };
    const source = new OnePasswordLogins({ token: () => null, connect });
    const refused = source.refresh(TOKEN);
    await expect(refused).rejects.toThrow("1Password could not start on this server, so your token was not checked");
    await expect(refused).rejects.not.toThrow(/did not accept|could not be read/u);
    expect(logged).toEqual(["1Password: the SDK did not load: Cannot find module '@1password/sdk'"]);
    for (const line of logged) expect(line).not.toContain(TOKEN);
    expect(onePasswordProblem(new OnePasswordUnavailableError())).toBe(new OnePasswordUnavailableError().message);
  });

  it("tells a malformed token from one 1Password refused, and does not blame the token for unrelated errors", () => {
    // What @1password/sdk 0.5.0 says for each.
    expect(onePasswordProblem(new Error("invalid user input: encountered the following errors: service account token had invalid format"))).toBe(ONE_PASSWORD_MALFORMED);
    expect(onePasswordProblem(new Error("invalid service account token, please make sure you provide a valid service account token as parameter:  service account deserialization failed, please create another token"))).toBe(ONE_PASSWORD_MALFORMED);
    expect(onePasswordProblem(new Error("error authenticating: invalid service account token"))).toBe(ONE_PASSWORD_REFUSED);
    expect(onePasswordProblem(Object.assign(new Error("session expired"), { name: "AuthExpiredError" }))).toBe(ONE_PASSWORD_REFUSED);
    expect(onePasswordProblem(new SyntaxError("Unexpected token < in JSON at position 0"))).toBe("1Password could not be read. Try again, or connect it again with a new token.");
  });

  it("keeps what it read, and says why, when 1Password stops answering", async () => {
    let failure: Error | null = null;
    const { source } = setup({ fail: () => failure });
    await source.refresh();
    failure = Object.assign(new Error("rate limit exceeded"), { name: "RateLimitExceededError" });
    expect(await source.refresh()).toMatchObject({ connected: true, error: "1Password is limiting requests right now. Try again in a few minutes." });
    expect(source.list()).toHaveLength(3);
    expect(source.status().vaults).toHaveLength(2);
    expect(onePasswordProblem(new Error("getaddrinfo ENOTFOUND my.1password.com"))).toBe("Could not reach 1Password. Check the internet connection and try again.");
  });

  it("reads 1Password again only once its index is stale, and forgets everything when disconnected", async () => {
    let now = 0;
    const { source, calls, setToken } = setup({ now: () => now });
    await source.fresh();
    expect(calls.filter((call) => call === "vaults.list")).toHaveLength(1);
    now = 5 * 60_000;
    await source.fresh();
    expect(calls.filter((call) => call === "vaults.list")).toHaveLength(1);
    now = 11 * 60_000;
    await source.fresh();
    expect(calls.filter((call) => call === "vaults.list")).toHaveLength(2);
    setToken(null);
    expect(source.list()).toEqual([]);
    expect(linkedSites(source, "pepper")).toEqual([]);
    expect(linkedCandidates(source, "accounts.example.com", "pepper")).toEqual([]);
    source.clear();
    expect(source.list()).toEqual([]);
    expect(linkedCandidates(source, "accounts.example.com", "pepper")).toEqual([]);
    expect(source.status()).toEqual({ connected: false });
  });
});

describe("1Password secrets", () => {
  it("takes an API Credential's credential, a Password's password and a Secure Note's text as the main value, with other fields by title", () => {
    const concealed = (id: string, title: string, value: string) => ({ id, title, fieldType: "Concealed", value });
    expect([...secretFields("ApiCredentials", { fields: [{ id: "username", title: "username", fieldType: "Text", value: "acct" }, concealed("credential", "credential", "k1")] })])
      .toEqual([["", "k1"], ["username", "acct"]]);
    expect([...secretFields("Password", { fields: [concealed("password", "password", "p1")] })]).toEqual([["", "p1"]]);
    expect([...secretFields("SecureNote", { fields: [concealed("s1", "client_secret", "c1")], notes: "n1" })]).toEqual([["", "n1"], ["client_secret", "c1"]]);
    expect([...secretFields("SecureNote", { fields: [concealed("s1", "client_secret", "c1")] })]).toEqual([["", "c1"]]);
    expect([...secretFields("ApiCredentials", { fields: [{ id: "t1", title: "token", fieldType: "Text", value: "t1" }] })]).toEqual([["", "t1"]]);
    expect(secretFields("SecureNote", { fields: [] }).size).toBe(0);
  });

  it("lists API Credential, Password and Secure Note items with a value as secrets, by name and field names only", async () => {
    const { source } = setup();
    await source.refresh();
    expect(linkedSecrets(source, "pepper").map((secret) => [secret.id, secret.name, secret.fields, secret.provider, secret.readOnly, secret.bots])).toEqual([
      ["1password:v1:i8", "Acme OAuth", ["client_secret"], "1password", true, "all"],
      ["1password:v1:i7", "Deploy", [], "1password", true, "all"],
      ["1password:v1:i10", "Partner API", ["Client ID", "Client Secret"], "1password", true, "all"],
      ["1password:v1:i11", "Plain token", [], "1password", true, "all"],
      ["1password:v1:i6", "Stripe secret key", ["username"], "1password", true, "all"],
    ]);
    expect(linkedCandidates(source, "deploy.example.io", "pepper")).toEqual([]);
    const listed = JSON.stringify(source.items());
    for (const value of [STRIPE, DEPLOY, NOTE, ACME_SECRET, VAULT_PASSWORD, CLIENT_ID, CLIENT_SECRET, PLAIN_TOKEN]) expect(listed).not.toContain(value);
  });

  it("finds one by its name or \"<name> <field>\", and reads its value from 1Password only then", async () => {
    const { source, calls } = setup();
    await source.refresh();
    calls.length = 0;
    const stripe = findLinkedSecret([source], "stripe-secret-key", "pepper");
    expect(stripe).toMatchObject({ secret: { id: "1password:v1:i6" } });
    expect(calls).toEqual([]);
    expect(await readLinkedSecret(stripe!)).toBe(STRIPE);
    expect(calls).toEqual(["items.getAll v1 i6"]);
    expect(await readLinkedSecret(findLinkedSecret([source], "Acme OAuth", "pepper")!)).toBe(NOTE);
    expect(await readLinkedSecret(findLinkedSecret([source], "Acme OAuth client secret", "pepper")!)).toBe(ACME_SECRET);
    expect(findLinkedSecret([source], "A card", "pepper")).toBeNull();
    expect(source.items().find((item) => item.id === "1password:v1:i6")?.lastUsedAt).toEqual(expect.any(Number));
  });

  it("offers a Login item's own extra fields as \"<title> <field>\" secrets, never its username or password", async () => {
    const { source } = setup();
    await source.refresh();
    const read = async (name: string) => readLinkedSecret(findLinkedSecret([source], name, "pepper")!);
    expect(await read("Partner API Client ID")).toBe(CLIENT_ID);
    expect(await read("Partner API Client Secret")).toBe(CLIENT_SECRET);
    expect(await read("Partner API")).toBe(CLIENT_SECRET);
    expect(await read("Plain token")).toBe(PLAIN_TOKEN);
    for (const name of ["Partner API username", "Partner API password", "No website", "Example"]) expect(findLinkedSecret([source], name, "pepper")).toBeNull();
    expect(source.list().map((row) => row.site)).not.toContain("");
  });

  it("leaves out a Login's fallback username and password (found by type and title) from its extra fields", () => {
    const field = (id: string, title: string, fieldType: string, value: string) => ({ id, title, fieldType, value });
    const fields = [field("f1", "E-mail", "Email", "alice@example.com"), field("f2", "Site password", "Concealed", "fake-fallback-pass"),
      field("f3", "API key", "Concealed", "fake-api-key"), field("f4", "Region", "Text", "eu")];
    expect(loginFields(fields)).toMatchObject({ username: "alice@example.com", password: "fake-fallback-pass" });
    expect([...loginExtraFields({ fields })]).toEqual([["", "fake-api-key"], ["API key", "fake-api-key"], ["Region", "eu"]]);
  });

  it("never lets Logins without a website push a website login out of the item limit", async () => {
    const noSite = Array.from({ length: 500 }, (_, n) => ({ id: `n${n}`, title: `No site ${n}`, urls: [], username: "x", password: "fake-x-pass" }));
    const { sdk } = fakeOnePasswordSdk({ token: TOKEN, vaults: { v1: { title: "Big", items: [
      ...noSite, { id: "w1", title: "Website", urls: ["https://late.example.com"], username: "late", password: "fake-late-pass" },
    ] } } });
    const source = new OnePasswordLogins({ token: () => TOKEN, grants: () => ({}), connect: (value) => sdkOnePasswordClient(sdk, value, "9.9.9") });
    expect((await source.refresh()).items).toBe(1);
    expect(source.list().map((row) => row.site)).toEqual(["example.com"]);
  });

  it("says plainly when a secret left 1Password, and when 1Password can't be read", async () => {
    let failure: Error | null = null;
    const { source } = setup({ fail: () => failure });
    await source.refresh();
    const deploy = findLinkedSecret([source], "Deploy", "pepper")!;
    failure = new Error("getaddrinfo ENOTFOUND my.1password.com");
    await expect(readLinkedSecret(deploy)).rejects.toThrow("Could not reach 1Password.");
    failure = null;
    await expect(readLinkedSecret({ ...deploy, field: "nothing" })).rejects.toThrow("Deploy is no longer in 1Password, or has no value there.");
  });
});
