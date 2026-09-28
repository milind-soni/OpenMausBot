import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { EnginesSettings } from "./EnginesSettings";
import { ClaudeAccountForm } from "./ClaudeAccountSettings";

const fixture = vi.hoisted(() => ({ instances: [] as InstanceInfo[], bots: [] as Bot[] }));
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

describe("Settings → Engines → Codex", () => {
  it("makes browser sign-in discoverable in Settings, not only the model picker", () => {
    const html = render(false);
    expect(html).toContain("Connect ChatGPT");
    expect(html).toContain("Provider icon");
    expect(html).toContain("Google Gemini");
    expect(html).toContain("Upload a custom provider icon for Codex");
  });

  it("shows a connected account without offering to replace it", () => {
    const html = render(true);
    expect(html).toContain("ChatGPT connected on this server");
    expect(html).not.toContain("Connect ChatGPT");
    expect(html).not.toContain("Sign out of ChatGPT");
  });

  it("names the connected account and offers sign-out only when the server supports it", () => {
    const html = render(true, { email: "ada@example.test", signOut: true });
    expect(html).toContain("ada@example.test");
    expect(html).toContain("Sign out of ChatGPT");
    expect(html).toContain("Stop running Codex tasks before switching accounts");
    expect(html).toContain("Check account");
    expect(html).not.toContain("Connect ChatGPT");
    expect(html).not.toContain("codex logout");
    expect(render(true, { email: "ada@example.test" })).not.toContain("Sign out of ChatGPT");
    expect(render(false, { signOut: true })).not.toContain("Sign out of ChatGPT");
  });

  it("names affected bots without promising to cancel their running tasks", () => {
    const html = render(true, { signOut: true, assigned: true });
    expect(html).toContain("1 bot(s) use this Codex connection");
    expect(html).toContain("Running tasks are not cancelled by signing out");
    expect(html).not.toContain("will pause");
    expect(render(true, { signOut: true })).not.toContain("bot(s) use this Codex connection");
  });
});

describe("Settings → Engines → setup cards", () => {
  it("shows every Company provider as read-only while preserving personal controls", () => {
    vi.stubGlobal("window", {});
    fixture.bots = [];
    fixture.instances = ["claudeAgent", "codex", "openai-compat"].map((driverKind) => ({
      instanceId: `company.fixture.${driverKind}`, displayName: `Company ${driverKind}`, driverKind, readOnly: true,
      snapshot: { state: "available", authenticated: true }, models: { default: "model", options: [] },
      // Ignore even accidentally supplied mutation metadata for read-only rows.
      authentication: { method: "device-code", signOut: true }, install: { signInCommand: "fixture login" },
    }));
    const companyOnly = renderToStaticMarkup(createElement(EnginesSettings));
    for (const driver of ["claudeAgent", "codex", "openai-compat"]) expect(companyOnly).toContain(`Company ${driver}`);
    expect(companyOnly).toContain("managed by your organization");
    for (const control of ["Set CLI", "CLI path and updates", "Sign out of ChatGPT", "Update Claude", "fixture login"]) expect(companyOnly).not.toContain(control);
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
    expect(renderToStaticMarkup(createElement(EnginesSettings))).toContain("Install Kimi on this server");
    fixture.instances[0].snapshot = {
      state: "available", authenticated: true,
      update: { title: "Kimi update available", message: "A newer version is available.", command: "npm install -g kimi-fixture@latest" },
    };
    const html = renderToStaticMarkup(createElement(EnginesSettings));
    expect(html).toContain("Update Kimi on this server");
    expect(html).not.toContain("Install Kimi on this server");
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
});

describe("Settings → Engines → Claude accounts", () => {
  function claude(authenticated?: boolean, isDefault = false): InstanceInfo {
    return {
      instanceId: isDefault ? "claude" : "claude-work",
      driverKind: "claudeAgent",
      displayName: "Work",
      cliDefault: "claude",
      snapshot: { state: "available", authenticated, account: { email: "work@example.test", organization: "Studio" } },
      models: { default: "sonnet", options: [] },
      claudeAccount: { configDir: "/profiles/work", signInCommand: "CLAUDE_CONFIG_DIR=/profiles/work claude auth login", signInShell: "sh", isDefault },
    };
  }

  function renderClaude(instance: InstanceInfo, assigned = false) {
    fixture.instances = [instance];
    fixture.bots = assigned ? [{ modelSelection: { instanceId: instance.instanceId } } as Bot] : [];
    return renderToStaticMarkup(createElement(EnginesSettings));
  }

  it("offers an account name and an optional directory without implying sign-in", () => {
    const markup = renderToStaticMarkup(createElement(ClaudeAccountForm, { onSaved: () => {} }));
    expect(markup).toContain("Personal or Work");
    expect(markup).toContain("Automatic private directory");
    expect(markup).toContain("not a signed-in session");
    expect(markup).toContain("T3");
    expect(markup).not.toContain("Claude connected");
    expect(renderClaude(claude())).toContain("Add Claude account");
  });

  it("uses the exact server command and directs remote users to the server", () => {
    const markup = renderClaude(claude(false));
    expect(markup).toContain("CLAUDE_CONFIG_DIR=/profiles/work claude auth login");
    expect(markup).toContain("run it on the server, not this device");
    expect(markup).toContain("Check account");
    expect(markup).toContain("Sign-in required");
    expect(markup).not.toContain("Claude connected");
    expect(markup).not.toContain("work@example.test");
  });

  it("only announces a connected account from its authenticated snapshot", () => {
    expect(renderClaude(claude())).toContain("Account status unknown");
    const connected = renderClaude(claude(true));
    expect(connected).toContain("Claude connected");
    expect(connected).toContain("work@example.test · Studio");
  });

  it("labels the server's Windows command and keeps the default directory implicit", () => {
    const instance = claude(true, true);
    instance.claudeAccount = { ...instance.claudeAccount!, configDir: "", signInShell: "powershell" };
    const markup = renderClaude(instance);
    expect(markup).toContain("Use PowerShell for this command.");
    expect(markup).toContain("Normal Claude configuration");
    expect(markup).toMatch(/placeholder="Normal Claude configuration"[^>]*value=""/);
  });

  it("offers Claude sign-out only for a signed-in account the server can sign out", () => {
    const hosted = { ...claude(true), authentication: { method: "paste-code" as const, signOut: true } };
    const html = renderClaude(hosted);
    expect(html).toContain("Sign out of Claude");
    expect(html).toContain("different Claude subscription");
    expect(html).not.toContain("claude auth logout");
    expect(renderClaude(claude(true))).not.toContain("Sign out of Claude");
    expect(renderClaude({ ...claude(false), authentication: { method: "paste-code" as const, signOut: true } })).not.toContain("Sign out of Claude");
    expect(renderClaude(hosted, true)).toContain("1 bot(s) use this account");
    expect(renderClaude(hosted, true)).toContain("Running tasks are not cancelled by signing out");
    expect(html).toContain("Stop running Claude tasks before switching accounts");
    expect(html).not.toContain("pause");
  });

  it("names the workspace API key instead of a person and offers no sign-out for it", () => {
    const keyed = claude(true);
    keyed.snapshot = { state: "available", authenticated: true, account: { method: "api-key" } };
    keyed.authentication = { method: "paste-code", signOut: true };
    const html = renderClaude(keyed);
    expect(html).toContain("workspace API key");
    expect(html).not.toContain("work@example.test");
    expect(html).not.toContain("Sign out of Claude");
  });

  it("protects the default and assigned accounts and explains credential preservation", () => {
    const defaultMarkup = renderClaude(claude(true, true));
    expect(defaultMarkup).toContain("Default account");
    expect(defaultMarkup).not.toContain(">Remove account</button>");
    const assignedMarkup = renderClaude(claude(true), true);
    expect(assignedMarkup).toMatch(/<button[^>]*disabled=""[^>]*>Remove account<\/button>/);
    expect(assignedMarkup).toContain("Choose a different engine for every bot");
    expect(renderClaude(claude(true))).toContain("credentials and files stay on disk");
  });
});
