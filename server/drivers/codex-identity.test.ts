import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { codexAccountEmail, codexHome } from "./codex-identity.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");
const BELL = String.fromCharCode(7);

describe("Codex account identity", () => {
  let home: string;
  const env = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
    FAKE_CODEX_DUMP: join(home, "calls.json"), ...extra,
  });
  const calls = () => JSON.parse(readFileSync(join(home, "calls.json"), "utf8"));
  const expectStopped = () => {
    expect(() => process.kill(calls().pid, 0)).toThrow();
  };
  const staleFile = () => {
    const claims = Buffer.from(JSON.stringify({ email: "stale-file@example.test" })).toString("base64url");
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({
      OPENAI_API_KEY: "sk-synthetic-fixture",
      tokens: { id_token: "header." + claims + ".synthetic", access_token: "synthetic-access", refresh_token: "synthetic-refresh" },
    }));
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omb-codex-identity-"));
    mkdirSync(join(home, ".codex"));
    chmodSync(FAKE_CLI, 0o755);
  });
  afterEach(async () => { await removeTempDir(home); });

  it("asks the configured CLI for its account without refreshing tokens and waits for cleanup", async () => {
    expect(await codexAccountEmail(FAKE_CLI, env())).toBe("ada@example.test");
    expect(calls().argv).toEqual(["app-server"]);
    expect(calls().calls).toEqual([
      { method: "initialize", params: { clientInfo: { name: "openmausbot", version: "1" } } },
      { method: "initialized", params: {} },
      { method: "account/read", params: { refreshToken: false } },
    ]);
    expect(calls().env.CODEX_HOME).toBe(join(home, ".codex"));
    expectStopped();
  });

  it("uses the CLI's keyring identity rather than an inactive auth.json", async () => {
    staleFile();
    writeFileSync(join(home, ".codex", "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    expect(await codexAccountEmail(FAKE_CLI, env({ FAKE_CODEX_ACCOUNT_EMAIL: "keyring-account@example.test" }))).toBe("keyring-account@example.test");
    expectStopped();
  });

  it.each(["api-key", "none", "unsupported", "error"])("does not expose a stale file email when account/read reports %s", async (mode) => {
    staleFile();
    expect(await codexAccountEmail(FAKE_CLI, env({ FAKE_CODEX_ACCOUNT_MODE: mode }))).toBeNull();
    expectStopped();
  });

  it.each(["not an email", "ada" + BELL + "@example.test", "a".repeat(250) + "@example.test", ""])("rejects an unsafe email %j", async (email) => {
    expect(await codexAccountEmail(FAKE_CLI, env({ FAKE_CODEX_ACCOUNT_EMAIL: email }))).toBeNull();
    expectStopped();
  });

  it("refuses relative homes and quietly handles missing executables", async () => {
    expect(codexHome({ HOME: home })).toBe(join(home, ".codex"));
    expect(codexHome({ HOME: home, CODEX_HOME: "relative" })).toBeNull();
    expect(await codexAccountEmail(FAKE_CLI, { HOME: home, CODEX_HOME: "relative" })).toBeNull();
    expect(await codexAccountEmail(FAKE_CLI, { HOME: "relative" })).toBeNull();
    expect(await codexAccountEmail(join(home, "missing-codex"), env())).toBeNull();
  });

  it("bounds a hung account request and reaps its process", async () => {
    expect(await codexAccountEmail(FAKE_CLI, env({ FAKE_CODEX_ACCOUNT_MODE: "hang" }), 1_000)).toBeNull();
    expectStopped();
  });

  it.each(["malformed", "oversized", "secret-error", "stubborn"])("fails quietly and cleans up %s CLI output", async (mode) => {
    const cli = join(home, "edge-cli.mjs");
    writeFileSync(cli, [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(process.env.FAKE_CODEX_DUMP, JSON.stringify({ pid: process.pid }));',
      'if (process.env.EDGE_MODE === "stubborn") process.on("SIGTERM", () => {});',
      'let buffer = "";',
      'process.stdin.on("data", chunk => {',
      '  buffer += chunk;',
      '  let n;',
      '  while ((n = buffer.indexOf("\\n")) >= 0) {',
      '    const message = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);',
      '    if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");',
      '    if (message.method !== "account/read") continue;',
      '    process.stderr.write("synthetic-private-token-must-not-escape");',
      '    if (process.env.EDGE_MODE === "malformed") process.stdout.write("not-json\\n");',
      '    if (process.env.EDGE_MODE === "oversized") process.stdout.write("x".repeat(20_000));',
      '    if (process.env.EDGE_MODE === "secret-error") process.stdout.write(JSON.stringify({ id: message.id, error: { message: "synthetic-private-token-must-not-escape" } }) + "\\n");',
      '  }',
      '});',
    ].join("\n"));
    chmodSync(cli, 0o755);
    expect(await codexAccountEmail(cli, env({ EDGE_MODE: mode }), 1_000)).toBeNull();
    expectStopped();
  });
});
