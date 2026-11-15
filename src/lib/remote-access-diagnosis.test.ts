import { describe, expect, it } from "vitest";

import { diagnoseRemoteAccess, remoteAccessDiagnosisText, type RemoteAccessFacts } from "./remote-access-diagnosis";

type Companion = NonNullable<RemoteAccessFacts["companion"]>;
type Account = NonNullable<RemoteAccessFacts["account"]>;

const route = (on: boolean, name?: string) => ({ on, since: on ? 1 : null, ...(name ? { name } : {}) });

const companion = (overrides: Partial<Companion> = {}): Companion => ({
  enabled: true,
  port: 8810,
  devices: [],
  routes: { wifi: route(true), relay: route(true), tailscale: route(false), https: route(false) },
  endpoints: [{ url: "http://192.168.1.23:8810", kind: "lan", priority: 0 }],
  e2e: { enabled: true, relay: "connected", node: "relay1.openmausbot.com", relayProblem: null, descriptor: null },
  relayToken: { state: "ready", code: null },
  ...overrides,
});

const signedIn: Account = { available: true, status: "ready" };

const results = (facts: RemoteAccessFacts) => Object.fromEntries(diagnoseRemoteAccess(facts).steps.map((step) => [step.id, step.result]));

describe("the remote access diagnosis", () => {
  it("passes every step when the relay confirmed this computer", () => {
    const diagnosis = diagnoseRemoteAccess({ account: signedIn, companion: companion() });
    expect(results({ account: signedIn, companion: companion() })).toEqual({ computer: "ok", account: "ok", relay: "ok", route: "ok" });
    expect(diagnosis.failed).toBe(false);
    expect(diagnosis.headline).toBe("Your phone can reach this computer from anywhere.");
    expect(diagnosis.steps.map((step) => step.label)).toEqual(["This computer", "MausBot account", "MausBot Relay", "Your phone's way in"]);
  });

  it("stops at this computer when the phone link is off, and checks nothing after it", () => {
    const diagnosis = diagnoseRemoteAccess({ account: signedIn, companion: companion({ enabled: false }) });
    expect(diagnosis.steps.map((step) => step.result)).toEqual(["failed", "unchecked", "unchecked", "unchecked"]);
    expect(diagnosis.headline).toBe("The phone link is off.");
    expect(diagnosis.next).toEqual(["Turn on Same Wi-Fi or Anywhere, through MausBot."]);
  });

  it("names the account when MausBot can't be reached, and still finds Same Wi-Fi working", () => {
    const facts = { account: { available: false, status: "signed-out" as const, problem: "unreachable" as const }, companion: companion({ e2e: { enabled: false, relay: "off", node: null, descriptor: null }, relayToken: { state: "failed", code: "unreachable" } }) };
    const diagnosis = diagnoseRemoteAccess(facts);
    expect(results(facts)).toEqual({ computer: "ok", account: "failed", relay: "unchecked", route: "ok" });
    expect(diagnosis.headline).toBe("This computer can't reach MausBot right now.");
    expect(diagnosis.next[0]).toMatch(/internet connection/);
    expect(diagnosis.steps[2].reason).toBe("Needs the MausBot account first.");
  });

  it("asks to sign in when signed out, or when the relay refused this computer's sign-in", () => {
    expect(diagnoseRemoteAccess({ account: { available: true, status: "signed-out" }, companion: companion() }).headline).toBe("Not signed in.");
    const refused = diagnoseRemoteAccess({ account: signedIn, companion: companion({ relayToken: { state: "waiting", code: "sign_in" }, e2e: { enabled: true, relay: "off", node: null, descriptor: null } }) });
    expect(refused.headline).toBe("This computer's sign-in was not accepted.");
    expect(refused.next).toEqual(["MausBot asks again on its own within the hour, or as soon as you pair a phone."]);
  });

  it("maps the account's control-plane codes to plain reasons", () => {
    const reason = (problem: Account["problem"]) => diagnoseRemoteAccess({ account: { available: true, status: "error", problem }, companion: companion() }).headline;
    expect(reason("sign_in")).toBe("Your sign-in expired.");
    expect(reason("busy")).toBe("MausBot is busy right now.");
    expect(reason("limit")).toBe("This account has reached its computer limit.");
    expect(reason("update")).toBe("This version of MausBot is too old to connect.");
    expect(reason("failed")).toBe("Signing in didn't finish.");
  });

  it("names the relay when it is off for this computer, busy, silent, or taken over", () => {
    const relayFailure = (overrides: Partial<Companion>) => diagnoseRemoteAccess({ account: signedIn, companion: companion(overrides) });
    const off = { enabled: true, relay: "connecting" as const, node: null, descriptor: null };
    expect(relayFailure({ relayToken: { state: "failed", code: "unavailable" }, e2e: { ...off, relay: "off" } }).headline).toBe("MausBot Relay isn't available for this computer right now.");
    expect(relayFailure({ relayToken: { state: "failed", code: "busy" }, e2e: { ...off, relay: "off" } }).headline).toBe("MausBot Relay is busy.");
    const silent = relayFailure({ e2e: { ...off, relayProblem: "no_answer" } });
    expect(silent.headline).toBe("MausBot Relay didn't answer.");
    expect(silent.next).toHaveLength(2);
    expect(relayFailure({ e2e: { ...off, relayProblem: "unreachable" } }).headline).toBe("This computer can't reach MausBot Relay.");
    expect(relayFailure({ e2e: { ...off, relayProblem: "busy" } }).headline).toBe("MausBot Relay is busy.");
    expect(relayFailure({ e2e: { ...off, relay: "off", relayProblem: "replaced" } }).headline).toBe("Another copy of MausBot took over this computer's relay connection.");
  });

  it("reads a relay still connecting, or renewing its access, as not checked rather than failed", () => {
    for (const relayProblem of [null, "token_refused"] as const) {
      const facts = { account: signedIn, companion: companion({ e2e: { enabled: true, relay: "connecting", node: null, relayProblem, descriptor: null } }) };
      expect(results(facts).relay).toBe("unchecked");
      expect(diagnoseRemoteAccess(facts).failed).toBe(false);
      expect(diagnoseRemoteAccess(facts).headline).toBe("Your phone can reach this computer on the same Wi-Fi.");
    }
  });

  it("does not treat Anywhere being off as a failure", () => {
    const facts = { account: signedIn, companion: companion({ routes: { wifi: route(true), relay: route(false), tailscale: route(false), https: route(false) } }) };
    expect(results(facts)).toEqual({ computer: "ok", account: "unchecked", relay: "unchecked", route: "ok" });
    expect(diagnoseRemoteAccess(facts).steps[2].reason).toBe("Not used: Anywhere is off.");
  });

  it("does not ask a person using only Same Wi-Fi or Tailscale to sign in, unless pairing asks for the account", () => {
    const wifiOnly = companion({ routes: { wifi: route(true), relay: route(false), tailscale: route(true, "mac.tailnet.ts.net"), https: route(false) } });
    for (const account of [{ available: true, status: "signed-out" as const }, { available: false, status: "signed-out" as const, problem: "unreachable" as const }]) {
      const diagnosis = diagnoseRemoteAccess({ account, companion: wifiOnly });
      expect(diagnosis.steps[1]).toMatchObject({ result: "unchecked", reason: "Not needed for Same Wi-Fi or Tailscale." });
      expect(diagnosis.failed).toBe(false);
      expect(diagnosis.headline).toBe("Your phone can reach this computer on the same Wi-Fi.");
    }
    const pairing = diagnoseRemoteAccess({ account: { available: true, status: "signed-out" }, companion: wifiOnly, accountWanted: true });
    expect(pairing.headline).toBe("Not signed in.");
  });

  it("reads a build with no control plane as not set up, not as a failure", () => {
    const diagnosis = diagnoseRemoteAccess({ account: { available: false, status: "signed-out", problem: "unconfigured" }, companion: companion({ e2e: { enabled: false, relay: "off", node: null, descriptor: null }, relayToken: { state: "off", code: null } }), accountWanted: true });
    expect(diagnosis.steps[1]).toMatchObject({ result: "unchecked", reason: "Not set up in this build of MausBot." });
    expect(diagnosis.failed).toBe(false);
    expect(remoteAccessDiagnosisText(diagnosis)).toContain("account: unavailable (unconfigured)");
  });

  it("reads a relay idle by design, with no phone needing it, as not checked", () => {
    const facts = { account: signedIn, companion: companion({ e2e: { enabled: true, relay: "off", node: null, relayProblem: null, descriptor: null }, relayToken: { state: "off", code: null } }) };
    expect(diagnoseRemoteAccess(facts).steps[2]).toMatchObject({ result: "unchecked", reason: "Starts when a phone needs it." });
    expect(diagnoseRemoteAccess(facts).failed).toBe(false);
  });

  it("keeps a connected relay ok while MausBot's service can't be reached", () => {
    const facts = { account: { available: false, status: "error" as const, problem: "unreachable" as const }, companion: companion() };
    expect(results(facts)).toEqual({ computer: "ok", account: "failed", relay: "ok", route: "ok" });
  });

  it("names the phone's way in when Wi-Fi has no address, nothing is on, or only a failing HTTPS address is", () => {
    const routes = (wifi: boolean, relay: boolean, https = false) => ({ wifi: route(wifi), relay: route(relay), tailscale: route(false), https: route(https) });
    const noAddress = { endpoints: [], routes: routes(true, false) };
    expect(diagnoseRemoteAccess({ account: signedIn, companion: companion(noAddress) }).headline).toBe("This computer isn't on a Wi-Fi network.");
    expect(diagnoseRemoteAccess({ account: signedIn, companion: companion({ routes: routes(false, false) }) }).headline).toBe("No way in is on.");
    const https = diagnoseRemoteAccess({ account: { available: true, status: "error", problem: "address" }, companion: companion({ endpoints: [], routes: routes(false, false, true) }) });
    expect(https.steps.map((step) => step.result)).toEqual(["ok", "ok", "unchecked", "failed"]);
    expect(https.headline).toBe("The HTTPS address isn't working.");
    const tailnet = { account: signedIn, companion: companion({ endpoints: [], routes: { wifi: route(false), relay: route(false), tailscale: route(true, "mac.tailnet.ts.net"), https: route(false) } }) };
    expect(results(tailnet).route).toBe("ok");
  });

  it("copies the steps, what to try and the facts as one block", () => {
    const diagnosis = diagnoseRemoteAccess({ account: signedIn, companion: companion({ e2e: { enabled: true, relay: "connecting", node: null, relayProblem: "no_answer", descriptor: null } }), setupTimedOut: true, appVersion: "0.1.158" });
    const text = remoteAccessDiagnosisText(diagnosis);
    expect(text.split("\n")[0]).toBe("MausBot remote access: MausBot Relay didn't answer.");
    expect(text).toContain("MausBot Relay: failed · MausBot Relay didn't answer.");
    expect(text).toContain("This computer: ok · The phone link is on.");
    expect(text).toContain("- A VPN or firewall on this computer can block MausBot Relay.");
    expect(text).toContain("app: 0.1.158");
    expect(text).toContain("relay: connecting (no_answer)");
    expect(text).toContain("ways_on: wifi,relay");
    expect(text).toContain("setup: timed_out");
  });

  it("never copies an email, address, hostname, IP, pairing code, token, key or device name", () => {
    const secrets = [
      "person@example.com", "c-0123abcd", "mausbot.si", "192.168.1.23", "100.64.0.9", "mac.tailnet.ts.net", "mac.local",
      "482913", "pairtoken_secret", "PUBKEY_secret", "hhash_secret", "eyJ2IjoxfQ", "omb_install_secret", "req_8f3a",
      "device-secret-id", "Ana's iPhone", "Bearer", "relay9.example.com", "openmausbot.com",
    ];
    const account = {
      available: true, status: "error", email: "person@example.com", endpoint: "https://c-0123abcd.mausbot.si",
      message: "Could not finish. Reference: req_8f3a.", problem: "Bearer omb_install_secret",
    } as unknown as Account;
    const leaky = {
      ...companion(),
      addresses: ["192.168.1.23", "100.64.0.9"], lan: "192.168.1.23", tailscale: "100.64.0.9", tailnetName: "mac.tailnet.ts.net",
      hosts: ["mac.local", "mac.tailnet.ts.net"], discovery: { advertising: true, name: "mac.local" },
      endpoints: [
        { url: "http://192.168.1.23:8810", kind: "lan", priority: 0 },
        { url: "https://c-0123abcd.mausbot.si", kind: "hosted", priority: 1 },
        { url: "http://mac.tailnet.ts.net:8810", kind: "tailnet", priority: 2 },
      ],
      routes: { wifi: route(true), relay: route(true), tailscale: route(true, "mac.tailnet.ts.net"), https: route(true) },
      pairing: { code: "482913", token: "pairtoken_secret", expiresAt: 1 },
      devices: [{ id: "device-secret-id", name: "Ana's iPhone", createdAt: 1, lastSeenAt: 1, cloudDesktopAccess: false }],
      e2e: { enabled: true, relay: "connecting", node: "relay9.example.com", relayProblem: "no_answer", descriptor: { v: 1, k: "PUBKEY_secret", h: "hhash_secret", r: ["relay1.openmausbot.com"] } },
      relayToken: { state: "failed", code: "eyJ2IjoxfQ.c2lnbmF0dXJl" },
      error: undefined,
    } as unknown as Companion;
    const variants: RemoteAccessFacts[] = [
      { account, companion: leaky, appVersion: "eyJ2IjoxfQ.c2lnbmF0dXJl" },
      { account: { ...account, available: false }, companion: leaky },
      { account, companion: { ...leaky, e2e: { ...leaky.e2e!, relay: "connected" } } },
      { account, companion: { ...leaky, enabled: false } },
      { account, companion: { ...leaky, error: "Failed to bind 192.168.1.23:8810 for person@example.com" } },
      { account: null, companion: null },
    ];
    for (const facts of variants) {
      const text = remoteAccessDiagnosisText(diagnoseRemoteAccess(facts));
      for (const secret of secrets) expect(text, `${secret} in:\n${text}`).not.toContain(secret);
    }
  });
});
