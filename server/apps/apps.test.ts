// Curated apps: token storage, live status over a fake local MCP server,
// Buddy prompt rules and +app tags, and use_app gating. The fake server
// mimics Edits: Bearer auth, 403 without it, SSE replies held open.
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { buildAppsPrompt, taggedApps } from "./prompt.ts";
import { appStatus, checkConnection, describeApps, invalidateAppStatus } from "./status.ts";
import { appConnection, removeAppSettings, saveAppSettings, validateLocalEndpoint } from "./store.ts";
import { listAppsForBuddy, useApp } from "./use.ts";
import { findApp } from "./catalog.ts";

const TOKEN = "TEST-token_abc123";
let server: Server;
let endpoint = "";
let calls: Array<{ method: string; session?: string }> = [];
let mode: "sse-held-open" | "json" = "sse-held-open";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const msg = JSON.parse(data);
      calls.push({ method: msg.method, session: req.headers["mcp-session-id"] as string | undefined });
      if (msg.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      const result =
        msg.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-edits" } }
          : msg.method === "tools/list"
            ? { tools: [{ name: "create_project", description: "Create a project", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: `ran ${msg.params.name}` }] };
      const headers: Record<string, string> = msg.method === "initialize" ? { "mcp-session-id": "session-1" } : {};
      if (mode === "json") {
        res.writeHead(200, { "content-type": "application/json", ...headers });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      }
      // answer, then keep the stream open: the client must not wait for close
      res.writeHead(200, { "content-type": "text/event-stream", ...headers });
      res.write(": connected\n\n");
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

afterEach(() => {
  removeAppSettings("edits");
  invalidateAppStatus();
  calls = [];
  mode = "sse-held-open";
});

const edits = findApp("edits")!;

describe("app settings", () => {
  it("never returns the token and stores it owner-only", async () => {
    saveAppSettings("edits", { endpoint, token: TOKEN });
    const apps = await describeApps(true);
    expect(JSON.stringify(apps)).not.toContain(TOKEN);
    expect(apps[0].settings).toMatchObject({ tokenConfigured: true, customEndpoint: true });
    const disk = readFileSync(join(DATA_DIR, "apps.json"), "utf8");
    expect(disk).toContain(TOKEN);
  });

  it("only accepts addresses on this computer", () => {
    expect(validateLocalEndpoint("http://localhost:19501/mcp")).toBe("http://localhost:19501/mcp");
    expect(validateLocalEndpoint("http://[::1]:19501/mcp")).toBe("http://[::1]:19501/mcp");
    expect(() => validateLocalEndpoint("https://example.com/mcp")).toThrow("only to this computer");
    expect(() => validateLocalEndpoint("http://127.0.0.1.example.com/mcp")).toThrow("only to this computer");
    expect(() => saveAppSettings("edits", { endpoint: "http://evil.test/mcp" })).toThrow();
  });

  it("keeps the saved token when the field is left blank, and resets the address", () => {
    saveAppSettings("edits", { endpoint, token: TOKEN });
    saveAppSettings("edits", { token: "", endpoint: "" });
    expect(appConnection("edits")).toEqual({ endpoint: edits.defaultEndpoint, token: TOKEN });
  });
});

describe("live status", () => {
  it("is Ready with the app's actions, without waiting for a held-open stream", async () => {
    const started = Date.now();
    const status = await checkConnection(edits, endpoint, TOKEN);
    expect(status.state).toBe("ready");
    expect(status.tools.map((t) => t.name)).toEqual(["create_project"]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls.map((c) => c.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(calls[2].session).toBe("session-1");
  });

  it("also reads plain JSON replies", async () => {
    mode = "json";
    expect((await checkConnection(edits, endpoint, TOKEN)).state).toBe("ready");
  });

  it("asks for setup when the app is running but the token is missing or wrong", async () => {
    expect(await checkConnection(edits, endpoint, undefined)).toMatchObject({ state: "needs_setup", message: expect.stringContaining("Add its access token") });
    expect(await checkConnection(edits, endpoint, "old-token")).toMatchObject({ state: "needs_setup", message: expect.stringContaining("regenerated") });
  });

  it("reports Not running when nothing is listening", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as { port: number }).port;
    await new Promise((r) => closed.close(r));
    expect((await checkConnection(edits, `http://127.0.0.1:${port}/mcp`, TOKEN)).state).toBe("not_running");
  });
});

describe("Buddies and apps", () => {
  it("tags apps with +id, ignoring unknown apps, emails and phone numbers", () => {
    expect(taggedApps("+edits make a montage")).toEqual(["edits"]);
    expect(taggedApps("Use (+Edits) please")).toEqual(["edits"]);
    expect(taggedApps("call +44 20 7946 or a+edits@x.com, +notanapp")).toEqual([]);
  });

  it("states the routing rules and the user's tagged app", async () => {
    saveAppSettings("edits", { endpoint, token: TOKEN });
    const prompt = await buildAppsPrompt("+edits make a montage from my clips");
    expect(prompt).toContain("Edits (id: edits, ready)");
    expect(prompt).toContain("give them the setup steps");
    expect(prompt).toContain("ask which they want");
    expect(prompt).toContain("The user tagged: Edits");
    expect(prompt).not.toContain(TOKEN);
  });

  it("gives setup steps instead of actions when an app isn't ready, and refuses to use it", async () => {
    saveAppSettings("edits", { endpoint });
    const [app] = await listAppsForBuddy();
    expect(app).toMatchObject({ status: "needs_setup", setup_steps: edits.setupSteps });
    await expect(useApp("edits", "create_project", {})).rejects.toThrow("isn't ready");
  });

  it("runs an action on a ready app with the stored token", async () => {
    saveAppSettings("edits", { endpoint, token: TOKEN });
    const [app] = await listAppsForBuddy("edits");
    expect(app.actions).toEqual([{ name: "create_project", description: "Create a project", inputSchema: { type: "object" } }]);
    expect(await useApp("edits", "create_project", { name: "TEST · montage" })).toEqual({ content: [{ type: "text", text: "ran create_project" }] });
    await expect(useApp("edits", "delete_everything", {})).rejects.toThrow("no action named");
  });

  it("caches status between turns", async () => {
    saveAppSettings("edits", { endpoint, token: TOKEN });
    await appStatus("edits");
    calls = [];
    await appStatus("edits");
    expect(calls).toEqual([]);
  });
});
