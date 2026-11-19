// saveConfig merge behavior — the per-instance permission toggle relies on
// an `instances` patch merging by instanceId instead of clobbering sibling
// config, and previously `instances` wasn't merged into disk at all.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR, instanceConfigs, LEGACY_CLOUD_COMPUTER_DRIVER, loadConfig, saveConfig } from "./config.ts";

describe("saveConfig instances merge", () => {
  it("defaults idle permission approval on at ten seconds and persists preferences", () => {
    expect(loadConfig()).toMatchObject({ autoApprovePermissions: true, autoApproveDelaySeconds: 10 });
    saveConfig({ autoApprovePermissions: false, autoApproveDelaySeconds: 25 });
    expect(loadConfig()).toMatchObject({ autoApprovePermissions: false, autoApproveDelaySeconds: 25 });
  });
  it("deletes a stored Composio key left by older builds", () => {
    const file = join(DATA_DIR, "config.json");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify({ composio: { key: "ck_old", apiKey: "ak_old" }, profile: { name: "TEST · Person" } }));
    const cfg = loadConfig();
    expect(cfg).not.toHaveProperty("composio");
    const disk = JSON.parse(readFileSync(file, "utf8"));
    expect(disk).not.toHaveProperty("composio");
    expect(disk.profile).toEqual({ name: "TEST · Person" });
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

describe("removed cloud computer config", () => {
  it("ignores old credentials and drops them on the next atomic save", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    const file = join(DATA_DIR, "config.json");
    writeFileSync(file, JSON.stringify({ box: { token: "obsolete-secret" }, profile: { name: "Ada" } }));
    expect(loadConfig()).not.toHaveProperty("box");
    saveConfig({ autoHandoffs: false });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).not.toHaveProperty("box");
    expect(saved.profile.name).toBe("Ada");
  });

  it("filters old custom instances and provides defaults if only removed instances remain", () => {
    const driver = LEGACY_CLOUD_COMPUTER_DRIVER;
    expect(instanceConfigs({ instances: { old: { driver }, writer: { driver: "claudeAgent" } } })).toEqual({ writer: { driver: "claudeAgent", environment: {} } });
    expect(Object.keys(instanceConfigs({ instances: { old: { driver } } }))).toEqual(["grok", "claude", "codex", "antigravity"]);
    expect(instanceConfigs({})).not.toHaveProperty("computer");
  });
});
