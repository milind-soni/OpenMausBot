import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { addressHere, answerConnection, KEY_PROVIDERS, launcherOf, listConnections, releaseConnection, runsHere, signInDigest } from "./cloud-connections.ts";
import type { AppConfig } from "./config.ts";
import type { HighLevelConnection } from "./highlevel/store.ts";
import type { McpOAuthRecord } from "./mcp-oauth-store.ts";
import type { StoredMcpServer } from "./mcp-registry.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "omb-connections-")); dirs.push(dir); return dir; };

const stdio = (command: string, args: string[] = [], env: Record<string, string> = {}): StoredMcpServer => ({ command, args, env, enabled: true });
const remote = (url: string, extra: Partial<StoredMcpServer> = {}): StoredMcpServer => ({ type: "http", url, headers: {}, enabled: true, ...extra } as StoredMcpServer);
const record = (tokens: McpOAuthRecord["tokens"], state: McpOAuthRecord["state"] = "signed-in"): McpOAuthRecord =>
  ({ url: "https://mcp.linear.app/sse", state, clientId: "client", tokenEndpoint: "https://linear.app/token", ...(tokens ? { tokens } : {}) });
const HIGHLEVEL: HighLevelConnection = { kind: "oauth", accessToken: "hl-access", refreshToken: "hl-refresh", expiresAt: 5, locationId: "loc_1", scopes: "", connectedAt: 1, state: "signed-in" };

describe("which MCP servers need this computer", () => {
  it("a program by path, a file or folder of this computer, or an address only it reaches", () => {
    const home = temp();
    writeFileSync(join(home, "notes.db"), "");
    expect(runsHere(stdio("npx", ["-y", "dodopayments-mcp"], { DODO_PAYMENTS_API_KEY: "x" }))).toBe(false);
    expect(runsHere(stdio("uvx", ["mcp-server-fetch"]))).toBe(false);
    for (const server of [stdio("/usr/local/bin/notes-mcp"), stdio("./server.js"), stdio("C:\\Tools\\mcp.exe"), stdio("node", [join(home, "notes.db")]),
      stdio("node", [`--db=${join(home, "notes.db")}`]), stdio("npx", ["-y", "server-filesystem", "~/Documents"]), stdio("npx", ["pkg"], { CONFIG: join(home, "notes.db") })]) {
      expect(runsHere(server), JSON.stringify(server)).toBe(true);
    }
    expect(runsHere(stdio("npx", ["pkg", "/api/v1"])), "an absolute-looking argument that is no file here is not this computer's").toBe(false);
    for (const url of ["http://localhost:3845/mcp", "http://127.0.0.1:9/mcp", "http://[::1]:8080/sse", "http://192.168.1.20/mcp", "http://10.0.0.5/mcp",
      "http://172.20.0.2/mcp", "http://100.101.5.9/mcp", "https://box.tail1234.ts.net/mcp", "http://printer.local/mcp", "http://nas/mcp"]) {
      expect(addressHere(url), url).toBe(true);
      expect(runsHere(remote(url)), url).toBe(true);
    }
    expect(runsHere(remote("https://mcp.dodopayments.com/sse"))).toBe(false);
    expect(addressHere("https://172.32.0.1/mcp")).toBe(false);
  });

  it("names the program a command-line server starts", () => {
    expect(["npx", "/opt/homebrew/bin/uvx", "C:\\Program Files\\nodejs\\node.EXE", "npx.cmd"].map(launcherOf)).toEqual(["npx", "uvx", "node", "npx"]);
  });
});

describe("what GET /api/cloud-connections names", () => {
  const sources = (config: AppConfig, extra: Partial<Parameters<typeof listConnections>[0]> = {}) => ({
    config, mcpAuth: () => "none" as const, composio: null, highlevel: () => null, ...extra,
  });

  it("each connection by name, with what moves it, and never a secret", () => {
    const config = {
      mcpServers: {
        dodo: { command: "npx", args: ["-y", "dodopayments-mcp", "--api-key=sk_live_fake"], env: { DODO_PAYMENTS_API_KEY: "dodo_live_fake" } },
        linear: { type: "http", url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer linear_fake" } },
        notes: { type: "http", url: "http://127.0.0.1:9/mcp" },
        broken: { command: "" },
      },
      openrouter: { key: "sk-or-fake" }, anthropic: { key: "sk-ant-fake", everyClaudeBot: true }, elevenlabs: { key: "voice-fake" },
    } as unknown as AppConfig;
    const listed = listConnections(sources(config, { mcpAuth: (name) => (name === "linear" ? "signed-in" : "none"),
      composio: { mode: "managed", account: "managed:abc", installationId: "11111111-2222-4333-8444-555555555555", shared: false },
      highlevel: () => HIGHLEVEL }));
    expect(listed).toEqual([
      { id: "mcp:dodo", kind: "mcp", label: "dodo", detail: "npx dodopayments-mcp", launcher: "npx" },
      { id: "mcp:linear", kind: "mcp", label: "linear", detail: "mcp.linear.app", signIn: true },
      { id: "mcp:notes", kind: "mcp", label: "notes", detail: "127.0.0.1:9", runsHere: true },
      { id: "key:openrouter", kind: "key", label: "OpenRouter", for: ["openrouter"] },
      { id: "key:anthropic", kind: "key", label: "Anthropic", for: ["claudeApi"] },
      { id: "composio", kind: "composio", label: "Connected apps", mode: "managed", account: "managed:abc", installationId: "11111111-2222-4333-8444-555555555555" },
      { id: "highlevel", kind: "highlevel", label: "HighLevel", signIn: true },
    ]);
    const text = JSON.stringify(listed);
    for (const secret of ["dodo_live_fake", "sk-or-fake", "sk-ant-fake", "sk_live_fake", "linear_fake", "voice-fake", "hl-access", "hl-refresh"]) expect(text).not.toContain(secret);
    expect(listConnections(sources({} as AppConfig, { highlevel: () => ({ ...HIGHLEVEL, kind: "token", refreshToken: undefined }) }))).toEqual([{ id: "highlevel", kind: "highlevel", label: "HighLevel" }]);
  });

  it("an Anthropic key serves Claude (API key) alone there, never Claude bots that sign in with an account", () => {
    expect(KEY_PROVIDERS.find((provider) => provider.id === "anthropic")!.config({ anthropic: { key: "k", everyClaudeBot: true } } as AppConfig))
      .toEqual({ anthropic: { key: "k", everyClaudeBot: false } });
  });
});

describe("what the private port hands over, and lets go of", () => {
  const config = { mcpServers: {
    linear: { type: "http", url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer h" }, oauth: { clientId: "client", clientSecret: "app-secret" } },
    notes: { type: "http", url: "http://localhost:9/mcp" },
  }, openrouter: { key: "sk-or-fake" }, composio: { apiKey: "ck_fake", userId: "u_1" } } as unknown as AppConfig;
  const tokens = { access: "access-1", refresh: "refresh-1", expiresAt: 10 };

  it("a server with its secrets and its sign-in, and the digest of that sign-in", () => {
    const answer = answerConnection("mcp:linear", { config, mcpSignIn: () => record(tokens), highlevel: () => null });
    expect(answer).toEqual({ ok: true, digest: signInDigest(tokens), connection: { mcp: { name: "linear", signIn: record(tokens),
      server: { type: "http", url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer h" }, oauth: { clientId: "client", clientSecret: "app-secret" }, enabled: true } } } });
    // A sign-in that needs signing in again, or a server that runs here, hands over no sign-in.
    expect(answerConnection("mcp:linear", { config, mcpSignIn: () => record(undefined, "needs-sign-in"), highlevel: () => null })).not.toHaveProperty("digest");
    const here = answerConnection("mcp:notes", { config, mcpSignIn: () => ({ ...record(tokens), url: "http://localhost:9/mcp" }), highlevel: () => null });
    expect(here).toMatchObject({ ok: true, connection: { mcp: { name: "notes" } } });
    expect(here).not.toHaveProperty("digest");
    expect(JSON.stringify(here)).not.toContain("refresh-1");
  });

  it("a key, the person's own Composio project and HighLevel, each as My Cloud's routes take them", () => {
    const sources = { config, mcpSignIn: () => undefined, highlevel: () => HIGHLEVEL };
    expect(answerConnection("key:openrouter", sources)).toEqual({ ok: true, connection: { config: { openrouter: { key: "sk-or-fake" } } } });
    expect(answerConnection("key:openai", sources)).toEqual({ ok: false, error: "This key is no longer saved on this computer." });
    expect(answerConnection("composio", sources)).toEqual({ ok: true, connection: { composio: { apiKey: "ck_fake", userId: "u_1" } } });
    expect(answerConnection("highlevel", sources)).toMatchObject({ ok: true, connection: { highlevel: HIGHLEVEL }, digest: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(answerConnection("highlevel", { ...sources, highlevel: () => ({ ...HIGHLEVEL, kind: "token" }) })).not.toHaveProperty("digest");
    expect(answerConnection("mcp:gone", sources)).toEqual({ ok: false, error: "This MCP server is no longer on this computer." });
  });

  it("lets go of a sign-in only while it is the one My Cloud took: one that refreshed since is said to have changed", () => {
    const forgot: string[] = [];
    let current = record(tokens);
    let highlevel: HighLevelConnection | null = HIGHLEVEL;
    const sources = { config, mcpSignIn: () => current, highlevel: () => highlevel,
      forgetSignIn: (name: string) => { forgot.push(name); }, forgetHighLevel: () => { forgot.push("highlevel"); highlevel = null; } };
    const moved = signInDigest(tokens);
    current = record({ ...tokens, access: "access-2", refresh: "refresh-2" });
    expect(releaseConnection("mcp:linear", moved, sources)).toEqual({ ok: true, release: { changed: true } });
    expect(forgot).toEqual([]);
    current = record(tokens);
    expect(releaseConnection("mcp:linear", moved, sources)).toEqual({ ok: true, release: { released: true } });
    expect(forgot).toEqual(["linear"]);
    const highlevelDigest = (answerConnection("highlevel", sources) as { digest: string }).digest;
    expect(releaseConnection("highlevel", "0".repeat(64), sources)).toEqual({ ok: true, release: { changed: true } });
    expect(releaseConnection("highlevel", highlevelDigest, sources)).toEqual({ ok: true, release: { released: true } });
    expect(forgot).toEqual(["linear", "highlevel"]);
    expect(releaseConnection("key:openrouter", moved, sources)).toEqual({ ok: false, error: "Only a sign-in that moved is let go of." });
  });
});
