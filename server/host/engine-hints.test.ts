import { describe, expect, it } from "vitest";

import type { EngineInstall, ProviderSnapshot } from "../contracts.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { DEFAULT_FLEET } from "../instance-fleets.ts";
import { modelMenu, type MenuEngine } from "../routes/internal-models.ts";
import { botPersona } from "../system-prompt.ts";
import { createEngineHints, engineHint, type EngineHint, type EngineHintInput } from "./engine-hints.ts";

const PROVIDERS = "Settings → AI → Providers";
const KEYS = "Settings → AI → Other services";
const notInstalled: ProviderSnapshot = { state: "unavailable", reason: "agy: command not found" };
const signedOut: ProviderSnapshot = { state: "available", authenticated: false };
const driver = (kind: string) => BUILT_IN_DRIVERS.find((one) => one.driverKind === kind)!;
const managed: EngineInstall = { managed: { label: "Antigravity", downloadBytes: 1 } };
const hint = (input: Partial<EngineHintInput>) => engineHint({
  name: "Engine", driverKind: "x", enabled: true, access: undefined, snapshot: undefined, install: undefined, signIn: undefined, ...input,
});

describe("engineHint", () => {
  it("says Google's engine signs in with a Google account, not an API key, whether it is set up yet or only signed out", () => {
    const antigravity = { name: "Google Gemini (Antigravity)", driverKind: "antigravityAgent", access: "subscription" as const,
      account: driver("antigravityAgent").metadata.signInAccount, signIn: { method: "callback-url" } };
    expect(antigravity.account).toBe("Google");
    const fresh = hint({ ...antigravity, snapshot: notInstalled, install: managed });
    expect(fresh).toEqual({ why: "not set up yet",
      connect: `sign in with your Google account in ${PROVIDERS}; a subscription on that account covers it, no API key (the app installs it first)` });
    expect(hint({ ...antigravity, snapshot: signedOut, install: managed })).toEqual({ why: "not signed in",
      connect: `sign in with your Google account in ${PROVIDERS}; a subscription on that account covers it, no API key` });
    // On a platform with no runtime to download it is installed first, then signed in the same way.
    expect(hint({ ...antigravity, snapshot: notInstalled }).connect).toBe(`install it in ${PROVIDERS}, then sign in there with that provider's account (no API key)`);
  });

  it("sends a key-only engine to the key, billed to it, and never claims a plan covers it", () => {
    const mistral = { name: "Mistral (API)", driverKind: "mistral", access: "api" as const, install: driver("mistral").install };
    expect(hint({ ...mistral, snapshot: { state: "unavailable", reason: "No API key" } })).toEqual({ why: "no API key saved",
      connect: `save its API key in ${KEYS} (use is billed to that key)` });
    expect(hint({ ...mistral, snapshot: { state: "available", authenticated: false } }).why).toBe("no working API key saved");
    // Claude's API-key instance once Claude Code is installed, as the card decides it.
    const claudeKey = { name: "Claude (API key)", driverKind: "claudeAgent", access: "api" as const, install: driver("claudeAgent").install };
    expect(hint({ ...claudeKey, snapshot: { state: "available", authenticated: false, version: "2.1.0" } }).connect).toMatch(/^save its API key/u);
    // Before Claude Code is installed the card offers the install; the key still follows, never "no API key".
    expect(hint({ ...claudeKey, signIn: { method: "paste-code" }, snapshot: notInstalled }).connect).toBe(`install it in ${PROVIDERS}, then save its API key in ${KEYS} (use is billed to that key)`);
    expect(hint({ ...claudeKey, signIn: { method: "paste-code" }, snapshot: { state: "available", authenticated: false } }).connect).not.toMatch(/no API key/u);
    // A key engine with its own program is installed first, then given the key.
    expect(hint({ name: "DeepSeek Harness", driverKind: "deepseekAgent", access: "subscription", install: driver("deepseekAgent").install, snapshot: notInstalled }).connect)
      .toBe(`install it in ${PROVIDERS}, then save its API key in ${KEYS} (use is billed to that key)`);
    // A company's key is the company's: no key of the person's own is asked for.
    expect(hint({ ...mistral, managed: true, snapshot: { state: "available", authenticated: false } }).connect).not.toMatch(/API key/u);
  });

  it("names the account and the terminal step of an engine signed in outside the app", () => {
    expect(hint({ name: "Codex", driverKind: "codex", account: "ChatGPT", signIn: { method: "device-code" }, snapshot: signedOut }).connect)
      .toBe(`sign in with your ChatGPT account in ${PROVIDERS}; a subscription on that account covers it, no API key`);
    expect(hint({ name: "Kiro", driverKind: "kiroAgent", install: driver("kiroAgent").install, snapshot: signedOut }).connect)
      .toBe(`run \`kiro-cli login\` in a terminal on the computer the bots run on, or follow ${PROVIDERS}`);
    // Nothing known about how it signs in: no claim either way.
    expect(hint({ name: "Gemini", driverKind: "geminiAgent", access: "subscription", install: driver("geminiAgent").install, snapshot: notInstalled }).connect)
      .toBe(`install it in ${PROVIDERS}; it then shows how it signs in`);
  });

  it("gives each other reason its own line", () => {
    const cases: Array<[Partial<EngineHintInput>, EngineHint]> = [
      [{ enabled: false, snapshot: signedOut }, { why: "turned off", connect: `turn it on in ${PROVIDERS}` }],
      [{ policy: "Acme does not allow the Engine engine on this computer. Choose another model for this bot." },
        { why: "not allowed by the organization", connect: "Acme does not allow the Engine engine on this computer. Choose another model for this bot." }],
      [{ offered: false }, { why: "not offered on this server", connect: "its admin chooses which AIs it offers" }],
      [{ snapshot: { ...notInstalled, installing: true } }, { why: "being installed now", connect: "nothing to do: it is ready in a few minutes" }],
      [{ snapshot: { state: "available", notEngineCli: true } }, { why: "its program path runs another program", connect: `reset the path in ${PROVIDERS}` }],
      [{ snapshot: { state: "unavailable", ollama: { state: "not-running", url: "http://127.0.0.1:11434" } } },
        { why: "its Ollama server is not answering", connect: `start Ollama and pull a model, or change its address in ${PROVIDERS}` }],
      [{ snapshot: { ...signedOut, authenticationUnavailableReason: "Sign-in needs the desktop app." } }, { why: "can't be signed in here", connect: "Sign-in needs the desktop app." }],
      [{ broken: true }, { why: "its saved settings can't be read", connect: `fix or remove it in ${PROVIDERS}` }],
      [{ snapshot: { state: "available", authenticated: true } }, { why: "can't run now", connect: `${PROVIDERS} shows why` }],
      [{ snapshot: { state: "unavailable", version: "1.0.0", reason: "The CLI exited." } }, { why: "can't run now", connect: `${PROVIDERS} shows why` }],
    ];
    for (const [input, expected] of cases) expect(hint(input)).toEqual(expected);
  });

  it("reads an installed engine's own refusal instead of calling it not installed (the drivers' real snapshots)", () => {
    // Codex on a ChatGPT plan where the plan can't sign in (codex.ts): the driver's reason, not "install it".
    const plan = "ChatGPT plan sign-in is not available on this Cloud. Choose a Company model, or use an API key.";
    expect(hint({ name: "ChatGPT plan", driverKind: "codex", account: "ChatGPT", signIn: { method: "browser-pkce" }, install: driver("codex").install,
      snapshot: { state: "unavailable", authenticated: false, chatgptPlan: true, reason: plan, authenticationUnavailableReason: plan } }))
      .toEqual({ why: "can't be signed in here", connect: plan });
    // Muse Code installed, signed out (muse-code.ts).
    expect(hint({ name: "Muse Code", driverKind: "museCode", access: "subscription", install: driver("museCode").install,
      snapshot: { state: "unavailable", reason: "Sign in to Muse Code: run `muse login` in a terminal.", authenticated: false, version: "1.2.0" } }))
      .toEqual({ why: "not signed in", connect: `run \`muse login\` in a terminal on the computer the bots run on, or follow ${PROVIDERS}` });
    // Muse Code not installed (no version) is the install step.
    expect(hint({ name: "Muse Code", driverKind: "museCode", access: "subscription", install: driver("museCode").install,
      snapshot: { state: "unavailable", reason: "Muse Code isn't installed on this computer.", authenticated: false } }).why).toBe("not installed");
    // Claude's API-key instance, Claude Code installed, no key saved (claude.ts).
    expect(hint({ name: "Claude (API key)", driverKind: "claudeAgent", access: "api", account: "Claude", signIn: { method: "paste-code" }, install: driver("claudeAgent").install,
      snapshot: { state: "unavailable", version: "2.1.300", reason: "Add an Anthropic API key." } }))
      .toEqual({ why: "no working API key saved", connect: `save its API key in ${KEYS} (use is billed to that key)` });
  });

  it("says what the app's own sign-in is for engines without a named subscription, and no more (core.ts snapshots)", () => {
    const acpSignedOut: ProviderSnapshot = { state: "available", version: "1.0.0", authenticated: false };
    const lines = Object.fromEntries(["cursorAgent", "kimiAgent", "grokAgent", "mistralVibeAgent"].map((kind) => [kind, hint({
      name: driver(kind).metadata.displayName, driverKind: kind, access: driver(kind).metadata.access, install: driver(kind).install,
      signIn: { method: kind === "mistralVibeAgent" ? "browser" : "device-code" }, snapshot: acpSignedOut,
    })]));
    expect(lines).toEqual({
      cursorAgent: { why: "not signed in", connect: `sign in with your Cursor account in ${PROVIDERS}; no API key needed` },
      kimiAgent: { why: "not signed in", connect: `sign in with your Kimi account in ${PROVIDERS}; no API key needed` },
      grokAgent: { why: "not signed in", connect: `sign in with your Grok account in ${PROVIDERS}; no API key needed` },
      mistralVibeAgent: { why: "not signed in", connect: `sign in with your Mistral account in ${PROVIDERS}; no API key needed` },
    });
    for (const line of Object.values(lines)) expect(line.connect).not.toMatch(/subscription|plan/u);
  });

  it("leaves no engine without why and how to connect, whatever stops it", () => {
    const snapshots: Array<ProviderSnapshot | undefined> = [undefined, notInstalled, signedOut, { state: "available", authenticated: true }, { ...notInstalled, installing: true }];
    for (const one of BUILT_IN_DRIVERS) {
      for (const snapshot of snapshots) {
        for (const signIn of [undefined, { method: "device-code" }]) {
          for (const access of [one.metadata.access, "api" as const]) {
            const line = hint({ name: one.metadata.displayName, driverKind: one.driverKind, access, install: one.install, signIn, snapshot,
              ...(one.metadata.signInAccount ? { account: one.metadata.signInAccount } : {}) });
            expect(line.why.trim(), one.driverKind).not.toBe("");
            expect(line.connect.trim(), one.driverKind).not.toBe("");
          }
        }
      }
    }
  });
});

describe("what the hints cost", () => {
  it("costs nothing outside the list_models call: no prompt line about engines rides every turn", () => {
    expect(botPersona({ name: "MausBot", defaultBot: {} })).not.toMatch(/list_models|API key|sign in/u);
  });
});

describe("list_models on a fresh install with nothing set up", () => {
  const registry = (snapshot: (kind: string) => ProviderSnapshot) => {
    const live = Object.entries(DEFAULT_FLEET).map(([instanceId, entry]) => {
      const kind = driver(entry.driver);
      return { instanceId, driverKind: entry.driver, displayName: entry.displayName ?? kind.metadata.displayName, enabled: true, access: entry.access ?? kind.metadata.access,
        models: kind.models, adapter: { capabilities: {} }, account: kind.metadata.signInAccount,
        // Pinned: whether Google publishes a runtime to download depends on the platform the test runs on.
        install: entry.driver === "antigravityAgent" ? managed : kind.install,
        signIn: ["antigravityAgent", "codex", "claudeAgent", "kimiAgent", "grokAgent", "cursorAgent"].includes(entry.driver) ? { method: "browser" } : undefined };
    });
    const byId = new Map(live.map((one) => [one.instanceId, one]));
    const hints = createEngineHints({
      registry: {
        get: (id) => byId.get(id) ?? null, knownSnapshot: (id) => snapshot(byId.get(id)!.driverKind),
        connection: (id) => ({ install: byId.get(id)!.install, signIn: byId.get(id)!.signIn, account: byId.get(id)!.account }), entries: () => [],
      },
      access: (id) => byId.get(id)?.access, managed: () => false, policy: () => undefined,
    });
    return { live: live as unknown as MenuEngine[], hints };
  };

  it("names every engine with why and how, grouped, in a few hundred bytes more than the names alone", () => {
    const { live, hints } = registry(() => notInstalled);
    const current = { instanceId: "claude", model: "" };
    const menu = modelMenu({ engines: live, current, pinned: [], refusal: () => null, down: (engine) => hints.hint(engine.instanceId) });
    const named = menu.unavailable!.flatMap((group) => group.engines);
    expect(named.toSorted()).toEqual(live.map((engine) => engine.displayName!).toSorted());
    for (const group of menu.unavailable!) expect(group.why && group.connect).toBeTruthy();
    const google = menu.unavailable!.find((group) => group.engines.includes("Google Gemini (Antigravity)"))!;
    expect(google.connect).toMatch(/Google account.*no API key/u);
    // Before: the names alone. The lines repeat once per group, not once per engine.
    const before = JSON.stringify({ current, engines: [], unavailable: named });
    const added = JSON.stringify(menu).length - before.length;
    expect(menu.unavailable!.length).toBeLessThanOrEqual(7);
    expect(added).toBeLessThan(1_000);
  });
});
