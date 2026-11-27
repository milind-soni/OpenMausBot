import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseConfigPatch, parseStoredConfig } from "../config.ts";
import { VaultStore } from "../vault-store.ts";
import { botTasksSettings, botTasksStatus, migrateBotTasksGithubToken } from "./settings.ts";

const token = "fixture-bot-tasks-migration-token";
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-bot-tasks-migration-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("bot task GitHub settings", () => {
  it("normalizes the legacy credential and keeps the token out of the stored read model", () => {
    const config = parseStoredConfig({ botTasks: { enabled: true, credential: "token", githubToken: token } });
    expect(config.botTasks).toEqual({ enabled: true, credential: "vault" });
    expect(botTasksSettings({})).toMatchObject({ enabled: false, credential: "gh" });
    expect(botTasksStatus(config, token)).toMatchObject({ enabled: true, credential: "vault", githubTokenSet: true });
    expect(botTasksStatus(config, null)).not.toHaveProperty("githubToken");
    expect(parseConfigPatch({ botTasks: { credential: "token", githubToken: null } }).botTasks).toEqual({
      credential: "vault", githubToken: null,
    });
    expect(() => parseConfigPatch({ botTasks: { credential: "wrong" } })).toThrow();
  });

  it("moves the legacy token once and preserves unrelated config fields", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ botTasks: { credential: "token", githubToken: token }, language: "en", other: true }));
    const vault = new VaultStore({ dataDir: dir });
    const setToken = vi.spyOn(vault, "setBotTasksGithubToken");
    migrateBotTasksGithubToken(dir, vault);
    migrateBotTasksGithubToken(dir, vault);
    expect(setToken).toHaveBeenCalledExactlyOnceWith(token);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ botTasks: { credential: "vault" }, language: "en", other: true });
    expect(new VaultStore({ dataDir: dir }).botTasksGithubToken()).toBe(token);
  });

  it("strips a restored legacy token without replacing the current vault token", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ botTasks: { credential: "token", githubToken: token } }));
    const vault = new VaultStore({ dataDir: dir });
    vault.setBotTasksGithubToken("fixture-new-token");
    migrateBotTasksGithubToken(dir, vault);
    expect(vault.botTasksGithubToken()).toBe("fixture-new-token");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ botTasks: { credential: "vault" } });
  });

  it("leaves the config byte-for-byte intact when the vault write fails", () => {
    const path = join(dir, "config.json");
    const legacy = JSON.stringify({ botTasks: { credential: "token", githubToken: token } });
    writeFileSync(path, legacy);
    expect(() => migrateBotTasksGithubToken(dir, {
      botTasksGithubToken: () => null,
      setBotTasksGithubToken: () => { throw new Error("vault write failed"); },
    })).toThrow("vault write failed");
    expect(readFileSync(path, "utf8")).toBe(legacy);
  });
});
