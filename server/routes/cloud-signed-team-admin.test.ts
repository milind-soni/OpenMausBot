import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { createCloudHealth } from "../cloud-health.ts";
import { cloudRequestSignature } from "../cloud-home.ts";
import { CLOUD_TEAM_ADMIN_PATH, teamAdminSummary, type TeamAdminSummary } from "../cloud-team-admin.ts";
import { DATA_DIR } from "../config.ts";
import { SessionRegistry } from "../sessions.ts";
import { createCloudSignedRoutes } from "./cloud-signed.ts";

const secret = "S".repeat(43);
const team = { id: "team-7f3a", name: "Acme" };
const summary: TeamAdminSummary = teamAdminSummary({
  apps: { gmail: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_1", alias: "team@acme.test", status: "ACTIVE" }] }, slack: { connected: false, pending: false, status: "not_connected", accounts: [] } },
  mcp: [{ name: "linear", type: "http", url: "https://mcp.linear.app/sse?token=never-shown", headerKeys: ["Authorization"], enabled: true, auth: "signed-in" },
    { name: "files", command: "npx", envKeys: ["FILES_TOKEN"], enabled: false }],
  status: { treg: { configured: true }, xai: { configured: false }, anthropic: { configured: true, everyClaudeBot: true }, openai: { configured: false }, openrouter: { configured: false } },
  voice: { key: false, included: true },
  engines: [{ instanceId: "claude", name: "Claude", snapshot: { state: "available", authenticated: true, account: { email: "mira@gmail.com", method: "login" } } },
    { instanceId: "codex", name: "Codex", snapshot: { state: "available", authenticated: false } }, { instanceId: "gone", name: "Gone", snapshot: { state: "unavailable" } }],
});

function routes(options: { team?: typeof team | null } = {}) {
  let counter = 0;
  const now = () => 1_800_000_000_000;
  const sessions = new SessionRegistry({ file: join(DATA_DIR, "sessions.json"), now });
  const health = createCloudHealth({
    store: { onChange: () => () => {}, botByThread: () => null, bots: [] }, bus: { subscribe: () => () => {} },
    engines: () => [], dataDir: DATA_DIR, eventsDir: DATA_DIR, version: "0.1.0", image: undefined, connectors: () => null,
    browser: () => ({ available: true, installing: false, interrupted: 0 }), now,
  });
  const handle = createCloudSignedRoutes({ secret, sessions, health, now, team: options.team === undefined ? team : options.team, teamAdmin: { summary: async () => summary } });
  const sign = (method: string, body = "", key = secret) => {
    const timestamp = String(Math.floor(now() / 1000)), nonce = `nonce-${String(++counter).padStart(12, "0")}`;
    return { "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudRequestSignature(key, timestamp, nonce, method, CLOUD_TEAM_ADMIN_PATH, body)}` };
  };
  const send = async (method: string, headers: Record<string, string>, body = "") => {
    const req = Object.assign(new PassThrough(), { method, url: CLOUD_TEAM_ADMIN_PATH, headers, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;
    let status = 0, text = "";
    const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(data: string) { text = data; } } as unknown as ServerResponse;
    const url = new URL(CLOUD_TEAM_ADMIN_PATH, "http://localhost");
    const answered = handle({ req, res, url, path: url.pathname, method });
    (req as unknown as PassThrough).end(body);
    return { answered: await answered, status, body: text ? JSON.parse(text) : null };
  };
  return { send, sign };
}

describe("the Team admin's signed read and changes", () => {
  it("the summary says names, states and identities only: never a key, header, environment value or any part of an MCP address but its host", () => {
    expect(summary).toEqual({
      v: 1,
      apps: { available: true, services: [{ slug: "gmail", status: "ACTIVE", accounts: [{ id: "ca_1", alias: "team@acme.test", status: "ACTIVE" }] }] },
      mcp: [{ name: "linear", transport: "http", host: "mcp.linear.app", enabled: true, signedIn: true, secrets: ["Authorization"] },
        { name: "files", transport: "stdio", host: null, enabled: false, signedIn: null, secrets: ["FILES_TOKEN"] }],
      keys: [{ id: "treg", configured: true }, { id: "voice", configured: false, included: true }],
      ai: { keys: [{ id: "anthropic", configured: true }, { id: "openai", configured: false }, { id: "openrouter", configured: false }],
        engines: [{ id: "claude", name: "Claude", authenticated: true, account: { email: "mira@gmail.com", organization: null, method: "login" } }, { id: "codex", name: "Codex", authenticated: false, account: null }] },
    });
    expect(JSON.stringify(summary)).not.toMatch(/never-shown|token=|sse\?/);
    expect(teamAdminSummary({ apps: null, mcp: [], status: {}, voice: { key: true, included: false }, engines: [] })).toMatchObject({ apps: { available: false, services: [] }, keys: [{ id: "treg", configured: false }, { id: "voice", configured: true }] });
  });

  it("answers the Admin's signed read on a Team Cloud, and refuses a wrong key, a replay and an unsigned read", async () => {
    const { send, sign } = routes();
    const read = await send("GET", sign("GET"));
    expect([read.answered, read.status, read.body]).toEqual([true, 200, summary]);
    expect((await send("GET", sign("GET", "", "W".repeat(43)))).status).toBe(401);
    expect((await send("GET", {})).status).toBe(401);
    const once = sign("GET");
    expect((await send("GET", once)).status).toBe(200);
    expect((await send("GET", once)).body).toEqual({ error: "replayed_request" });
  });

  it("is no route at all on a My Cloud", async () => {
    const { send, sign } = routes({ team: null });
    expect((await send("GET", sign("GET"))).answered).toBe(false);
  });

  it("answers only a read: the Admin changes things with an admin's own session, through the routes the app uses", async () => {
    const { send, sign } = routes();
    expect((await send("POST", { ...sign("POST"), "content-type": "application/json" }, "")).status).toBe(405);
  });
});
