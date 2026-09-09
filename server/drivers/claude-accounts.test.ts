import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { CLAUDE_ACCOUNT_ENV_KEYS, ClaudeDriver, resolveClaudeConfigDir } from "./claude.ts";

// This CLI only reads synthetic account labels and records its spawn contract.
// It never opens the real CLI, credential files, Keychain, or a network service.
const FAKE_CLI = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME, ".claude");
const auth = JSON.parse(readFileSync(join(configDir, "fixture-auth.json"), "utf8"));
const keys = ${JSON.stringify(CLAUDE_ACCOUNT_ENV_KEYS)};
appendFileSync(join(configDir, "calls.ndjson"), JSON.stringify({
  args, configDir, home: process.env.HOME,
  env: Object.fromEntries(keys.map(key => [key, process.env[key]]))
}) + "\\n");
const out = value => process.stdout.write(JSON.stringify(value) + "\\n");
if (args[0] === "--version") { console.log("fixture-claude"); process.exit(0); }
if (args[0] === "auth") { out(auth); process.exit(auth.loggedIn ? 0 : 1); }
if (args.includes("text")) {
  process.stdin.resume();
  process.stdin.on("end", () => console.log(auth.email));
} else {
  createInterface({ input: process.stdin }).on("line", () => {
    out({ type: "system", subtype: "init", session_id: auth.email });
    out({ type: "assistant", message: { content: [{ type: "text", text: auth.email }] } });
    out({ type: "result", subtype: "success", result: auth.email, session_id: auth.email, usage: {} });
  });
}
`;

let scratch: string;
let cli: string;
const instances: ProviderInstance[] = [];

function account(name: string, auth: unknown = { loggedIn: true, email: `${name}@example.test`, orgName: `${name} team` }) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fixture-auth.json"), JSON.stringify(auth));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ customModels: [`${name}-model`] }));
  return dir;
}

async function create(configDir?: string, environment: Record<string, string> = {}) {
  const instance = await ClaudeDriver.create({
    instanceId: `claude-${instances.length}`,
    displayName: "Fixture Claude",
    enabled: true,
    config: { cli, configDir, permissionMode: "acceptEdits" },
    environment,
  });
  instances.push(instance);
  return instance;
}

function calls(dir: string): Array<{ args: string[]; configDir: string; home: string; env: NodeJS.ProcessEnv }> {
  return readFileSync(join(dir, "calls.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}

beforeEach(() => {
  ensureDirs();
  scratch = mkdtempSync(join(tmpdir(), "omb-claude-accounts-"));
  cli = join(scratch, "fake-claude.mjs");
  writeFileSync(cli, FAKE_CLI, { mode: 0o755 });
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  for (const key of CLAUDE_ACCOUNT_ENV_KEYS) vi.stubEnv(key, `fixture-parent-${key}`);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("offline fixture", { status: 503 })));
});

afterEach(async () => {
  await Promise.all(instances.splice(0).map(instance => instance.dispose()));
  await removeTempDir(scratch);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Claude account configuration", () => {
  it("keeps the default config unchanged and resolves explicit, inherited, and home-relative directories", () => {
    const home = join(scratch, "home");
    expect(ClaudeDriver.decodeConfig({ configDir: " " })).toEqual(ClaudeDriver.defaultConfig());
    expect(ClaudeDriver.decodeConfig({ configDir: " ~/work " }).configDir).toBe("~/work");
    expect(resolveClaudeConfigDir("~/work", { HOME: home })).toBe(join(home, "work"));
    expect(resolveClaudeConfigDir("~", { USERPROFILE: home })).toBe(home);
    expect(resolveClaudeConfigDir(undefined, { HOME: home })).toBe(join(home, ".claude"));
    expect(resolveClaudeConfigDir("", { HOME: home, CLAUDE_CONFIG_DIR: "~/inherited" })).toBe(join(home, "inherited"));
    expect(resolveClaudeConfigDir(join(scratch, "explicit"), { CLAUDE_CONFIG_DIR: join(scratch, "ignored") })).toBe(join(scratch, "explicit"));
    for (const configDir of [12, null, "relative/path", "~other/work", "/bad\npath"]) {
      expect(() => ClaudeDriver.decodeConfig({ configDir })).toThrow(/configDir/);
    }
  });

  it("isolates two concurrent instances across catalogs, auth probes, turns, and permission reviews", async () => {
    const dirs = [account("work"), account("personal")];
    vi.stubEnv("CLAUDE_CONFIG_DIR", account("parent"));
    const providers = await Promise.all(dirs.map(dir => create(dir)));
    await Promise.all(providers.map(async (provider, index) => {
      const name = index === 0 ? "work" : "personal";
      expect(provider.models.options.some(option => option.id === `${name}-model`)).toBe(true);
      expect(provider.models.options.some(option => option.id === `${index === 0 ? "personal" : "work"}-model`)).toBe(false);
      expect(await provider.snapshot()).toMatchObject({ authenticated: true, account: { email: `${name}@example.test`, organization: `${name} team` } });
      const recorder = recordEvents(provider.adapter);
      await provider.adapter.sendTurn({ threadId: `account-${name}`, text: "hello" });
      await recorder.until(event => event.type === "turn.completed");
      expect(recorder.events.some(event => event.type === "item.completed" && event.itemType === "assistant_text" && event.text === `${name}@example.test`)).toBe(true);
      recorder.stop();
      expect(await provider.reviewPermission?.("review fixture only")).toBe(`${name}@example.test`);
      const recorded = calls(dirs[index]!);
      expect(recorded).toHaveLength(4);
      for (const call of recorded) {
        expect(call.configDir).toBe(dirs[index]);
        expect(call.home).toBe(process.env.HOME);
        expect(call.env).toEqual({});
      }
    }));
  });

  it("honors the existing environment account when configDir is absent", async () => {
    const dir = account("existing");
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
    const provider = await create();
    expect(provider.models.options.some(option => option.id === "existing-model")).toBe(true);
    expect(await provider.generateText?.("fixture review")).toBe("existing@example.test");
    expect(calls(dir)[0]?.env.ANTHROPIC_AUTH_TOKEN).toBe("fixture-parent-ANTHROPIC_AUTH_TOKEN");
    expect(calls(dir)[0]?.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("preserves explicit custom endpoints and injected local models without inheriting subscription OAuth", async () => {
    const dir = account("custom");
    const provider = await create(dir, {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9999",
      ANTHROPIC_AUTH_TOKEN: "fixture-custom-key",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-explicit-oauth-is-not-an-account-login",
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "99",
      UNSLOTH_STUDIO_AUTH_TOKEN: "fixture-local-key",
    });
    await provider.reviewPermission?.("fixture review");
    expect(calls(dir)[0]?.env).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:9999", ANTHROPIC_AUTH_TOKEN: "fixture-custom-key" });
    const recorder = recordEvents(provider.adapter);
    await provider.adapter.sendTurn({ threadId: "account-injected", text: "hello", model: "unsloth::fixture-model" });
    await recorder.until(event => event.type === "turn.completed");
    recorder.stop();
    expect(calls(dir)[1]?.env).toEqual({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8888",
      ANTHROPIC_AUTH_TOKEN: "fixture-local-key",
      ANTHROPIC_API_KEY: "fixture-local-key",
    });
  });

  it("publishes only bounded display identity from a successful auth status", async () => {
    const dir = account("identity", {
      loggedIn: true, email: " person@example.test ", orgName: " Team ",
      accessToken: "must-not-appear", refreshToken: "must-not-appear", extra: { secret: "must-not-appear" },
    });
    const provider = await create(dir);
    expect(await provider.snapshot()).toEqual({
      state: "available", version: "fixture-claude", authenticated: true,
      account: { email: "person@example.test", organization: "Team" }, billing: "subscription",
    });
    for (const auth of [
      { loggedIn: false, email: "person@example.test", orgName: "Team" },
      { loggedIn: true, email: "not an email", orgName: { secret: "no" } },
      { loggedIn: true, email: "a".repeat(255) + "@example.test", orgName: "a".repeat(161) },
      { loggedIn: true, email: "person\n@example.test", orgName: "hidden\u202ename" },
    ]) {
      writeFileSync(join(dir, "fixture-auth.json"), JSON.stringify(auth));
      expect(await provider.snapshot()).not.toHaveProperty("account");
    }
  });
});
