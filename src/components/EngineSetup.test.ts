import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EngineSetup, EngineUpdateNotice, needsCli, needsSignIn } from "./EngineSetup";
import { engineStatus } from "./ModelPicker";
import { StoreProvider, type InstanceInfo } from "@/state/store";

afterEach(() => vi.unstubAllGlobals());

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "kimi",
    driverKind: "kimiAgent",
    displayName: "Kimi",
    models: { default: "kimi-code/k3", options: [] },
    snapshot,
  };
}

describe("needsCli / needsSignIn", () => {
  it("treats a missing binary as a CLI install, not a sign-in", () => {
    const missing = instance({ state: "unavailable", reason: "`kimi` CLI not found" });
    expect(needsCli(missing)).toBe(true);
    expect(needsSignIn(missing)).toBe(false);
  });

  it("lets Custom inject run when the CLI is installed but unsigned-in", () => {
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    expect(needsCli(unsigned)).toBe(false);
    expect(needsSignIn(unsigned)).toBe(true);
  });

  it("is ready for inject when the CLI is present", () => {
    const ready = instance({ state: "available", authenticated: true, version: "0.36.1" });
    expect(needsCli(ready)).toBe(false);
    expect(needsSignIn(ready)).toBe(false);
  });
});

describe("managed engine setup errors", () => {
  function managed(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
    return {
      ...instance(snapshot),
      instanceId: "antigravity",
      driverKind: "antigravityAgent",
      displayName: "Antigravity",
      install: { managed: { label: "Install official Antigravity", downloadBytes: 1024 } },
    };
  }

  function render(engine: InstanceInfo): string {
    vi.stubGlobal("window", { ogb: { platform: "darwin" } });
    return renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
  }

  it("shows profile failures without claiming the runtime is missing", () => {
    const reason = "Cannot write Antigravity profile settings (EACCES).";
    const engine = managed({ state: "unavailable", reason });
    const markup = render(engine);
    expect(markup).toContain(reason);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Install official Antigravity");
    expect(engineStatus(engine)).toBe("Setup required");
    expect(markup).not.toMatch(/CLI not found|Not installed/);
  });

  it("renders an initialization failure reported by the snapshot", () => {
    const engine = managed({ state: "unavailable", reason: "initialize timed out." });
    expect(render(engine)).toContain("initialize timed out.");
    expect(engineStatus(engine)).toBe("Setup required");
  });

  it("preserves the installed engine's sign-in flow", () => {
    const engine = managed({ state: "available", authenticated: false, version: "1.1.1" });
    const markup = render(engine);
    expect(engineStatus(engine)).toBe("Sign-in required");
    expect(markup).toContain("Sign in with Google");
    expect(markup).not.toContain("Install official Antigravity");
  });
});

describe("install from Settings on the server", () => {
  function npmEngine(snapshot: InstanceInfo["snapshot"], server = true): InstanceInfo {
    return {
      ...instance(snapshot),
      install: {
        command: { linux: "npm install -g kimi-fixture", darwin: "npm install -g kimi-fixture", win32: "npm install -g kimi-fixture" },
        needsNode: true,
        signInCommand: "kimi login",
        ...(server ? { server: { package: "kimi-fixture" } } : {}),
      },
    };
  }
  function render(engine: InstanceInfo): string {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    return renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
  }

  it("offers one click on the server and keeps the terminal command behind a disclosure", () => {
    const markup = render(npmEngine({ state: "unavailable", reason: "`kimi` CLI not found" }));
    expect(markup).toContain("Install Kimi on this server");
    expect(markup).toContain("as its own user");
    expect(markup).toContain("Prefer a terminal?");
    expect(markup).toContain("npm install -g kimi-fixture");
    expect(markup).not.toContain("needs");
  });

  it("falls back to the terminal command when the server cannot install", () => {
    const markup = render(npmEngine({ state: "unavailable", reason: "`kimi` CLI not found" }, false));
    expect(markup).not.toContain("on this server");
    expect(markup).toContain("npm install -g kimi-fixture");
  });

  it("never offers an install when only sign-in is missing", () => {
    const markup = render(npmEngine({ state: "available", authenticated: false, version: "1.0.0" }));
    expect(markup).not.toContain("Install Kimi on this server");
    expect(markup).toContain("kimi login");
  });

  it("turns the update notice into a button when the server can update", () => {
    const update = { title: "Kimi update available", message: "Newer models need it.", command: "npm install -g kimi-fixture@latest" };
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    const withServer = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineUpdateNotice, { update, instance: npmEngine({ state: "available", authenticated: true }) })));
    expect(withServer).toContain("Update Kimi on this server");
    expect(withServer).toContain("Prefer a terminal?");
    const without = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineUpdateNotice, { update, instance: npmEngine({ state: "available", authenticated: true }, false) })));
    expect(without).not.toContain("on this server");
    expect(without).toContain("npm install -g kimi-fixture@latest");
  });
});

describe("server device-code sign-in", () => {
  it("uses the supported browser sign-in flow instead of asking a remote user to run a command", () => {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    const engine: InstanceInfo = {
      ...instance({ state: "available", authenticated: false }),
      instanceId: "codex",
      driverKind: "codexAgent",
      displayName: "Codex",
      authentication: { method: "device-code" },
      install: { signInCommand: "codex login" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine })));
    expect(markup).toContain("Connect ChatGPT");
    expect(markup).toContain("no terminal or password sharing");
    expect(markup).not.toContain("codex login");
  });

  it("does not ask to sign in when installing a CLI for local-model injection", () => {
    vi.stubGlobal("window", { ogb: { platform: "linux" } });
    const engine: InstanceInfo = {
      ...instance({ state: "available", authenticated: false }),
      authentication: { method: "device-code" },
      install: { command: { linux: "npm install -g @openai/codex" }, signInCommand: "codex login" },
    };
    const markup = renderToStaticMarkup(createElement(StoreProvider, null, createElement(EngineSetup, { instance: engine, intent: "inject" })));
    expect(markup).not.toContain("Connect ChatGPT");
    expect(markup).toContain("npm install");
  });
});
