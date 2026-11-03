import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR, type AppConfig } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import { IMPORTED_SKILLS_DIR, importedSkillsFor } from "../imported-skills.ts";
import type { RequestAuth } from "../request-auth.ts";
import { thisMachine } from "../setup-import.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createSetupImportRoutes } from "./setup-import.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(homes.splice(0).map((home) => removeTempDir(home)));
  rmSync(IMPORTED_SKILLS_DIR, { recursive: true, force: true });
  rmSync(join(DATA_DIR, "skill-state", "imported-skills.json"), { force: true });
});

const AUTH: Record<string, RequestAuth> = {
  owner: { kind: "loopback", scopes: ["admin", "client"] },
  service: { kind: "loopback", scopes: ["client"], trust: "service" },
  paired: { kind: "session", via: "bearer", scopes: ["admin", "client"], session: { id: "s1" } } as unknown as RequestAuth,
};

/** A fixture home with one skill and one MCP server; never the real one. */
function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), "omb-setup-route-home-"));
  homes.push(home);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
  };
  put(".claude/skills/pdf/SKILL.md", "---\nname: pdf\ndescription: Works with PDF files.\n---\n\nRead the PDF.\n");
  put(".cursor/mcp.json", JSON.stringify({ mcpServers: { notion: { url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer notion_secret" } } } }));
  return home;
}

async function serve({ local = true, home = fixtureHome(), dataDir }: { local?: boolean; home?: string; dataDir?: string } = {}) {
  const cfg = { mcpServers: {} } as Pick<AppConfig, "mcpServers" | "features">;
  const bot = { id: `bot-${randomUUID().slice(0, 8)}` };
  let busy = false;
  const routes = [createSetupImportRoutes({
    local,
    cfg,
    mcpConfigBusy: { get: () => busy, set: (value) => { busy = value; } },
    mcpPolicyRefusal: () => undefined,
    persistMcpServers: (next) => { cfg.mcpServers = next; },
    machine: () => ({ ...thisMachine(), home, platform: "darwin", env: {} }),
    ...(dataDir ? { dataDir } : {}),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = AUTH[String(req.headers["x-test-auth"] ?? "owner")]!;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) {
      json(res, 404, { from: "next handler" });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, options: { auth?: string; body?: unknown; type?: string } = {}) => fetch(`${base}${path}`, {
    method,
    headers: { "x-test-auth": options.auth ?? "owner", ...(options.body === undefined ? {} : { "content-type": options.type ?? "application/json" }) },
    ...(options.body === undefined ? {} : { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }),
  });
  return { call, cfg, bot };
}

describe("the setup import routes", () => {
  it("hands out what Grok Bot left on this computer only to the owner's own loopback there", async () => {
    const home = fixtureHome();
    mkdirSync(join(home, "Downloads"));
    writeFileSync(join(home, "Downloads", "grok-bot-export-drew.json"), "reply");
    const local = await serve({ home });
    for (const auth of ["paired", "service"]) expect((await local.call("GET", "/api/setup-import/grok", { auth })).status, auth).toBe(403);
    expect((await (await serve({ local: false, home })).call("GET", "/api/setup-import/grok")).status).toBe(403);
    expect((await local.call("POST", "/api/setup-import/grok", { body: {} })).status).toBe(405);
    const found = await local.call("GET", "/api/setup-import/grok");
    expect(found.headers.get("cache-control")).toBe("no-store");
    expect(await found.json()).toMatchObject({ files: [{ name: "grok-bot-export-drew.json", text: "reply" }], bots: [] });
  });

  it("deletes an old Cursor sign-in as the routes start, on any server", async () => {
    const home = fixtureHome();
    writeFileSync(join(home, "cursor-session.json"), "{\"accessToken\":\"x\"}");
    await serve({ home, local: false, dataDir: home });
    expect(existsSync(join(home, "cursor-session.json"))).toBe(false);
  });

  it("answers only the owner's own loopback on a computer of their own", async () => {
    const local = await serve();
    for (const auth of ["paired", "service"]) {
      for (const method of ["GET", "POST"]) {
        const response = await local.call(method, "/api/setup-import", { auth, ...(method === "POST" ? { body: { skills: true, tools: true } } : {}) });
        expect(response.status, `${auth} ${method}`).toBe(403);
      }
    }
    const hosted = await serve({ local: false });
    expect((await hosted.call("GET", "/api/setup-import")).status).toBe(403);
    expect((await hosted.call("POST", "/api/setup-import", { body: { skills: true, tools: true } })).status).toBe(403);
    expect(importedSkillsFor(local.bot.id, new Set())).toEqual([]);
    expect(local.cfg.mcpServers).toEqual({});
  });

  it("finds by name, brings in on POST, and leaves other paths to the next handler", async () => {
    const { call, cfg, bot } = await serve();
    const found = await call("GET", "/api/setup-import");
    expect(found.status).toBe(200);
    expect(found.headers.get("cache-control")).toBe("no-store");
    expect(await found.json()).toEqual({ skills: [{ name: "pdf", source: "claudeCode" }], tools: [{ name: "notion", source: "cursor" }] });

    const brought = await call("POST", "/api/setup-import", { body: { skills: true, tools: true } });
    expect(brought.status).toBe(200);
    const text = await brought.text();
    expect(JSON.parse(text)).toEqual({
      skills: { added: ["pdf"], present: [], skipped: [], filesLeftOut: 0, review: [] },
      tools: { added: ["notion"], present: [], skipped: [] },
    });
    expect(text).not.toContain("notion_secret");
    expect(importedSkillsFor(bot.id, new Set()).map((skill) => skill.name)).toEqual(["pdf"]);
    expect(cfg.mcpServers).toEqual({ notion: { type: "http", url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer notion_secret" }, enabled: false } });
    expect(await (await call("GET", "/api/setup-import")).json()).toEqual({ skills: [], tools: [] });

    expect(await (await call("GET", "/api/setup-import/other")).json()).toEqual({ from: "next handler" });
    expect((await call("DELETE", "/api/setup-import")).status).toBe(405);
  });

  it("brings in only the kinds asked for, and refuses a body it does not understand", async () => {
    const { call, cfg, bot } = await serve();
    const tools = await call("POST", "/api/setup-import", { body: { tools: true } });
    expect(await tools.json()).toEqual({ tools: { added: ["notion"], present: [], skipped: [] } });
    expect(importedSkillsFor(bot.id, new Set())).toEqual([]);
    expect(Object.keys(cfg.mcpServers ?? {})).toEqual(["notion"]);

    expect((await call("POST", "/api/setup-import", { body: {} })).status).toBe(400);
    expect((await call("POST", "/api/setup-import", { body: { skills: false, tools: false } })).status).toBe(400);
    expect((await call("POST", "/api/setup-import", { body: { skills: true, instructions: true } })).status).toBe(400);
    expect((await call("POST", "/api/setup-import", { body: { skills: "yes" } })).status).toBe(400);
    expect((await call("POST", "/api/setup-import", { body: "skills=true", type: "text/plain" })).status).toBe(415);
  });
});
