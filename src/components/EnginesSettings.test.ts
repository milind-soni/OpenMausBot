import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { EnginesSettings } from "./EnginesSettings";
import { accountActions } from "./EngineAccounts";
import { AntigravityFreeSpace, formatDiskSize } from "./AntigravityFreeSpace";

const fixture = vi.hoisted(() => ({ instances: [] as InstanceInfo[], bots: [] as Bot[], config: undefined as Record<string, unknown> | undefined }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture, refreshInstances: async () => {}, refreshModels: async () => {} }),
}));
afterEach(() => vi.unstubAllGlobals());

function render(authenticated: boolean, options: { email?: string; signOut?: boolean; assigned?: boolean } = {}): string {
  vi.stubGlobal("window", {});
  vi.stubGlobal("navigator", { userAgent: "Linux" });
  fixture.instances = [{
    instanceId: "codex",
    driverKind: "codexAgent",
    displayName: "Codex",
    cliDefault: "codex",
    snapshot: { state: "available", authenticated, ...(options.email ? { account: { email: options.email } } : {}) },
    models: { default: "model", options: [] },
    authentication: { method: "device-code", ...(options.signOut ? { signOut: true } : {}) },
    install: { signInCommand: "codex login" },
  }];
  fixture.bots = options.assigned ? [{ modelSelection: { instanceId: "codex" } } as Bot] : [];
  return renderToStaticMarkup(createElement(EnginesSettings));
}

describe("Settings → Engines → ChatGPT accounts", () => {
  it("lists a signed-out account with one Sign in button", () => {
    const html = render(false);
    expect(html).toContain('data-account="codex" data-account-state="signedOut"');
    expect(html).toContain("Not signed in");
    expect(html.match(/<button[^>]*>Sign in<\/button>/g)).toHaveLength(1);
    expect(html).not.toContain("Provider icon");
    expect(html).not.toContain("Check account");
  });

  it("shows a signed-in account by its email and offers nothing to replace it", () => {
    const html = render(true, { email: "ada@example.test", signOut: true });
    expect(html).toContain('data-account-state="signedIn"');
    expect(html).toContain("ada@example.test");
    expect(html).not.toMatch(/<button[^>]*>Sign in<\/button>/);
    expect(render(true)).toContain(">Signed in<");
  });

  it("offers sign-out only for a signed-in account the server can sign out, and removal only for added accounts", () => {
    const account = (instanceId: string, authenticated: boolean, signOut: boolean): InstanceInfo => ({
      instanceId, driverKind: "codex", displayName: "Plan", snapshot: { state: "available", authenticated, chatgptPlan: true },
      models: { default: "gpt", options: [] }, authentication: { method: "browser-pkce", signOut },
    });
    expect(accountActions("chatgpt", account("chatgpt", true, true))).toEqual({ signOut: true, remove: false });
    expect(accountActions("chatgpt", account("chatgpt-work", true, false))).toEqual({ signOut: false, remove: true });
    expect(accountActions("chatgpt", account("chatgpt-work", false, true))).toEqual({ signOut: false, remove: true });
    fixture.instances = [{ ...account("chatgpt-work", true, false), cliDefault: "codex" }];
    fixture.bots = [];
    expect(renderToStaticMarkup(createElement(EnginesSettings))).toContain(">Remove<");
  });
});

describe("Settings → Engines → Grok", () => {
  function renderGrok(authenticated: boolean): string {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.instances = [{
      instanceId: "grok", driverKind: "grokAgent", displayName: "Grok", cliDefault: "grok",
      snapshot: { state: "available", authenticated, version: "grok 1.0.41" },
      models: { default: "grok-4.7", options: [] },
      authentication: { method: "device-code", signOut: false },
      install: { command: { linux: "curl -fsSL https://x.ai/cli/install.sh | bash" }, signInCommand: "grok login" },
    }];
    fixture.bots = [];
    return renderToStaticMarkup(createElement(EnginesSettings));
  }

  it("signs in from Settings with a code, never ChatGPT's card", () => {
    const html = renderGrok(false);
    expect(html).toContain('data-device-sign-in="grok"');
    expect(html).toContain("Sign in to Grok");
    expect(html).not.toContain("ChatGPT");
  });

  it("says Grok is connected once it is, in Grok's words", () => {
    const html = renderGrok(true);
    expect(html).toContain("Grok connected");
    expect(html).not.toContain("ChatGPT");
    expect(html).not.toContain("Sign in to Grok");
  });
});

describe("Settings → Engines → setup cards", () => {
  it.each([true, false])("offers exactly one way to add an account, inside its provider card (authenticated: %s)", (authenticated) => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    const claude: InstanceInfo = {
      instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", cliDefault: "claude",
      snapshot: { state: "available", authenticated }, models: { default: "sonnet", options: [] },
    };
    const chatgpt: InstanceInfo = {
      instanceId: "chatgpt", driverKind: "codex", displayName: "ChatGPT", cliDefault: "codex",
      snapshot: { state: "available", authenticated, chatgptPlan: true }, models: { default: "gpt", options: [] },
    };
    for (const [instance, label, other] of [
      [claude, "Add another Claude account", "Add another ChatGPT account"],
      [chatgpt, "Add another ChatGPT account", "Add another Claude account"],
      [{ instanceId: "antigravity", driverKind: "antigravityAgent", displayName: "Antigravity", cliDefault: "agy_acp_server", snapshot: { state: "available", authenticated }, models: { default: "gemini", options: [] } } as InstanceInfo, "Add Google account", "Add another ChatGPT account"],
    ] as const) {
      fixture.instances = [instance];
      const html = renderToStaticMarkup(createElement(EnginesSettings));
      expect(html.split(label)).toHaveLength(2);
      expect(html.indexOf(label)).toBeGreaterThan(html.indexOf(`data-engine-card="${instance.instanceId}"`));
      expect(html.indexOf(label)).toBeLessThan(html.lastIndexOf("</details>"));
      expect(html).not.toContain(other);
      expect(html).not.toContain("Provider icon");
      fixture.instances = [{ ...instance, readOnly: true }];
      expect(renderToStaticMarkup(createElement(EnginesSettings))).not.toContain(label);
    }
    fixture.instances = [{ ...claude, access: "custom" }, {
      ...chatgpt, snapshot: { ...chatgpt.snapshot, authenticated: false, authenticationUnavailableReason: "Not supported on this server" },
    }];
    const unsupported = renderToStaticMarkup(createElement(EnginesSettings));
    expect(unsupported).not.toContain("Add another Claude account");
    expect(unsupported).not.toContain("Add another ChatGPT account");
    expect(unsupported).toContain("Not supported on this server");
    expect(unsupported).not.toMatch(/<button[^>]*>Sign in<\/button>/);
  });

  it("shows the actual Google account email with an honest fallback", () => {
    vi.stubGlobal("window", {});
    fixture.bots = [];
    const instance: InstanceInfo = { instanceId: "google-work", driverKind: "antigravityAgent", displayName: "Work", cliDefault: "agy_acp_server", snapshot: { state: "available", authenticated: true, account: { email: "work@example.test" } }, models: { default: "gemini", options: [] } };
    fixture.instances = [instance];
    expect(renderToStaticMarkup(createElement(EnginesSettings))).toContain("work@example.test");
    delete instance.snapshot.account;
    expect(renderToStaticMarkup(createElement(EnginesSettings))).toContain("account email unavailable");
    instance.snapshot.authenticated = false;
    expect(renderToStaticMarkup(createElement(EnginesSettings))).not.toContain("account email unavailable");
  });

  it("offers removal for an added Antigravity account only", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    const account = (instanceId: string): InstanceInfo => ({
      instanceId, driverKind: "antigravityAgent", displayName: "Google account", cliDefault: "agy_acp_server",
      snapshot: { state: "available", authenticated: true }, models: { default: "gemini", options: [] },
    });
    fixture.instances = [account("antigravity")];
    expect(renderToStaticMarkup(createElement(EnginesSettings))).not.toContain(">Remove<");
    fixture.instances = [account("antigravity-work")];
    expect(renderToStaticMarkup(createElement(EnginesSettings))).toContain(">Remove<");
  });

  it("shows every Company provider as read-only while preserving personal controls", () => {
    vi.stubGlobal("window", {});
    fixture.bots = [];
    fixture.instances = ["claudeAgent", "codex", "openai-compat"].map((driverKind) => ({
      instanceId: `company.fixture.${driverKind}`, displayName: `Company ${driverKind}`, driverKind, readOnly: true,
      snapshot: { state: "available", authenticated: true }, models: { default: "model", options: [] },
      authentication: { method: "device-code", signOut: true }, install: { signInCommand: "fixture login" },
    }));
    const companyOnly = renderToStaticMarkup(createElement(EnginesSettings));
    for (const driver of ["claudeAgent", "codex", "openai-compat"]) expect(companyOnly).toContain(`Company ${driver}`);
    expect(companyOnly).toContain("managed by your organization");
    for (const control of ["Set CLI", "CLI path and updates", "Sign out of ChatGPT", "Update Claude", "fixture login", "Add another Claude account", "Add another ChatGPT account"]) expect(companyOnly).not.toContain(control);
    fixture.instances.push({ instanceId: "personal", displayName: "Personal Claude", driverKind: "claudeAgent", cliDefault: "claude",
      snapshot: { state: "available" }, models: { default: "sonnet", options: [] } });
    const withPersonal = renderToStaticMarkup(createElement(EnginesSettings));
    expect(withPersonal).toContain("Set CLI"); expect(withPersonal).toContain("CLI path and updates"); expect(withPersonal).toContain("Update Claude");
  });

  it("preserves one-click server installs and updates inside engine cards", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    fixture.instances = [{
      instanceId: "kimi", displayName: "Kimi", driverKind: "kimiAgent", cliDefault: "kimi",
      snapshot: { state: "unavailable" }, models: { default: "model", options: [] },
      install: { server: { package: "kimi-fixture" }, command: { linux: "npm install -g kimi-fixture" } },
    }];
    expect(renderToStaticMarkup(createElement(EnginesSettings))).toContain("Install Kimi here");
    fixture.instances[0].snapshot = {
      state: "available", authenticated: true,
      update: { title: "Kimi update available", message: "A newer version is available.", command: "npm install -g kimi-fixture@latest" },
    };
    const html = renderToStaticMarkup(createElement(EnginesSettings));
    expect(html).toContain("Update Kimi here");
    expect(html).not.toContain("Install Kimi here");
  });

  it("shows a standing warning from the snapshot without a command to run", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    fixture.instances = [{
      instanceId: "claude", displayName: "Claude", driverKind: "claudeAgent", cliDefault: "claude",
      snapshot: {
        state: "available", authenticated: true,
        warning: { title: "Bots inherit this machine's Claude Code setup", message: "OMB_CLAUDE_INHERIT_USER_CONFIG=1 is set." },
      },
      models: { default: "model", options: [] },
    }];
    const html = renderToStaticMarkup(createElement(EnginesSettings));
    expect(html).toContain("data-engine-warning-notice");
    expect(html).toContain("Bots inherit this machine&#x27;s Claude Code setup");
    expect(html).toContain("OMB_CLAUDE_INHERIT_USER_CONFIG=1 is set.");
    expect(html).not.toContain("data-engine-update-notice");
    delete fixture.instances[0].snapshot.warning;
    expect(renderToStaticMarkup(createElement(EnginesSettings))).not.toContain("data-engine-warning-notice");
  });

  it("exposes managed Antigravity setup and keeps custom engines free of cloud sign-in", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    fixture.instances = [{
      instanceId: "agy", displayName: "Antigravity", driverKind: "antigravityAgent", cliDefault: "agy",
      snapshot: { state: "available", authenticated: false }, models: { default: "model", options: [] },
      install: { managed: { label: "Install Antigravity", downloadBytes: 10 } },
    }];
    const html = renderToStaticMarkup(createElement(EnginesSettings));
    expect(html).toContain("Sign in with Google");
    expect(html).toContain("Set up");
    expect(html).toContain("CLI path and updates");
    fixture.instances[0].access = "custom";
    expect(renderToStaticMarkup(createElement(EnginesSettings))).not.toContain("Sign in with Google");
  });

  it("keeps an API-key engine listed after its key is saved, with the key masked and Replace beside it", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    const openai = (snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({
      instanceId: "openai", displayName: "OpenAI", driverKind: "openai-compat", access: "api",
      snapshot, models: { default: "gpt-5", options: [] },
    });
    fixture.instances = [openai({ state: "unavailable", reason: "No API key" })];
    const before = renderToStaticMarkup(createElement(EnginesSettings));
    expect(before).toContain("OpenAI needs an API key");
    expect(before).toContain('data-key-row="openai"');
    expect(before).toContain('placeholder="sk-…"');
    expect(before).not.toContain("data-key-replace");

    fixture.instances = [openai({ state: "available", authenticated: true, version: null })];
    fixture.config = { openai: { configured: true, last4: "a1b2" } };
    const saved = renderToStaticMarkup(createElement(EnginesSettings));
    expect(saved).toContain('data-engine-card="openai"');
    expect(saved).toContain('data-engine-setup-api-key="configured"');
    expect(saved).toContain("OpenAI uses your API key");
    expect(saved).toContain("••••••••a1b2");
    expect(saved).toContain("data-key-replace");
    expect(saved).not.toContain("OpenAI needs an API key");

    vi.stubGlobal("window", { ogb: { remoteClient: { active: true } } });
    const remote = renderToStaticMarkup(createElement(EnginesSettings));
    expect(remote).toContain("open Settings → API keys on the computer running MausBot");
    expect(remote).not.toContain("data-key-row");

    vi.stubGlobal("window", {});
    fixture.instances = [{ ...openai({ state: "available", authenticated: true, version: null }), managed: { organizationId: "org", organizationName: "Acme" } }];
    expect(renderToStaticMarkup(createElement(EnginesSettings))).not.toContain("data-key-row");
    fixture.config = undefined;
  });
});

describe("Settings → Engines → Antigravity → Free up space", () => {
  const antigravity = (freeUpSpace?: boolean): InstanceInfo => ({
    instanceId: "agy", displayName: "Antigravity", driverKind: "antigravityAgent", cliDefault: "agy",
    snapshot: { state: "available", authenticated: true }, models: { default: "model", options: [] },
    ...(freeUpSpace ? { freeUpSpace } : {}),
  });

  it("appears only where the server says the engine leaves files behind (Antigravity on Windows)", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    fixture.instances = [antigravity(true)];
    const html = renderToStaticMarkup(createElement(EnginesSettings));
    expect(html).toContain("Leftover files");
    expect(html).toContain("Free up space");
    expect(html).toContain("Nothing is deleted until you confirm.");
    fixture.instances = [antigravity()];
    expect(renderToStaticMarkup(createElement(EnginesSettings))).not.toContain("Free up space");
  });

  it("says how much it found before offering to delete", () => {
    const found = renderToStaticMarkup(createElement(AntigravityFreeSpace, {
      instance: antigravity(true), initial: { kind: "found", bytes: 2.5 * 1024 ** 3, complete: true },
    }));
    expect(found).toContain("Found 2.5 GB of leftover files.");
    expect(found).toContain("Delete them");
    expect(found).toContain("Cancel");
    const partial = renderToStaticMarkup(createElement(AntigravityFreeSpace, {
      instance: antigravity(true), initial: { kind: "found", bytes: 340 * 1024 ** 2, complete: false },
    }));
    expect(partial).toContain("Found at least 340 MB of leftover files.");
  });

  it("reports what it freed and what it had to leave", () => {
    const done = renderToStaticMarkup(createElement(AntigravityFreeSpace, {
      instance: antigravity(true), initial: { kind: "done", freedBytes: 1.26 * 1024 ** 3, remaining: 1 },
    }));
    expect(done).toContain("Freed 1.3 GB.");
    expect(done).toContain("Some files are still in use and were left alone.");
    const nothing = renderToStaticMarkup(createElement(AntigravityFreeSpace, {
      instance: antigravity(true), initial: { kind: "done", freedBytes: 0, remaining: 2 },
    }));
    expect(nothing).not.toContain("Freed");
    expect(nothing).toContain("Some files are still in use and were left alone.");
    expect(formatDiskSize(10)).toBe("less than 1 MB");
  });
});

describe("Settings → Engines → Claude accounts", () => {
  function claude(instanceId: string, displayName: string, authenticated?: boolean, extra: Partial<InstanceInfo> = {}): InstanceInfo {
    return {
      instanceId,
      driverKind: "claudeAgent",
      displayName,
      cliDefault: "claude",
      access: "subscription",
      snapshot: { state: "available", authenticated, ...(authenticated ? { account: { email: `${displayName.toLowerCase()}@example.test`, organization: "Studio" } } : {}) },
      models: { default: "sonnet", options: [] },
      authentication: { method: "paste-code", signOut: true },
      claudeAccount: { configDir: `/profiles/${instanceId}`, signInCommand: `CLAUDE_CONFIG_DIR=/profiles/${instanceId} claude auth login`, signInShell: "sh", isDefault: instanceId === "claude" },
      ...extra,
    };
  }
  function renderClaude(...instances: InstanceInfo[]) {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.instances = instances;
    fixture.bots = [];
    return renderToStaticMarkup(createElement(EnginesSettings));
  }

  it("lists every Claude account on one Claude card", () => {
    const html = renderClaude(claude("claude", "Personal", true), claude("claude-work", "Work", false));
    expect(html.match(/data-engine-card=/g)).toHaveLength(1);
    expect(html).toContain('data-engine-card="claude"');
    expect(html).toContain("2 accounts · 1 signed in");
    expect(html).toContain('data-account="claude" data-account-state="signedIn"');
    expect(html).toContain('data-account="claude-work" data-account-state="signedOut"');
  });

  it("gives each account one clear action and no terminal steps until asked", () => {
    const html = renderClaude(claude("claude", "Personal", true), claude("claude-work", "Work", false), claude("claude-team", "Team", undefined));
    expect(html).toContain("personal@example.test · Studio");
    expect(html).toContain("Not signed in");
    expect(html).toContain("Sign-in not confirmed yet");
    expect(html.match(/<button[^>]*>Sign in<\/button>/g)).toHaveLength(2);
    for (const gone of ["Check account", "Manage account and sign-in", "claude auth login", "Default account"]) expect(html).not.toContain(gone);
  });

  it("names an API key instead of a person and never signs it out", () => {
    const keyed = claude("claude-work", "Work", true);
    keyed.snapshot.account = { method: "api-key" };
    expect(renderClaude(keyed)).toContain("Uses an API key");
    expect(accountActions("claude", keyed).signOut).toBe(false);
  });

  it("keeps the default account and signs out only a signed-in account the server can sign out", () => {
    expect(accountActions("claude", claude("claude", "Personal", true))).toEqual({ signOut: true, remove: false });
    expect(accountActions("claude", claude("claude-work", "Work", false))).toEqual({ signOut: false, remove: true });
    expect(accountActions("claude", claude("claude-work", "Work", true, { authentication: { method: "paste-code", signOut: false } }))).toEqual({ signOut: false, remove: true });
    expect(renderClaude(claude("claude-work", "Work", true))).toContain(">Remove<");
  });

  it("shows Claude Code's setup instead of accounts while it is missing", () => {
    const html = renderClaude(claude("claude", "Personal", undefined, { snapshot: { state: "unavailable", reason: "`claude` CLI not found" } }));
    expect(html).not.toContain("data-accounts");
    expect(html).toContain("CLI not found");
    expect(html).toContain("Needs setup");
  });

});

describe("Settings → AI in Simple mode", () => {
  const engine = (instanceId: string, driverKind: string, authenticated: boolean, extra: Partial<InstanceInfo> = {}): InstanceInfo => ({
    instanceId, driverKind, displayName: instanceId, cliDefault: instanceId,
    snapshot: { state: "available", authenticated }, models: { default: "model", options: [] }, ...extra,
  });
  const simple = (open = false) => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: "Linux" });
    fixture.bots = [];
    return renderToStaticMarkup(createElement(EnginesSettings, { simple: true, more: { id: "ai-more", open, onToggle: () => {} } }));
  };
  const rows = (html: string) => [...html.matchAll(/data-simple-engine="([^"]+)"/g)].map((match) => match[1]);

  it("lists each ready provider, and each one signed in by subscription, as a row with Manage or Set up", () => {
    fixture.instances = [
      engine("claude", "claudeAgent", true),
      engine("codex", "codexAgent", false, { authentication: { method: "device-code" } }),
      engine("kimi", "kimiAgent", false),
    ];
    const html = simple();
    expect(html).toContain(">Your AI</h3>");
    expect(rows(html)).toEqual(["claude", "codex"]);
    expect(html).toMatch(/data-simple-engine="claude"[\s\S]*?>Manage<\/button>/);
    expect(html).toMatch(/data-simple-engine="codex"[\s\S]*?>Set up<\/button>/);
    expect(html).not.toContain("Model providers and accounts");
  });

  it("folds every other provider under More AI providers, with the count", () => {
    fixture.instances = [engine("claude", "claudeAgent", true), engine("kimi", "kimiAgent", false), engine("mistral", "mistral", false)];
    expect(simple()).toMatch(/aria-expanded="false"[^>]*>[\s\S]*?More AI providers \(2\)/);
    expect(simple(true)).toContain('data-engine-card="kimi"');
  });
});
