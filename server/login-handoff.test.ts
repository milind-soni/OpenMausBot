import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loginFingerprints } from "./cloud-send-verify.ts";
import { LOGIN_HANDOFF_REQUEST, LOGIN_HANDOFF_RESULT, ONE_PASSWORD_DEAD_HERE, receiveLoginHandoff, totpAddress, type ConnectionHandoffAnswer, type LoginHandoffResult } from "./login-handoff.ts";
import { LoginStore } from "./login-store.ts";
import { ONE_PASSWORD_MALFORMED, ONE_PASSWORD_REFUSED } from "./onepassword.ts";
import { parseTotpKey } from "./totp.ts";

// Obvious fakes only.
const PASSWORD = "fake-handoff-Passw0rd";
const TOKEN = "ops_fake-handoff-token";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(onePasswordProblem?: () => string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "omb-login-handoff-"));
  dirs.push(dir);
  const store = new LoginStore({ dataDir: dir });
  const posted: LoginHandoffResult[] = [];
  const ask = (message: unknown) => receiveLoginHandoff(message, store, (reply) => { posted.push(reply); return true; }, onePasswordProblem);
  return { store, posted, ask };
}

describe("the private login handoff to the desktop's main process", () => {
  it("hands one saved login as the Cloud's own Logins route takes it, its 2FA key as an address that parses back the same", () => {
    const { store, posted, ask } = setup();
    const totp = parseTotpKey("otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=8&period=60")!;
    const login = store.create({ site: "example.com", hosts: ["accounts.example.com", "login.example.com"], exactHost: true, username: "alice", password: PASSWORD, totp, source: "settings", bots: ["pepper"] });
    expect(ask({ type: LOGIN_HANDOFF_REQUEST, requestId: "request-0001", what: { kind: "login", id: login.id } })).toBe(true);
    expect(posted).toEqual([{ type: LOGIN_HANDOFF_RESULT, requestId: "request-0001", ok: true,
      login: { site: "accounts.example.com", exactHost: true, username: "alice", password: PASSWORD, totp: totpAddress(totp), bots: ["pepper"] } }]);
    expect(parseTotpKey((posted[0] as { login: { totp: string } }).login.totp)).toEqual(totp);
  });

  it("hands the 1Password token with its vaults' bots, and says plainly when there is nothing to hand", () => {
    const { store, posted, ask } = setup();
    ask({ type: LOGIN_HANDOFF_REQUEST, requestId: "request-0002", what: { kind: "1password" } });
    store.setOnePasswordToken(TOKEN);
    store.setOnePasswordGrant("v1", ["pepper"]);
    ask({ type: LOGIN_HANDOFF_REQUEST, requestId: "request-0003", what: { kind: "1password" } });
    ask({ type: LOGIN_HANDOFF_REQUEST, requestId: "request-0004", what: { kind: "login", id: "gone" } });
    expect(posted).toEqual([
      { type: LOGIN_HANDOFF_RESULT, requestId: "request-0002", ok: false, error: "1Password is not connected on this computer." },
      { type: LOGIN_HANDOFF_RESULT, requestId: "request-0003", ok: true, onePassword: { token: TOKEN, grants: { v1: ["pepper"] } } },
      { type: LOGIN_HANDOFF_RESULT, requestId: "request-0004", ok: false, error: "This login is no longer saved on this computer." },
    ]);
  });

  it("does not hand over a 1Password token that 1Password refused on this computer, and says how to fix it here", () => {
    let problem: string | undefined = ONE_PASSWORD_REFUSED;
    const { store, posted, ask } = setup(() => problem);
    store.setOnePasswordToken(TOKEN);
    ask({ type: LOGIN_HANDOFF_REQUEST, requestId: "request-0101", what: { kind: "1password" } });
    problem = ONE_PASSWORD_MALFORMED;
    ask({ type: LOGIN_HANDOFF_REQUEST, requestId: "request-0102", what: { kind: "1password" } });
    // Not reaching 1Password says nothing about the token: My Cloud checks it for itself.
    problem = "Could not reach 1Password. Check the internet connection and try again.";
    ask({ type: LOGIN_HANDOFF_REQUEST, requestId: "request-0103", what: { kind: "1password" } });
    expect(posted).toEqual([
      { type: LOGIN_HANDOFF_RESULT, requestId: "request-0101", ok: false, error: ONE_PASSWORD_DEAD_HERE },
      { type: LOGIN_HANDOFF_RESULT, requestId: "request-0102", ok: false, error: ONE_PASSWORD_DEAD_HERE },
      { type: LOGIN_HANDOFF_RESULT, requestId: "request-0103", ok: true, onePassword: { token: TOKEN, grants: {} } },
    ]);
    expect(JSON.stringify(posted.slice(0, 2))).not.toContain(TOKEN);
  });

  it("answers nothing to a malformed ask, and leaves every other private message to its own handler", () => {
    const { store, posted, ask } = setup();
    store.setOnePasswordToken(TOKEN);
    for (const malformed of [
      { type: LOGIN_HANDOFF_REQUEST, requestId: "x", what: { kind: "1password" } },
      { type: LOGIN_HANDOFF_REQUEST, requestId: "request-0005", what: { kind: "everything" } },
      { type: LOGIN_HANDOFF_REQUEST, requestId: "request-0006", what: { kind: "login", id: "../../etc" } },
      { type: LOGIN_HANDOFF_REQUEST, requestId: "request-0007" },
    ]) expect(ask(malformed)).toBe(true);
    expect(posted).toEqual([]);
    for (const other of [null, "text", [], { type: "openmausbot:phone-secret-save-result" }, { type: LOGIN_HANDOFF_RESULT, requestId: "request-0008" }]) expect(ask(other)).toBe(false);
  });
});

describe("the private ask for credential fingerprints, which checks what a move carried", () => {
  it("answers each login's and every connection's fingerprint under main's nonce, and refuses when the connections could not be read", async () => {
    const { store, posted } = setup();
    store.create({ site: "example.com", hosts: ["example.com"], exactHost: false, username: "alice", password: PASSWORD, source: "settings", bots: "all" });
    const nonce = "z".repeat(43);
    let connections: (what: unknown) => Promise<ConnectionHandoffAnswer> = async () => ({ ok: true, secrets: { "key:openrouter": "k".repeat(64) } });
    const post = (reply: LoginHandoffResult) => { posted.push(reply); return true; };
    receiveLoginHandoff({ type: LOGIN_HANDOFF_REQUEST, requestId: "request-0201", what: { kind: "verify-secrets", nonce } }, store, post, undefined, (what) => connections(what));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ type: LOGIN_HANDOFF_RESULT, requestId: "request-0201", ok: true, secrets: { ...loginFingerprints(nonce, store), "key:openrouter": "k".repeat(64) } });
    expect(JSON.stringify(posted)).not.toContain(PASSWORD);
    connections = async () => { throw new Error("no"); };
    receiveLoginHandoff({ type: LOGIN_HANDOFF_REQUEST, requestId: "request-0202", what: { kind: "verify-secrets", nonce } }, store, post, undefined, (what) => connections(what));
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({ type: LOGIN_HANDOFF_RESULT, requestId: "request-0202", ok: false, error: "This computer's apps and keys could not be checked." });
    receiveLoginHandoff({ type: LOGIN_HANDOFF_REQUEST, requestId: "request-0203", what: { kind: "verify-secrets", nonce: "short" } }, store, post, undefined,
      async () => ({ ok: true, secrets: {} }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posted, "a nonce too short to keep fingerprints apart is not answered").toHaveLength(2);
  });
});
