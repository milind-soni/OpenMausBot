// saveConfig merge behavior — the per-instance permission toggle relies on
// an `instances` patch merging by instanceId instead of clobbering sibling
// config, and previously `instances` wasn't merged into disk at all.
import { describe, expect, it } from "vitest";

import { loadConfig, saveConfig } from "./config.ts";

describe("saveConfig instances merge", () => {
  it("defaults idle permission approval on at ten seconds and persists preferences", () => {
    expect(loadConfig()).toMatchObject({ autoApprovePermissions: true, autoApproveDelaySeconds: 10 });
    saveConfig({ autoApprovePermissions: false, autoApproveDelaySeconds: 25 });
    expect(loadConfig()).toMatchObject({ autoApprovePermissions: false, autoApproveDelaySeconds: 25 });
  });
  it("writes a brand-new instances entry", () => {
    saveConfig({ instances: { claude: { driver: "claudeAgent", config: { permissionMode: "bypassPermissions" } } } });
    const cfg = loadConfig();
    expect(cfg.instances?.claude).toEqual({ driver: "claudeAgent", config: { permissionMode: "bypassPermissions" } });
  });

  it("merges into an existing instance without dropping sibling fields", () => {
    saveConfig({ instances: { claude: { driver: "claudeAgent", displayName: "My Claude", environment: { FOO: "1" } } } });
    saveConfig({ instances: { claude: { config: { permissionMode: "bypassPermissions" } } as any } });
    const cfg = loadConfig();
    expect(cfg.instances?.claude).toEqual({
      driver: "claudeAgent",
      displayName: "My Claude",
      environment: { FOO: "1" },
      config: { permissionMode: "bypassPermissions" },
    });
  });

  it("leaves other instances untouched", () => {
    saveConfig({ instances: { claude: { driver: "claudeAgent" }, codex: { driver: "codex" } } });
    saveConfig({ instances: { claude: { driver: "claudeAgent", config: { permissionMode: "bypassPermissions" } } } });
    const cfg = loadConfig();
    expect(cfg.instances?.codex).toEqual({ driver: "codex" });
  });

  it("leaves other top-level config keys untouched", () => {
    saveConfig({ profile: { name: "Ada", email: "ada@example.com" } });
    saveConfig({ instances: { claude: { driver: "claudeAgent" } } });
    const cfg = loadConfig();
    expect(cfg.profile).toEqual({ name: "Ada", email: "ada@example.com" });
  });
});
