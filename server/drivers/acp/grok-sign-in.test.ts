// The Grok engine's sign-in status against a fake `grok models`, never a real login.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { GrokAgentDriver } from "./grok.ts";
import { grokLoginCheck, readGrokModelsLogin } from "./grok-sign-in.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "../../testing/fake-acp-cli.ts");

const scratches: string[] = [];
afterEach(async () => { for (const dir of scratches.splice(0)) await removeTempDir(dir); });

const home = (login: string, withAuth = true) => {
  chmodSync(FAKE_CLI, 0o755);
  const scratch = mkdtempSync(join(tmpdir(), "omb-grok-sign-in-"));
  scratches.push(scratch);
  mkdirSync(join(scratch, "grok"), { recursive: true });
  const authFile = join(scratch, "grok", "auth.json");
  if (withAuth) writeFileSync(authFile, "{}");
  const count = join(scratch, "models-calls");
  const env = { ...process.env, GROK_HOME: join(scratch, "grok"), FAKE_ACP_GROK_LOGIN: login, FAKE_ACP_GROK_LOGIN_COUNT: count };
  const calls = () => existsSync(count) ? Number(readFileSync(count, "utf8")) : 0;
  return { env, authFile, calls };
};

describe("reading `grok models`", () => {
  it.each([
    ["You are logged in with grok.com.\nDefault model: grok-4.5", "signed-in"],
    ["You are using XAI_API_KEY.\nAvailable models:", "signed-in"],
    ["You are authenticated via deployment key.", "signed-in"],
    ["You are not authenticated.\nDefault model: grok-4.5", "signed-out"],
    ["Not logged in. Run `grok login`.", "signed-out"],
    ["Your auth token is invalid or expired. Run `grok login` to re-authenticate.", "signed-out"],
    ["Token expired. Run `grok login` to re-authenticate.", "signed-out"],
    ["\u001b[32m  You are logged in with grok.com.\u001b[0m", "signed-in"],
    ["Available models:\n  - grok-4.5 (default)", "unknown"],
    ["", "unknown"],
  ])("%j is %s", (output, login) => {
    expect(readGrokModelsLogin(output)).toBe(login);
  });
});

describe("the Grok sign-in check", () => {
  it("is signed in when Grok says so, asking once", async () => {
    const { env, authFile, calls } = home("signed-in");
    expect(await grokLoginCheck()(FAKE_CLI, env, authFile)).toBe(true);
    expect(calls()).toBe(1);
  });

  it("is signed out only when Grok says so twice", async () => {
    const { env, authFile, calls } = home("signed-out");
    expect(await grokLoginCheck()(FAKE_CLI, env, authFile)).toBe(false);
    expect(calls()).toBe(2);
  });

  it("is signed in when the first call refreshed an expired token", async () => {
    const { env, authFile, calls } = home("refreshes");
    expect(await grokLoginCheck()(FAKE_CLI, env, authFile)).toBe(true);
    expect(calls()).toBe(2);
  });

  it.each(["hang", "signed-out-hang"])("keeps the file's answer when `grok models` does not finish in time (%s)", async (login) => {
    const { env, authFile, calls } = home(login);
    const startedAt = Date.now();
    expect(await grokLoginCheck({ timeoutMs: 2_000 })(FAKE_CLI, env, authFile)).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_000);
    expect(calls()).toBe(1);
  }, 30_000);

  it("is signed out without auth.json, and never asks", async () => {
    const { env, authFile, calls } = home("signed-in", false);
    expect(await grokLoginCheck()(FAKE_CLI, env, authFile)).toBe(false);
    expect(calls()).toBe(0);
  });

  it("asks again only once auth.json changes", async () => {
    const { env, authFile, calls } = home("signed-in");
    const check = grokLoginCheck();
    expect(await check(FAKE_CLI, env, authFile)).toBe(true);
    expect(await check(FAKE_CLI, env, authFile)).toBe(true);
    expect(calls()).toBe(1);
    writeFileSync(authFile, '{"signed":"again"}');
    env.FAKE_ACP_GROK_LOGIN = "signed-out";
    expect(await check(FAKE_CLI, env, authFile)).toBe(false);
    expect(calls()).toBe(3);
  });

  it("answers an old check at once and asks again behind it", async () => {
    const { env, authFile, calls } = home("signed-in");
    const check = grokLoginCheck({ freshMs: 0 });
    expect(await check(FAKE_CLI, env, authFile)).toBe(true);
    env.FAKE_ACP_GROK_LOGIN = "signed-out";
    expect(await check(FAKE_CLI, env, authFile)).toBe(true);
    expect(await check(FAKE_CLI, env, authFile)).toBe(false);
    expect(calls()).toBeGreaterThanOrEqual(3);
  });

  it("reports an expired login as signed out in the engine's status", async () => {
    ensureDirs();
    const { env } = home("signed-out");
    const instance = await GrokAgentDriver.create({
      instanceId: "grok-sign-in-status", displayName: "Grok", enabled: true,
      environment: { GROK_HOME: env.GROK_HOME!, FAKE_ACP_GROK_LOGIN: "signed-out" },
      config: { cli: FAKE_CLI, fullAuto: true },
    } as never) as ProviderInstance;
    try {
      expect(await instance.snapshot()).toMatchObject({ state: "available", authenticated: false });
    } finally {
      await instance.dispose();
    }
  });
});
