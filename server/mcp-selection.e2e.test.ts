import { request } from "node:http";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const FAKE_MCP = fileURLToPath(new URL("./testing/fake-mcp-server.ts", import.meta.url));
const command = { command: process.execPath, args: ["--experimental-strip-types", FAKE_MCP] };
type Bot = { id: string; threadId: string; mcpServers?: string[] };
type Dump = { pid: number; systemPrompt: string | null; mcpConfig: { mcpServers: Record<string, unknown> } };

async function withFixture(mode: string, run: (helpers: {
  api: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
  control: (args: string[]) => Promise<any>;
  dump: () => Promise<Dump>;
  clearDump: () => void;
  url: string;
  evidence: unknown[];
}) => Promise<void>) {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: mode });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  try {
    await run({
      url: fixture.info.url,
      evidence,
      api: async (method, path, body, headers = {}) => {
        const response = await fetch(`${fixture.info.url}${path}`, {
          method, headers: { "content-type": "application/json", ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const result = { status: response.status, body: await response.json() };
        // Session responses contain bearer tokens; retain only their status.
        evidence.push({ method, path, status: result.status, ...(path.startsWith("/api/auth/") ? {} : { body: result.body }) });
        return result;
      },
      control: async (args) => {
        const result = await runControlOmb([...args, "--url", fixture.info.url]);
        evidence.push({ command: args, result });
        return result;
      },
      dump: async () => {
        await expect.poll(() => existsSync(fixture.fixtureDumpPath), { timeout: 15_000 }).toBe(true);
        const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as Dump;
        evidence.push({ mounted: Object.keys(dump.mcpConfig.mcpServers), pid: dump.pid, system: dump.systemPrompt });
        return dump;
      },
      clearDump: () => rmSync(fixture.fixtureDumpPath, { force: true }),
    });
  } finally {
    await fixture.close();
    const evidencePath = `${fixture.info.logPath}.mcp-selection.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    expect(existsSync(fixture.info.dataDir)).toBe(false);
    console.info(JSON.stringify({ ...fixture.info, evidencePath, fixtureRemoved: true, exitCode: fixture.child.exitCode }));
  }
}

it("imports atomically and mounts the selected MCP servers in fresh direct and room sessions", async () => {
  await withFixture("happy", async ({ api, control, dump, clearDump }) => {
    const secret = "fixture-only-mcp-secret";
    const imported = await api("POST", "/api/mcp/servers/import", { json: JSON.stringify({ mcpServers: {
      notes: { ...command, enabled: true, env: { TOKEN: secret } },
      constructor: command,
    } }) });
    expect(imported.status).toBe(201);
    expect(imported.body.servers).toEqual([
      expect.objectContaining({ name: "notes", enabled: false, envKeys: ["TOKEN"] }),
      expect.objectContaining({ name: "constructor", enabled: false, envKeys: [] }),
    ]);
    expect(JSON.stringify(imported.body)).not.toContain(secret);
    const before = (await api("GET", "/api/mcp/servers")).body;
    expect((await api("POST", "/api/mcp/servers/import", { json: JSON.stringify({ newone: command, notes: command }) })).status).toBe(409);
    expect((await api("POST", "/api/mcp/servers/import", { json: JSON.stringify({ newone: command, bad: { url: "https://invalid.example/mcp" } }) })).status).toBe(400);
    expect((await api("GET", "/api/mcp/servers")).body).toEqual(before);
    expect((await api("POST", "/api/mcp/servers/notes/test")).body).toMatchObject({ ok: true, tools: [{ name: "read_notes" }] });
    const { bot } = await control(["new-bot", "--name", "MCP fixture"]) as { bot: Bot };
    const selected = async (mcpServers: string[] | null) => {
      expect((await api("PATCH", `/api/bots/${bot.id}`, { mcpServers })).status).toBe(200);
    };
    const turn = async (expected: string[]) => {
      clearDump();
      await control(["send", "--bot", bot.id, "--text", "Reply briefly."]);
      const mounted = await dump();
      expect(Object.keys(mounted.mcpConfig.mcpServers).filter((name) => ["notes", "constructor"].includes(name))).toEqual(expected);
      expect((await control(["wait", "--bot", bot.id, "--timeout", "30"])).status).toBe("settled");
      return mounted;
    };
    // Import alone grants nothing, even when the source requested enabled.
    await turn([]);
    for (const name of ["notes", "constructor"]) expect((await api("PATCH", `/api/mcp/servers/${name}`, { enabled: true })).status).toBe(200);
    await selected(["notes"]);
    const first = await turn(["notes"]);
    expect(first.systemPrompt).toContain('an MCP server for you: "notes"');
    await selected([]);
    const removed = await turn([]);
    expect(removed.pid).not.toBe(first.pid);
    expect(removed.systemPrompt).not.toContain("MCP server for you");
    await selected(null);
    expect((await turn(["notes", "constructor"])).pid).not.toBe(removed.pid);
    await selected(["constructor"]);
    const { channel } = await control(["new-channel", "--name", "MCP room", "--members", bot.id]);
    clearDump();
    await control(["send-channel", "--channel", channel.id, "--text", "Reply once."]);
    const room = await dump();
    expect(Object.keys(room.mcpConfig.mcpServers)).toContain("constructor");
    expect(Object.keys(room.mcpConfig.mcpServers)).not.toContain("notes");
    expect(room.systemPrompt).toContain('an MCP server for you: "constructor"');
    expect((await control(["wait", "--channel", channel.id, "--timeout", "30"])).status).toBe("settled");
    await control(["messages", "--channel", channel.id, "--limit", "10"]);
  });
}, 90_000);

it("validates MCP grants, refuses live changes and client sessions, and rechecks delayed imports after revocation", async () => {
  await withFixture("hang", async ({ api, control, dump, clearDump, url, evidence }) => {
    const { bot } = await control(["new-bot", "--name", "Working fixture"]) as { bot: Bot };
    const { bot: idle } = await control(["new-bot", "--name", "Idle fixture"]) as { bot: Bot };
    for (const mcpServers of ["notes", [""], ["bad.name"], ["agents"], [1], Array.from({ length: 21 }, (_, i) => `server-${i}`)]) {
      expect((await api("PATCH", `/api/bots/${bot.id}`, { mcpServers })).status).toBe(400);
    }
    expect((await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: ["notes", "notes"] })).body.bot.mcpServers).toEqual(["notes"]);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { title: "Unrelated edit" })).body.bot.mcpServers).toEqual(["notes"]);
    expect((await api("PATCH", `/api/bots/${idle.id}`, { mcpServers: [] })).status).toBe(200);
    const pair = async (scopes: string[]) => {
      const opened = await api("POST", "/api/auth/pairing", { scopes });
      return (await api("POST", "/api/auth/pair", { code: opened.body.code, label: "Fixture client" })).body;
    };
    const client = await pair(["client"]);
    const clientHeaders = { authorization: `Bearer ${client.token}` };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: [] }, clientHeaders)).status).toBe(403);
    expect((await api("POST", "/api/mcp/servers/import", { json: "{}" }, clientHeaders)).status).toBe(403);
    await control(["send", "--bot", bot.id, "--text", "Stay active."]);
    await dump();
    expect((await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: [] }, { origin: url })).status).toBe(409);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: ["notes"] }, { origin: url })).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${idle.id}`, { mcpServers: null })).status).toBe(409);
    // The authenticated same-origin UI may grant an idle bot access.
    expect((await api("PATCH", `/api/bots/${idle.id}`, { mcpServers: ["notes"] }, { origin: url })).status).toBe(200);
    await control(["interrupt", "--bot", bot.id]);
    // Stopping a deliberately hung provider can report failed rather than a
    // completed reply; the permission boundary requires the turn to be idle.
    expect((await control(["wait", "--bot", bot.id, "--timeout", "30"])).target.busy).toBe(false);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: [] })).status).toBe(200);
    const { channel } = await control(["new-channel", "--name", "Working room", "--members", bot.id]);
    clearDump();
    await control(["send-channel", "--channel", channel.id, "--text", "Stay active in the room."]);
    await dump();
    expect((await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: ["notes"] }, { origin: url })).status).toBe(409);
    await control(["interrupt", "--channel", channel.id]);
    await control(["wait", "--channel", channel.id, "--timeout", "30"]);
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((row: Bot) => row.id === bot.id)?.busy).toBe(false);
    const admin = await pair(["client", "admin"]);
    const body = JSON.stringify({ json: JSON.stringify({ late: command }) });
    let finishBody!: () => void;
    const lateResponse = new Promise<number>((resolve, reject) => {
      const req = request(`${url}/api/mcp/servers/import`, {
        method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: `Bearer ${admin.token}` },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
      req.on("error", reject);
      req.write(body.slice(0, 1));
      finishBody = () => req.end(body.slice(1));
    });
    try {
      // The import mutex proves the first request authenticated and entered
      // its body reader before its session is revoked.
      await expect.poll(async () => (await api("POST", "/api/mcp/servers/import", { json: "{}" })).status).toBe(409);
      expect((await api("DELETE", `/api/auth/sessions/${admin.session.id}`)).status).toBe(200);
    } finally {
      finishBody();
    }
    const lateStatus = await lateResponse;
    evidence.push({ method: "POST", path: "/api/mcp/servers/import", status: lateStatus, revokedDuringBody: true });
    expect(lateStatus).toBe(401);
    expect((await api("GET", "/api/mcp/servers")).body.servers).toEqual([]);
  });
}, 60_000);
