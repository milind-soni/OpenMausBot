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
      "sync --force [session]", "list items [session]"]);
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

  it("reads host:port URIs, ignores trashed items, and keeps website logins ahead of MAX_ITEMS filler", async () => {
    const filler: FakeBwItem[] = Array.from({ length: 1005 }, (_, i) => ({
      id: `i-filler-${i}`, name: `Filler ${i}`, type: 1 as const, login: { password: "fake-filler-password" },
    }));
    const items: Array<FakeBwItem & { deletedDate?: string | null }> = [
      ...filler,
      { id: "i-deleted", name: "Deleted", type: 1, deletedDate: "2026-11-20T00:00:00Z", login: { uris: [{ uri: "https://deleted.example.test" }], password: "fake-deleted-password" } },
      { id: "i-port", name: "App", type: 1, login: { uris: [null as unknown as { uri: string }, { uri: "app.example.com:8443/login" }], username: "port-user", password: "fake-port-password" } },
    ];
    const fake = fakeBw({ ...CREDENTIALS, email: "bot@acme.test", items });
    const vault = new BitwardenLogins({ credentials: () => CREDENTIALS, run: fake.run });
    expect(await vault.refresh(CREDENTIALS)).toEqual({ connected: true, server: "vault.bitwarden.com", account: "bot@acme.test", items: 1 });
    expect(linkedSites(vault, "pepper")).toEqual([{ site: "example.com", hosts: ["app.example.com"], exactHost: false, username: "port-user" }]);
  });

  it("explains why a connected vault lists 0 items, and never silently turns malformed CLI output into 0 items", async () => {
    const cases: Array<{ items: Array<FakeBwItem & { type?: number }>; expected: { total: number; hiddenPasswords: number; noWebsite: number } }> = [
      { items: [], expected: { total: 0, hiddenPasswords: 0, noWebsite: 0 } },
      { items: [{ id: "i-hidden", name: "Hidden", type: 1, login: { uris: [{ uri: "https://example.com" }], username: "u", password: null } }],
        expected: { total: 1, hiddenPasswords: 1, noWebsite: 0 } },
      { items: [{ id: "i-nourl", name: "No URL", type: 1, login: { uris: [], username: "u", password: "fake-password" } }],
        expected: { total: 1, hiddenPasswords: 0, noWebsite: 1 } },
      { items: [{ id: "i-empty-note", name: "Empty note", type: 2, notes: "" }],
        expected: { total: 1, hiddenPasswords: 0, noWebsite: 0 } },
    ];
    for (const { items, expected } of cases) {
      const fake = fakeBw({ ...CREDENTIALS, email: "bot@acme.test", items: items as FakeBwItem[] });
      const vault = new BitwardenLogins({ credentials: () => CREDENTIALS, run: fake.run });
      expect(await vault.refresh(CREDENTIALS)).toEqual({ connected: true, server: "vault.bitwarden.com", account: "bot@acme.test", items: 0, empty: expected });
    }

    let allowSession = false;
    const broken = new BitwardenLogins({
      credentials: () => CREDENTIALS,
      run: async (args, env) => {
        if (args[0] === "status") {
          const unlocked = allowSession && Boolean(env?.BW_SESSION);
          return { code: 0, stdout: JSON.stringify({ status: unlocked ? "unlocked" : "locked", userEmail: "bot@acme.test" }), stderr: "", timedOut: false };
        }
        if (args[0] === "unlock") return { code: 0, stdout: "fake-session", stderr: "", timedOut: false };
        if (args[0] === "sync") return { code: 0, stdout: "Syncing complete.", stderr: "", timedOut: false };
        if (args[0] === "list") return { code: 0, stdout: JSON.stringify({ unexpected: true }), stderr: "", timedOut: false };
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    await expect(broken.refresh(CREDENTIALS)).rejects.toThrow("Bitwarden stayed locked");
    allowSession = true;
    await expect(broken.refresh(CREDENTIALS)).rejects.toThrow("Bitwarden could not be read");
    expect((await broken.refresh()).error).toContain("Bitwarden could not be read");

    let listAttempts = 0;
    const silentRelock = new BitwardenLogins({
      credentials: () => CREDENTIALS,
      run: async (args) => {
        if (args[0] === "status") return { code: 0, stdout: JSON.stringify({ status: "unlocked", userEmail: "bot@acme.test" }), stderr: "", timedOut: false };
        if (args[0] === "unlock") return { code: 0, stdout: `fake-session-${listAttempts}`, stderr: "", timedOut: false };
        if (args[0] === "sync") return { code: 0, stdout: "Syncing complete.", stderr: "", timedOut: false };
        if (args[0] === "list") {
          listAttempts++;
          if (listAttempts === 1) return { code: 0, stdout: "", stderr: "? Master password: [input is hidden]\n", timedOut: false };
          return { code: 0, stdout: JSON.stringify(ITEMS), stderr: "", timedOut: false };
        }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    expect(await silentRelock.refresh()).toEqual({ connected: true, server: "vault.bitwarden.com", account: "bot@acme.test", items: 3 });
    expect(listAttempts).toBe(2);

    let releaseList!: () => void;
    let onList!: () => void;
    const listStarted = new Promise<void>((resolve) => { onList = resolve; });
    const gate = new Promise<void>((resolve) => { releaseList = resolve; });
    let savedConn: typeof CREDENTIALS | null = CREDENTIALS;
    const racing = new BitwardenLogins({
      credentials: () => savedConn,
      run: async (args) => {
        if (args[0] === "status") return { code: 0, stdout: JSON.stringify({ status: "unlocked", userEmail: "bot@acme.test" }), stderr: "", timedOut: false };
        if (args[0] === "unlock") return { code: 0, stdout: "fake-session", stderr: "", timedOut: false };
        if (args[0] === "sync") return { code: 0, stdout: "Syncing complete.", stderr: "", timedOut: false };
        if (args[0] === "list") { onList(); await gate; return { code: 0, stdout: JSON.stringify(ITEMS), stderr: "", timedOut: false }; }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    const pending = racing.refresh();
    await listStarted;
    savedConn = null;
    await racing.disconnect();
    releaseList();
    await pending;
    expect(racing.items()).toEqual([]);
    expect(racing.status()).toEqual({ connected: false });
    savedConn = CREDENTIALS;
    expect(racing.items()).toEqual([]);

    let unlockCalls = 0;
    let statusUnlocked = false;
    const unpoisoned = new BitwardenLogins({
      credentials: () => CREDENTIALS,
      run: async (args) => {
        if (args[0] === "status") return { code: 0, stdout: JSON.stringify({ status: statusUnlocked ? "unlocked" : "locked", userEmail: "bot@acme.test" }), stderr: "", timedOut: false };
        if (args[0] === "unlock") { unlockCalls++; return { code: 0, stdout: `fake-session-${unlockCalls}`, stderr: "", timedOut: false }; }
        if (args[0] === "sync") return { code: 0, stdout: "Syncing complete.", stderr: "", timedOut: false };
        if (args[0] === "list") return { code: 0, stdout: JSON.stringify(ITEMS), stderr: "", timedOut: false };
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    expect((await unpoisoned.refresh()).error).toContain("Bitwarden stayed locked");
    expect(unlockCalls).toBe(1);
    statusUnlocked = true;
    expect(await unpoisoned.refresh()).toEqual({ connected: true, server: "vault.bitwarden.com", account: "bot@acme.test", items: 3 });
    expect(unlockCalls).toBe(2);

    let releaseSync!: () => void;
    let onSync!: () => void;
    const syncStarted = new Promise<void>((resolve) => { onSync = resolve; });
    const syncGate = new Promise<void>((resolve) => { releaseSync = resolve; });
    const postSyncCalls: string[] = [];
    let syncSaved: typeof CREDENTIALS | null = CREDENTIALS;
    const syncRacing = new BitwardenLogins({
      credentials: () => syncSaved,
      run: async (args) => {
        if (args[0] === "status") return { code: 0, stdout: JSON.stringify({ status: "unlocked", userEmail: "bot@acme.test" }), stderr: "", timedOut: false };
        if (args[0] === "unlock") { postSyncCalls.push("unlock"); return { code: 0, stdout: "fake-session", stderr: "", timedOut: false }; }
        if (args[0] === "sync") { onSync(); await syncGate; return { code: 0, stdout: "Syncing complete.", stderr: "", timedOut: false }; }
        if (args[0] === "list") { postSyncCalls.push("list"); return { code: 0, stdout: JSON.stringify(ITEMS), stderr: "", timedOut: false }; }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    const pendingSync = syncRacing.refresh();
    await syncStarted;
    syncSaved = null;
    await syncRacing.disconnect();
    postSyncCalls.length = 0;
    releaseSync();
    await pendingSync;
    expect(postSyncCalls).toEqual([]);
    expect(syncRacing.items()).toEqual([]);
    expect(syncRacing.status()).toEqual({ connected: false });

    let releaseCandList!: () => void;
    let blockCandList = true;
    let onCandList!: () => void;
    const candStarted = new Promise<void>((resolve) => { onCandList = resolve; });
    const candGate = new Promise<void>((resolve) => { releaseCandList = resolve; });
    let candCreds: typeof CREDENTIALS | null = CREDENTIALS;
    const candVault = new BitwardenLogins({
      credentials: () => candCreds,
      run: async (args) => {
        if (args[0] === "status") return { code: 0, stdout: JSON.stringify({ status: "unlocked", userEmail: "bot@acme.test" }), stderr: "", timedOut: false };
        if (args[0] === "unlock") return { code: 0, stdout: "fake-session", stderr: "", timedOut: false };
        if (args[0] === "sync") return { code: 0, stdout: "Syncing complete.", stderr: "", timedOut: false };
        if (args[0] === "list") {
          if (blockCandList) { blockCandList = false; onCandList(); await candGate; }
          return { code: 0, stdout: JSON.stringify(ITEMS), stderr: "", timedOut: false };
        }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    const pendingCand = candVault.refresh(CREDENTIALS);
    await candStarted;
    candCreds = null;
    await candVault.disconnect();
    releaseCandList();
    await expect(pendingCand).rejects.toThrow("Bitwarden could not be read");
    expect(candVault.items()).toEqual([]);
    expect(candVault.status()).toEqual({ connected: false });

    let releaseFirst!: () => void;
    let firstList = true;
    let onFirstList!: () => void;
    const firstStarted = new Promise<void>((resolve) => { onFirstList = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const otherCreds = { ...CREDENTIALS, clientId: "user.other" };
    candCreds = otherCreds;
    const replaceVault = new BitwardenLogins({
      credentials: () => candCreds,
      run: async (args) => {
        if (args[0] === "status") return { code: 0, stdout: JSON.stringify({ status: "unlocked", userEmail: "other@acme.test" }), stderr: "", timedOut: false };
        if (args[0] === "unlock") return { code: 0, stdout: "fake-session-2", stderr: "", timedOut: false };
        if (args[0] === "sync") return { code: 0, stdout: "Syncing complete.", stderr: "", timedOut: false };
        if (args[0] === "list") {
          if (firstList) { firstList = false; onFirstList(); await firstGate; }
          return { code: 0, stdout: JSON.stringify(ITEMS), stderr: "", timedOut: false };
        }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    const pendingOld = replaceVault.refresh(CREDENTIALS);
    await firstStarted;
    expect(await replaceVault.refresh(otherCreds)).toEqual({ connected: true, server: "vault.bitwarden.com", account: "other@acme.test", items: 3 });
    releaseFirst();
    await expect(pendingOld).rejects.toThrow("Bitwarden could not be read");
    expect(replaceVault.status()).toEqual({ connected: true, server: "vault.bitwarden.com", account: "other@acme.test", items: 3 });

    const candidate = { ...CREDENTIALS, clientId: "user.bad-candidate", password: "bad-candidate-password" };
    let releaseCandUnlock!: () => void;
    let onCandUnlock!: () => void;
    const candUnlockStarted = new Promise<void>((resolve) => { onCandUnlock = resolve; });
    const candUnlockGate = new Promise<void>((resolve) => { releaseCandUnlock = resolve; });
    let activeCli = "bot";
    let overlapCalls = 0;
    const isolated = new BitwardenLogins({
      credentials: () => CREDENTIALS,
      run: async (args, env) => {
        if (args[0] === "logout") { activeCli = "none"; return { code: 0, stdout: "", stderr: "", timedOut: false }; }
        if (args[0] === "login") { activeCli = env?.BW_CLIENTID === candidate.clientId ? "candidate" : "bot"; return { code: 0, stdout: "", stderr: "", timedOut: false }; }
        if (args[0] === "status") {
          const email = activeCli === "candidate" ? "candidate@acme.test" : "bot@acme.test";
          return { code: 0, stdout: JSON.stringify({ status: activeCli === "none" ? "unauthenticated" : "unlocked", userEmail: email }), stderr: "", timedOut: false };
        }
        if (args[0] === "unlock") {
          if (env?.BW_PASSWORD === candidate.password) { onCandUnlock(); await candUnlockGate; return { code: 0, stdout: "fake-cand-session", stderr: "", timedOut: false }; }
          return { code: 0, stdout: "fake-bot-session", stderr: "", timedOut: false };
        }
        if (args[0] === "sync") return { code: 0, stdout: "Syncing complete.", stderr: "", timedOut: false };
        if (args[0] === "list") {
          if (env?.BW_SESSION === "fake-cand-session") return { code: 0, stdout: JSON.stringify({ unexpected: true }), stderr: "", timedOut: false };
          if (activeCli === "candidate") overlapCalls++;
          return { code: 0, stdout: JSON.stringify(ITEMS), stderr: "", timedOut: false };
        }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    expect(await isolated.refresh()).toEqual({ connected: true, server: "vault.bitwarden.com", account: "bot@acme.test", items: 3 });
    const loginId = isolated.items().find((entry) => entry.kind === "login")!.id;
    const failingCandidate = isolated.refresh(candidate);
    await candUnlockStarted;
    expect(await isolated.refresh()).toEqual({ connected: true, server: "vault.bitwarden.com", account: "bot@acme.test", items: 3 });
    await expect(isolated.read(loginId)).rejects.toThrow("Bitwarden could not be read");
    expect(overlapCalls).toBe(0);
    releaseCandUnlock();
    await expect(failingCandidate).rejects.toThrow("Bitwarden could not be read");
    expect(isolated.status()).toEqual({ connected: true, server: "vault.bitwarden.com", account: "bot@acme.test", items: 3 });
    expect(await isolated.refresh()).toEqual({ connected: true, server: "vault.bitwarden.com", account: "bot@acme.test", items: 3 });
  });

  it("keeps first connect alive across concurrent !credentials refresh, rejects connects during disconnect, rejects malformed entries, preserves newer session on stale catch, and respects duplicate names past MAX_ITEMS", async () => {
    // (a) Refresh with !credentials while first candidate connect is pending must not clear/invalidate it.
    let savedFirst: typeof CREDENTIALS | null = null;
    let releaseFirstList!: () => void;
    let onFirstList!: () => void;
    const firstListStarted = new Promise<void>((resolve) => { onFirstList = resolve; });
    const firstListGate = new Promise<void>((resolve) => { releaseFirstList = resolve; });
    const firstVault = new BitwardenLogins({
      credentials: () => savedFirst,
      run: async (args) => {
        if (args[0] === "status") return { code: 0, stdout: JSON.stringify({ status: "unlocked", userEmail: "bot@acme.test" }), stderr: "", timedOut: false };
        if (args[0] === "unlock") return { code: 0, stdout: "fake-first-session", stderr: "", timedOut: false };
        if (args[0] === "sync") return { code: 0, stdout: "Syncing complete.", stderr: "", timedOut: false };
        if (args[0] === "list") { onFirstList(); await firstListGate; return { code: 0, stdout: JSON.stringify(ITEMS), stderr: "", timedOut: false }; }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    const firstConnect = firstVault.refresh(CREDENTIALS);
    await firstListStarted;
    expect(await firstVault.refresh()).toEqual({ connected: false });
    savedFirst = CREDENTIALS;
    releaseFirstList();
    expect(await firstConnect).toEqual({ connected: true, server: "vault.bitwarden.com", account: "bot@acme.test", items: 3 });

    // (b) Candidate connect during pending disconnect rejects before running CLI work.
    let releaseLogout!: () => void;
    let onLogout!: () => void;
    const logoutStarted = new Promise<void>((resolve) => { onLogout = resolve; });
    const logoutGate = new Promise<void>((resolve) => { releaseLogout = resolve; });
    const callsAfterLogout: string[] = [];
    let gateLogout = false;
    let loggedOut = false;
    const discVault = new BitwardenLogins({
      credentials: () => CREDENTIALS,
      run: async (args) => {
        if (loggedOut) callsAfterLogout.push(args[0]!);
        if (args[0] === "logout") {
          if (gateLogout) { loggedOut = true; onLogout(); await logoutGate; }
          return { code: 0, stdout: "", stderr: "", timedOut: false };
        }
        if (args[0] === "status") return { code: 0, stdout: JSON.stringify({ status: "unlocked", userEmail: "bot@acme.test" }), stderr: "", timedOut: false };
        if (args[0] === "unlock") return { code: 0, stdout: "fake-session", stderr: "", timedOut: false };
        if (args[0] === "sync") return { code: 0, stdout: "Syncing complete.", stderr: "", timedOut: false };
        if (args[0] === "list") return { code: 0, stdout: JSON.stringify(ITEMS), stderr: "", timedOut: false };
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    await discVault.refresh(CREDENTIALS);
    gateLogout = true;
    const pendingDisc = discVault.disconnect();
    await logoutStarted;
    await expect(discVault.refresh(CREDENTIALS)).rejects.toThrow("Bitwarden could not be read");
    expect(callsAfterLogout).toEqual([]);
    releaseLogout();
    await pendingDisc;

    // (c) Stale failed reconnect does not clear newer valid session with identical credentials key.
    let listNum = 0;
    let unlocks = 0;
    let releaseStaleFail!: () => void;
    let onStaleList!: () => void;
    const staleListStarted = new Promise<void>((resolve) => { onStaleList = resolve; });
    const staleFailGate = new Promise<void>((resolve) => { releaseStaleFail = resolve; });
    const staleCatchVault = new BitwardenLogins({
      credentials: () => CREDENTIALS,
      run: async (args) => {
        if (args[0] === "logout") return { code: 0, stdout: "", stderr: "", timedOut: false };
        if (args[0] === "status") return { code: 0, stdout: JSON.stringify({ status: "unlocked", userEmail: "bot@acme.test" }), stderr: "", timedOut: false };
        if (args[0] === "unlock") { unlocks++; return { code: 0, stdout: `sess-${unlocks}`, stderr: "", timedOut: false }; }
        if (args[0] === "sync") return { code: 0, stdout: "Syncing complete.", stderr: "", timedOut: false };
        if (args[0] === "list") {
          listNum++;
          if (listNum === 1) { onStaleList(); await staleFailGate; return { code: 1, stdout: "", stderr: "transient fail", timedOut: false }; }
          return { code: 0, stdout: JSON.stringify(ITEMS), stderr: "", timedOut: false };
        }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    const staleAttempt = staleCatchVault.refresh(CREDENTIALS);
    await staleListStarted;
    expect(await staleCatchVault.refresh(CREDENTIALS)).toEqual({ connected: true, server: "vault.bitwarden.com", account: "bot@acme.test", items: 3 });
    releaseStaleFail();
    await expect(staleAttempt).rejects.toThrow("Bitwarden could not be read");
    expect(await staleCatchVault.refresh()).toEqual({ connected: true, server: "vault.bitwarden.com", account: "bot@acme.test", items: 3 });
    expect(unlocks).toBe(2);

    // (d) Malformed array records like [null, {}] reject as unreadable instead of healthy-empty.
    const malformed = new BitwardenLogins({
      credentials: () => CREDENTIALS,
      run: async (args) => {
        if (args[0] === "status") return { code: 0, stdout: JSON.stringify({ status: "unlocked", userEmail: "bot@acme.test" }), stderr: "", timedOut: false };
        if (args[0] === "unlock") return { code: 0, stdout: "fake-session", stderr: "", timedOut: false };
        if (args[0] === "sync") return { code: 0, stdout: "Syncing complete.", stderr: "", timedOut: false };
        if (args[0] === "list") return { code: 0, stdout: JSON.stringify([null, {}]), stderr: "", timedOut: false };
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    await expect(malformed.refresh(CREDENTIALS)).rejects.toThrow("Bitwarden could not be read");
    expect((await malformed.refresh()).error).toContain("Bitwarden could not be read");

    // (e) Display cap ordering never retargets bw://<name> to the remaining item when an evicted duplicate exists.
    const capFiller: FakeBwItem[] = Array.from({ length: 1005 }, (_, i) => ({
      id: `i-cap-${i}`, name: `Cap ${i}`, type: 1 as const, login: { password: "fake-cap-password" },
    }));
    const dupItems: FakeBwItem[] = [
      ...capFiller,
      { id: "i-deploy-other", name: "Deploy", type: 1, login: { password: "other-deploy-password" } },
      { id: "i-deploy-web", name: "Deploy", type: 1, login: { uris: [{ uri: "https://deploy.example.test" }], password: "web-deploy-password" } },
    ];
    const dupFake = fakeBw({ ...CREDENTIALS, email: "bot@acme.test", items: dupItems });
    const dupVault = new BitwardenLogins({ credentials: () => CREDENTIALS, run: dupFake.run });
    await dupVault.refresh(CREDENTIALS);
    expect(findLinkedSecret([dupVault], "bw://Deploy/password", "pepper")).toBeNull();
    expect(await readLinkedSecret(findLinkedSecret([dupVault], "bw://i-deploy-web/password", "pepper")!)).toBe("web-deploy-password");
  });
});
