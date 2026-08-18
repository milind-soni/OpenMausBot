// Credential discovery is the part with a contract outside this repo: the
// layout is the multica CLI's, and getting it wrong means the driver reports
// "not signed in" at a perfectly good workstation.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { multicaConfigPath, resolveMulticaProfile } from "./multica-client.ts";

let home = "";
const ENV_KEYS = ["MULTICA_SERVER_URL", "MULTICA_TOKEN", "MULTICA_WORKSPACE_ID"] as const;
const saved: Record<string, string | undefined> = {};

function writeConfig(where: string, body: unknown) {
  mkdirSync(join(where, ".."), { recursive: true });
  writeFileSync(where, JSON.stringify(body));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "multica-home-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("multicaConfigPath", () => {
  // Mirrors the CLI's own ConfigPath: no profile is the default config, a
  // named profile lives one level down.
  it("uses the default config when no profile is named", () => {
    expect(multicaConfigPath(undefined, "/h")).toBe("/h/.multica/config.json");
  });

  it("uses the profile directory when one is", () => {
    expect(multicaConfigPath("work", "/h")).toBe("/h/.multica/profiles/work/config.json");
  });
});

describe("resolveMulticaProfile", () => {
  it("reads a signed-in CLI, workspace included", () => {
    writeConfig(join(home, ".multica", "config.json"), {
      server_url: "https://multica.example.com",
      token: "mul_secret",
      workspace_id: "ws-1",
    });
    expect(resolveMulticaProfile(undefined, home)).toEqual({
      baseUrl: "https://multica.example.com",
      token: "mul_secret",
      workspaceId: "ws-1",
    });
  });

  it("finds a named profile", () => {
    writeConfig(join(home, ".multica", "profiles", "work", "config.json"), {
      server_url: "https://work.example.com/",
      token: "mul_work",
    });
    const profile = resolveMulticaProfile("work", home);
    expect(profile?.baseUrl).toBe("https://work.example.com"); // trailing slash dropped
    expect(profile?.workspaceId).toBeUndefined();
  });

  it("reports nothing rather than half a credential", () => {
    writeConfig(join(home, ".multica", "config.json"), { server_url: "https://x.example.com" });
    expect(resolveMulticaProfile(undefined, home)).toBeNull();
  });

  it("is null when the CLI was never signed in", () => {
    expect(resolveMulticaProfile(undefined, home)).toBeNull();
  });

  it("lets the environment override a server the CLI never saw", () => {
    writeConfig(join(home, ".multica", "config.json"), {
      server_url: "https://from-cli.example.com",
      token: "mul_cli",
    });
    process.env.MULTICA_SERVER_URL = "https://from-env.example.com";
    process.env.MULTICA_TOKEN = "mul_env";
    process.env.MULTICA_WORKSPACE_ID = "ws-env";
    expect(resolveMulticaProfile(undefined, home)).toEqual({
      baseUrl: "https://from-env.example.com",
      token: "mul_env",
      workspaceId: "ws-env",
    });
  });

  it("ignores a half-set environment instead of failing the lookup", () => {
    writeConfig(join(home, ".multica", "config.json"), {
      server_url: "https://from-cli.example.com",
      token: "mul_cli",
    });
    process.env.MULTICA_SERVER_URL = "https://from-env.example.com"; // no token
    expect(resolveMulticaProfile(undefined, home)?.token).toBe("mul_cli");
  });
});
