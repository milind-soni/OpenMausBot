import { describe, expect, it } from "vitest";

import { fakeBw, type FakeBwItem } from "../testing/fake-bw.ts";
import { parseTotpKey, totpCode } from "../totp.ts";
import { findLinkedSecret, linkedCandidates, linkedSecrets, linkedSites, readLinkedSecret } from "../vault/providers.ts";
import { parseBitwardenCredentials } from "../routes/logins.ts";
import { BITWARDEN_BAD_KEY, BITWARDEN_WRONG_PASSWORD, BitwardenLogins, bitwardenServerUrl, parseBitwardenReference } from "./bitwarden-vault.ts";
import { teamVaultReport } from "./team-vault-report.ts";

// Obvious fakes only; no network.
const CREDENTIALS = { serverUrl: "https://vault.bitwarden.com", clientId: "user.0f3c1a2b-fake", clientSecret: "fake-client-secret-xyz", password: "fake-Master-Passw0rd" };
const GITHUB_PASSWORD = "fake-github-Passw0rd";
const TOTP = "otpauth://totp/GitHub:bot?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";
const STRIPE_KEY = "sk_test_fake-bw-stripe-123";
const NOTE = "fake-note-text-456";
const OAUTH_SECRET = "fake-oauth-client-secret-789";
const ITEMS: FakeBwItem[] = [
  { id: "i-github", name: "GitHub", type: 1, login: { uris: [{ uri: "https://github.com/login" }], username: "deploy-bot", password: GITHUB_PASSWORD, totp: TOTP } },
  { id: "i-stripe", name: "Stripe", type: 1, login: { username: "acct_fake", password: "fake-stripe-dashboard-pass" },
    fields: [{ name: "secret key", value: STRIPE_KEY, type: 1 }, { name: "password", value: "fake-custom-named-password", type: 1 }] },
  { id: "i-note", name: "Acme OAuth", type: 2, notes: NOTE, fields: [{ name: "client_secret", value: OAUTH_SECRET, type: 1 }] },
  { id: "i-dup-1", name: "Deploy", type: 1, login: { password: "fake-deploy-1" } },
  { id: "i-dup-2", name: "Deploy", type: 1, login: { password: "fake-deploy-2" } },
];

function setup(options: { credentials?: typeof CREDENTIALS | null; now?: () => number } = {}) {
  const fake = fakeBw({ ...CREDENTIALS, email: "bot@acme.test", items: ITEMS });
  let saved = options.credentials === undefined ? CREDENTIALS : options.credentials;
  let forgotten = 0;
  const vault = new BitwardenLogins({ credentials: () => saved, run: fake.run, now: options.now, forgetAppData: () => { forgotten++; } });
  return { vault, fake, setSaved: (value: typeof CREDENTIALS | null) => { saved = value; }, forgotten: () => forgotten };
}

describe("Bitwarden through its command line tool", () => {
  it("signs in with the API key, unlocks with the master password, and lists names and sites, never a value", async () => {
    const { vault, fake } = setup();
    expect(await vault.refresh(CREDENTIALS)).toEqual({ connected: true, server: "vault.bitwarden.com", account: "bot@acme.test", items: 3 });
    expect(fake.calls).toEqual(["status", "config server https://vault.bitwarden.com", "login --apikey", "unlock --passwordenv BW_PASSWORD --raw", "status [session]",
      "sync [session]", "list items [session]"]);
    expect(fake.secretsInArgs, "a secret in an argument").toEqual([]);
    const text = JSON.stringify(vault.items());
    for (const value of [GITHUB_PASSWORD, STRIPE_KEY, NOTE, OAUTH_SECRET, "JBSWY3DPEHPK3PXP", CREDENTIALS.password]) expect(text).not.toContain(value);
    expect(linkedSites(vault, "pepper")).toEqual([{ site: "github.com", hosts: ["github.com"], exactHost: false, username: "deploy-bot" }]);
    // A secret by name: a Secure Note's text, and a Login's custom field; never a custom field named like a built-in one.
    expect(linkedSecrets(vault).map((secret) => [secret.name, secret.fields, secret.provider])).toEqual([["Acme OAuth", ["client_secret"], "bitwarden"], ["Stripe", [], "bitwarden"]]);
  });

  it("fills a login on its site with its password and 2FA key, read from Bitwarden at fill time", async () => {
    const { vault, fake } = setup();
    await vault.refresh();
    expect(linkedCandidates(vault, "evil-github.com.example", "pepper")).toEqual([]);
    const [candidate] = linkedCandidates(vault, "github.com", "pepper");
    expect(candidate).toMatchObject({ site: "github.com", username: "deploy-bot", source: "bitwarden" });
    fake.calls.length = 0;
    expect(await candidate!.secrets()).toEqual({ password: GITHUB_PASSWORD, totp: parseTotpKey(TOTP) });
    expect(fake.calls).toEqual(["get item i-github [session]"]);
  });

  it("reads a secret by name or by bw:// reference: password, username, totp, notes or a custom field", async () => {
    const now = Date.UTC(2026, 10, 17, 12);
    const { vault } = setup({ now: () => now });
    await vault.refresh();
    const read = async (label: string) => { const use = findLinkedSecret([vault], label, "pepper"); return use ? readLinkedSecret(use) : null; };
    expect(await read("Stripe")).toBe(STRIPE_KEY);
    expect(await read("Acme OAuth")).toBe(NOTE);
    expect(await read("Acme OAuth client_secret")).toBe(OAUTH_SECRET);
    expect(await read("bw://GitHub/password")).toBe(GITHUB_PASSWORD);
    expect(await read("bw://GitHub")).toBe(GITHUB_PASSWORD);
    expect(await read("bw://i-github/username")).toBe("deploy-bot");
    expect(await read("bw://github/totp")).toBe(totpCode(parseTotpKey(TOTP)!, now));
    expect(await read("bw://Acme OAuth")).toBe(NOTE);
    expect(await read("bw://Acme OAuth/client_secret")).toBe(OAUTH_SECRET);
    expect(await read("bw://Stripe/secret key")).toBe(STRIPE_KEY);
    expect(await read("bw://Stripe/password"), "the built-in field wins over a custom one of the same name").toBe("fake-stripe-dashboard-pass");
    for (const label of ["bw://Deploy/password", "bw://Nothing/password", "bw://GitHub/nothing", "bw://Acme OAuth/totp", "Deploy", "GitHub"]) {
      expect(findLinkedSecret([vault], label, "pepper"), label).toBeNull();
    }
    expect(await read("bw://i-dup-2/password"), "two of a name: by id").toBe("fake-deploy-2");
  });

  it("parses bw:// references and checks the server address", () => {
    expect(parseBitwardenReference("bw://GitHub/totp")).toEqual({ item: "GitHub", field: "totp" });
    expect(parseBitwardenReference(" bw://Acme OAuth ")).toEqual({ item: "Acme OAuth" });
    for (const other of ["GitHub", "bw://", "bw://a/b/c", "bw://a/b?x=1", "op://a/b"]) expect(parseBitwardenReference(other), other).toBeNull();
    expect(bitwardenServerUrl("https://vault.bitwarden.eu/")).toBe("https://vault.bitwarden.eu");
    expect(bitwardenServerUrl("https://vw.example.test/bitwarden/")).toBe("https://vw.example.test/bitwarden");
    for (const bad of ["http://vault.example.test", "https://user:pass@vault.example.test", "https://vault.example.test/?a=1", "vault.bitwarden.com", 7]) expect(bitwardenServerUrl(bad), String(bad)).toBeNull();
    expect(parseBitwardenCredentials({ ...CREDENTIALS, clientId: "user.abc" })).toMatchObject({ ok: true });
    expect(parseBitwardenCredentials({ ...CREDENTIALS, clientId: "organization.abc" })).toMatchObject({ ok: false });
    expect(parseBitwardenCredentials({ ...CREDENTIALS, serverUrl: "http://vault.example.test" })).toMatchObject({ ok: false });
    expect(parseBitwardenCredentials({ ...CREDENTIALS, password: "" })).toMatchObject({ ok: false });
  });

  it("unlocks again by itself when the session ended, and signs in again when the tool was signed out", async () => {
    const { vault, fake } = setup();
    await vault.refresh();
    fake.expire();
    fake.calls.length = 0;
    expect(await readLinkedSecret(findLinkedSecret([vault], "Stripe", "pepper")!)).toBe(STRIPE_KEY);
    expect(fake.calls).toEqual(["get item i-stripe [session]", "status", "unlock --passwordenv BW_PASSWORD --raw", "status [session]", "get item i-stripe [session]"]);
    fake.state.signedIn = null;
    fake.state.sessions.clear();
    expect(await readLinkedSecret(findLinkedSecret([vault], "Stripe", "pepper")!)).toBe(STRIPE_KEY);
    expect(fake.calls).toContain("login --apikey");
    expect(fake.secretsInArgs).toEqual([]);
  });

  it("asks Bitwarden's server for the vault at most once a minute", async () => {
    let now = 1_000_000;
    const { vault, fake } = setup({ now: () => now });
    await vault.refresh();
    fake.calls.length = 0;
    await readLinkedSecret(findLinkedSecret([vault], "Stripe", "pepper")!);
    await readLinkedSecret(findLinkedSecret([vault], "Acme OAuth", "pepper")!);
    expect(fake.calls.filter((call) => call.startsWith("sync"))).toEqual([]);
    now += 61_000;
    await readLinkedSecret(findLinkedSecret([vault], "Stripe", "pepper")!);
    expect(fake.calls.filter((call) => call.startsWith("sync"))).toEqual(["sync [session]"]);
  });

  it("says plainly why it can't connect: the master password, the API key, the server or the time, and keeps nothing", async () => {
    const wrongPassword = setup({ credentials: null });
    await expect(wrongPassword.vault.refresh({ ...CREDENTIALS, password: "fake-wrong" })).rejects.toThrow(BITWARDEN_WRONG_PASSWORD);
    const wrongKey = setup({ credentials: null });
    await expect(wrongKey.vault.refresh({ ...CREDENTIALS, clientSecret: "fake-wrong" })).rejects.toThrow(BITWARDEN_BAD_KEY);
    const away = setup({ credentials: null });
    away.fake.state.unreachable = true;
    await expect(away.vault.refresh({ ...CREDENTIALS, serverUrl: "https://vw.example.test" })).rejects.toThrow("Could not reach the Bitwarden server at vw.example.test.");
    const slow = setup({ credentials: null });
    slow.fake.state.slow = true;
    await expect(slow.vault.refresh(CREDENTIALS)).rejects.toThrow("Bitwarden did not answer in time.");
    // Connected, then the server goes away: the status says so, with its class for the Admin's report.
    const { vault, fake } = setup();
    await vault.refresh();
    fake.state.unreachable = true;
    expect((await vault.refresh()).error).toMatch(/^Could not reach the Bitwarden server at vault\.bitwarden\.com\./u);
    expect(vault.failure()).toBe("cant-connect");
    expect(teamVaultReport({ secrets: [], bots: [], onePassword: { connected: false }, bitwarden: { status: vault.status(), failure: vault.failure() } }).providers)
      .toEqual([{ kind: "1password", connected: false, label: "" }, { kind: "bitwarden", connected: true, label: "vault.bitwarden.com", lastError: "cant-connect" }]);
  });

  it("connecting another account signs the tool out first; disconnecting signs out and forgets its folder", async () => {
    const { vault, fake, setSaved, forgotten } = setup();
    await vault.refresh();
    fake.calls.length = 0;
    await vault.refresh(CREDENTIALS);
    expect(fake.calls.slice(0, 4)).toEqual(["status", "logout", "config server https://vault.bitwarden.com", "login --apikey"]);
    setSaved(null);
    await vault.disconnect();
    expect(fake.calls.at(-1)).toBe("logout");
    expect(forgotten()).toBe(1);
    expect(vault.status()).toEqual({ connected: false });
    expect(vault.items()).toEqual([]);
  });
});
