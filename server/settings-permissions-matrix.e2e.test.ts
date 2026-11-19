import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { WireBot } from "../shared/wire.ts";

import { launchVerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { startFakeConnectedApps } from "./testing/fake-connected-apps.ts";

const FAKE_MCP = fileURLToPath(new URL("./testing/fake-mcp-server.ts", import.meta.url));

type PermissionPatch = {
  [K in "composio" | "connectorScopes" | "connectorTools" | "mcpServers"]?: WireBot[K] | null;
};
type BotReply = { bot: WireBot };
type ToolReply = { result: { isError?: boolean; content: { text: string }[] } };
type FixtureDump = {
  prompt: unknown;
  mcpConfig: { mcpServers: Record<string, { env: Record<string, string> }> };
};

it("persists independent bot app/MCP API grants and enforces them on isolated turns", async () => {
  const apps = await startFakeConnectedApps();
  let scratch: string | undefined;
  let launched: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  const evidence: unknown[] = [];
  try {
    scratch = mkdtempSync(join(tmpdir(), "omb-permissions-matrix-"));
    const gate = join(scratch, "finish");
    const fixture = await launchVerificationServer({
      OMB_COMPOSIO_BROKER_URL: apps.url, OMB_COMPOSIO_BROKER_TOKEN: apps.token,
      FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate,
    });
    launched = fixture;
    const api = async <T = unknown>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, expected = 200, token?: string): Promise<T> => {
      const response = await fetch(fixture.info.url + path, {
        method, headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json() as Partial<BotReply & ToolReply>;
      evidence.push({ method, path, status: response.status,
        ...(method === "PATCH" && /^\/api\/bots\/[^/]+$/.test(path) ? { patch: body, saved: result.bot && {
          id: result.bot.id, composio: result.bot.composio, connectorScopes: result.bot.connectorScopes,
          connectorTools: result.bot.connectorTools, mcpServers: result.bot.mcpServers,
        } } : {}),
        ...(path === "/api/internal/connectors/mcp" ? { tool: (body as { params: { name: string } }).params.name, denied: response.status !== 200 || result.result?.isError === true } : {}),
      });
      expect(response.status, `${method} ${path}: ${JSON.stringify(result).slice(0, 400)}`).toBe(expected);
      return result as T;
    };
    const findBot = (bots: WireBot[], id: string) => {
      const bot = bots.find((candidate) => candidate.id === id);
      expect(bot, `Bot ${id}`).toBeDefined();
      return bot!;
    };
    const fresh = async (id: string) => findBot((await api<{ bots: WireBot[] }>("GET", "/api/bots?messages=0")).bots, id);
    const patch = async (id: string, body: PermissionPatch) => (await api<BotReply>("PATCH", `/api/bots/${id}`, body)).bot;
    const saved = (id: string) => findBot(JSON.parse(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")) as WireBot[], id);
    let sends = 0;
    const turn = async (bot: { id: string; threadId: string }) => {
      const text = `Verify matrix permission turn ${++sends}`;
      await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text, sendId: `matrix-permissions-send-${String(sends).padStart(4, "0")}` }, 202);
      let dump: FixtureDump | undefined;
      await expect.poll(() => {
        try { dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as FixtureDump; } catch { return false; }
        return JSON.stringify(dump.prompt).includes(text);
      }, { timeout: 20_000 }).toBe(true);
      if (!dump) throw new Error("Missing fixture turn dump");
      evidence.push({ botId: bot.id, mountedServers: Object.keys(dump.mcpConfig.mcpServers) });
      return dump.mcpConfig.mcpServers;
    };
    const call = (token: string, tool: string, expected = 200) => api<ToolReply>("POST", "/api/internal/connectors/mcp", {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: {} },
    }, expected, token);
    const ada = (await api<BotReply>("POST", "/api/bots", { name: "Matrix Ada" }, 201)).bot;
    const ben = (await api<BotReply>("POST", "/api/bots", { name: "Matrix Ben" }, 201)).bot;
    await patch(ada.id, { connectorScopes: { apps: { gmail: "read", googlecalendar: "write" } }, connectorTools: { gmail: { tools: ["GMAIL_FETCH_EMAILS"] }, googlecalendar: { tools: "*" } } });
    await patch(ben.id, { composio: false, connectorScopes: null, connectorTools: null });
    await patch(ada.id, { connectorScopes: { apps: { gmail: "read" } } });
    await patch(ben.id, { composio: true, connectorScopes: { apps: { gmail: "write" } } });
    expect(saved(ada.id)).toMatchObject({ connectorScopes: { apps: { gmail: "read" } }, connectorTools: { gmail: { tools: ["GMAIL_FETCH_EMAILS"] } } });
    expect(saved(ben.id)).toMatchObject({ composio: true, connectorScopes: { apps: { gmail: "write" } } });
    expect((await fresh(ada.id)).connectorScopes).toEqual({ apps: { gmail: "read" } });
    expect((await fresh(ben.id)).connectorScopes).toEqual({ apps: { gmail: "write" } });

    for (const name of ["notes", "tasks"]) {
      await api("POST", "/api/mcp/servers", { name, command: process.execPath, args: ["--experimental-strip-types", "--no-warnings", FAKE_MCP] }, 201);
      await api("PATCH", `/api/mcp/servers/${name}`, { enabled: true });
    }
    await patch(ada.id, { mcpServers: ["tasks"] });
    await patch(ben.id, { mcpServers: ["notes"] });
    expect(saved(ada.id).mcpServers).toEqual(["tasks"]);
    expect(saved(ben.id).mcpServers).toEqual(["notes"]);
    expect((await api<{ servers: { name: string; enabled: boolean; on: boolean }[] }>("GET", `/api/bots/${ada.id}/mcp-servers`)).servers).toEqual(
      expect.arrayContaining([
        { name: "tasks", enabled: true, on: true }, { name: "notes", enabled: true, on: false },
      ]));
    expect((await api<{ servers: { name: string; enabled: boolean; on: boolean }[] }>("GET", `/api/bots/${ben.id}/mcp-servers`)).servers).toEqual(expect.arrayContaining([
      { name: "notes", enabled: true, on: true }, { name: "tasks", enabled: true, on: false },
    ]));

    const adaMounts = await turn(ada);
    expect(adaMounts.tasks).toBeDefined();
    expect(adaMounts.notes).toBeUndefined();
    const adaToken: string = adaMounts.composio.env.OMB_CONNECTOR_TOKEN;
    expect((await call(adaToken, "GMAIL_FETCH_EMAILS")).result.isError).not.toBe(true);
    expect(apps.calls.at(-1)?.tool).toBe("GMAIL_FETCH_EMAILS");
    const beforeDenied = apps.calls.length;
    expect((await call(adaToken, "GMAIL_GET_PROFILE")).result.isError).toBe(true);
    expect((await call(adaToken, "GMAIL_SEND_EMAIL")).result.isError).toBe(true);
    expect((await call(adaToken, "GOOGLECALENDAR_LIST_EVENTS")).result.isError).toBe(true);
    expect(apps.calls).toHaveLength(beforeDenied);
    expect(await api("PATCH", `/api/bots/${ada.id}`, { mcpServers: [] })).toEqual(expect.objectContaining({ bot: expect.objectContaining({ mcpServers: [] }) }));
    expect(saved(ada.id).mcpServers).toEqual([]);
    await patch(ada.id, { connectorScopes: { apps: {} } });
    expect((await call(adaToken, "GMAIL_FETCH_EMAILS")).result.isError).toBe(true);
    expect(apps.calls).toHaveLength(beforeDenied);

    const benMounts = await turn(ben);
    expect(benMounts.notes).toBeDefined();
    expect(benMounts.tasks).toBeUndefined();
    const benToken: string = benMounts.composio.env.OMB_CONNECTOR_TOKEN;
    expect((await call(benToken, "GMAIL_FETCH_EMAILS")).result.isError).not.toBe(true);
    const beforeCalendar = apps.calls.length;
    expect((await call(benToken, "GOOGLECALENDAR_LIST_EVENTS")).result.isError).toBe(true);
    expect(apps.calls).toHaveLength(beforeCalendar);
    await patch(ben.id, { connectorScopes: { apps: { gmail: "read" } } });
    expect((await call(benToken, "GMAIL_SEND_EMAIL")).result.content[0].text).toContain("read-only");
    expect(apps.calls).toHaveLength(beforeCalendar);
    await patch(ben.id, { composio: false });
    await call(benToken, "GMAIL_FETCH_EMAILS", 403);
    expect(apps.calls).toHaveLength(beforeCalendar);
    expect(saved(ada.id).connectorScopes).toEqual({ apps: {} });
    expect(saved(ben.id)).toMatchObject({ composio: false, connectorScopes: { apps: { gmail: "read" } }, mcpServers: ["notes"] });
    writeFileSync(gate, "finish");
    await expect.poll(async () => (await fresh(ada.id)).busy || (await fresh(ben.id)).busy, { timeout: 20_000 }).toBe(false);
    await patch(ada.id, { mcpServers: [] });
    await patch(ben.id, { mcpServers: null });
    const none = await turn(ada);
    expect(none.notes).toBeUndefined();
    expect(none.tasks).toBeUndefined();
    const inherited = await turn(ben);
    expect(inherited.notes).toBeDefined();
    expect(inherited.tasks).toBeDefined();
    expect(saved(ada.id).mcpServers).toEqual([]);
    expect(saved(ben.id).mcpServers).toBeUndefined();
  } finally {
    try {
      if (launched) {
        const evidencePath = `${launched.info.logPath}.permissions-matrix.json`;
        writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
        console.info(JSON.stringify({ evidencePath, logPath: launched.info.logPath }));
      }
    } finally {
      try {
        await launched?.close();
      } finally {
        try {
          await apps.close();
        } finally {
          if (scratch) await removeTempDir(scratch);
        }
      }
    }
  }
}, 120_000);
