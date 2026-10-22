import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../../scripts/control-omb.ts";
import { memberBody, VisibleSet } from "../bot-visibility.ts";
import { DATA_DIR } from "../config.ts";
import { json, onJsonBody, readBody } from "../harness/http.ts";
import { requiredScope } from "../request-auth.ts";
import type { BotRecord } from "../store.ts";
import { TeamComputers } from "../team-computers.ts";
import { createSidebarSectionRoutes, type SidebarSectionRouteDeps } from "./sidebar-sections.ts";
import { dispatchRoutes } from "./table.ts";

const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function call(base: string, method: string, path = "/api/sidebar-sections", body?: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, {
    method, headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function serve(overrides: Partial<SidebarSectionRouteDeps> = {}, beforeDispatch?: (res: ServerResponse) => void) {
  mkdirSync(DATA_DIR, { recursive: true });
  let sections = ["Original"];
  const store: SidebarSectionRouteDeps["store"] = {
    get sections() { return sections; },
    bot: () => null,
    renameSection(name, nextName) {
      if (!this.sections.includes(name)) return "No such team";
      sections = this.sections.map(section => section === name ? nextName : section);
    },
    deleteSection(name) {
      if (!this.sections.includes(name)) return "No such team";
      sections = this.sections.filter(section => section !== name);
    },
    setBotsSection(_ids, name) {
      sections = [...this.sections, name];
      return { ok: true, bots: [] };
    },
    updateTeamMembers: () => ({ ok: true, bots: [] }),
  };
  const deps: SidebarSectionRouteDeps = {
    store, teamComputers: new TeamComputers(join(DATA_DIR, `computers-${randomUUID()}.json`), randomUUID()),
    maxBots: 100, assertTeamComputerChangeIdle: () => {}, wireBot: bot => ({ id: bot.id }),
    ...overrides,
  };
  const routes = [createSidebarSectionRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    beforeDispatch?.(res);
    try {
      if (!await dispatchRoutes(routes, {
        req, res, url, path: url.pathname, method: req.method ?? "GET",
        auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody,
      })) {
        res.setHeader("x-route-fallthrough", "yes");
        json(res, 404, { from: "inline routes" });
      }
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, deps };
}

describe("sidebar-section route module", () => {
  it("reads current sections after each change and preserves the store receiver", async () => {
    const { base } = await serve();
    expect(await (await call(base, "GET")).json()).toEqual({ sections: ["Original"] });
    expect(await (await call(base, "POST", undefined, { name: "Added" })).json())
      .toEqual({ section: "Added", sections: ["Original", "Added"], bots: [] });
    expect(await (await call(base, "PATCH", "/api/sidebar-sections?section=Added", { name: "Renamed" })).json())
      .toEqual({ sections: ["Original", "Renamed"] });
    expect(await (await call(base, "DELETE", "/api/sidebar-sections?section=Original")).json())
      .toEqual({ sections: ["Renamed"] });
    expect(await (await call(base, "GET")).json()).toEqual({ sections: ["Renamed"] });
  });

  it("passes wrong methods, near paths and adjacent routes to the next handler", async () => {
    const { base } = await serve();
    for (const path of ["/api/sidebar-section", "/api/sidebar-sections/", "/api/sidebar-sections/extra", "/api/bot-defaults", "/api/section-context"]) {
      for (const method of methods) {
        const response = await call(base, method, path);
        expect(response.headers.get("x-route-fallthrough"), `${method} ${path}`).toBe("yes");
      }
    }
    for (const method of ["HEAD", "OPTIONS"]) {
      const response = await call(base, method);
      expect(response.headers.get("x-route-fallthrough"), method).toBe("yes");
    }
  });

  it.each(["POST", "PUT"])("keeps wire projection and the pre-dispatch member narrowing for %s receipts", async method => {
    const bot = { id: "visible", threadId: "t-visible", visibility: "everyone", peers: ["visible", "private"] } as BotRecord;
    const visible = new VisibleSet([bot, { id: "private", threadId: "t-private", visibility: "admins" }], [], { kind: "member" });
    const { base, deps } = await serve({ wireBot: value => ({ ...value, projected: true }) },
      res => onJsonBody(res, body => memberBody(body, visible)));
    deps.store.setBotsSection = () => ({ ok: true, bots: [bot] });
    deps.store.updateTeamMembers = () => ({ ok: true, bots: [bot] });
    const response = await call(base, method, "/api/sidebar-sections?section=Original",
      method === "POST" ? { name: "Original", botIds: [bot.id] } : { addBotIds: [bot.id], removeBotIds: [] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ bots: [{ id: bot.id, threadId: bot.threadId, peers: ["visible"], projected: true }] });
    expect(JSON.stringify(body)).not.toContain("visibility");
  });

  it.each(["POST", "PUT"])("lets the existing busy-computer guard refuse %s before store mutation", async method => {
    const bot = { id: "busy", threadId: "t-busy", section: "Other" } as BotRecord;
    const guard = vi.fn(() => { throw Object.assign(new Error("computer is busy"), { status: 409 }); });
    const { base, deps } = await serve({ assertTeamComputerChangeIdle: guard });
    deps.store.bot = () => bot;
    const set = vi.spyOn(deps.store, "setBotsSection");
    const update = vi.spyOn(deps.store, "updateTeamMembers");
    const response = await call(base, method, "/api/sidebar-sections?section=Original",
      method === "POST" ? { name: "Original", botIds: [bot.id] } : { addBotIds: [bot.id], removeBotIds: [] });
    expect(response.status).toBe(409);
    expect(guard).toHaveBeenCalledWith(bot, { ...bot, section: "Original" });
    expect(set).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps team-computer deletion protection and forwards the registry when renaming", async () => {
    const { base, deps } = await serve();
    const computer = deps.teamComputers.create("Fixture desktop");
    deps.teamComputers.assign(computer.id, "Original");
    const remove = vi.spyOn(deps.store, "deleteSection");
    const rename = vi.spyOn(deps.store, "renameSection");
    const blocked = await call(base, "DELETE", "/api/sidebar-sections?section=Original");
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "Unassign this team's computer before deleting the team" });
    expect(remove).not.toHaveBeenCalled();
    expect((await call(base, "PATCH", "/api/sidebar-sections?section=Original", { name: "Renamed" })).status).toBe(200);
    expect(rename).toHaveBeenCalledWith("Original", "Renamed", deps.teamComputers);
  });
});

describe("sidebar sections behind the real server's auth gate", () => {
  let fixture: VerificationServer;
  beforeAll(async () => { fixture = await launchVerificationServer(); });
  afterAll(async () => { await fixture?.close(); });

  it("boots with Node type stripping and serves the registered family", async () => {
    expect(fixture.child.spawnargs).toContain("--experimental-strip-types");
    const created = await call(fixture.info.url, "POST", undefined, { name: "Routing fixture" });
    expect(created.status).toBe(200);
    expect(await (await call(fixture.info.url, "GET")).json()).toMatchObject({ sections: ["Routing fixture"] });
  });

  it("rejects unauthenticated requests for all five methods before processing the route", async () => {
    for (const method of methods) {
      const response = await call(fixture.info.url, method, "/api/sidebar-sections?section=Routing%20fixture",
        method === "GET" ? undefined : {}, { origin: "https://elsewhere.example.test" });
      expect([401, 403], method).toContain(response.status);
    }
  });

  it("retains admin scope for all five methods, including paired chat-only sessions", async () => {
    const base = fixture.info.url;
    const opened = await call(base, "POST", "/api/auth/pairing", { scopes: ["client"] }, { origin: base });
    expect(opened.status).toBe(200);
    const { code } = await opened.json() as { code: string };
    const paired = await call(base, "POST", "/api/auth/pair", { code }, { origin: base });
    expect(paired.status).toBe(200);
    const { token } = await paired.json() as { token: string };
    for (const method of methods) {
      expect(requiredScope(method, "/api/sidebar-sections"), method).toBe("admin");
      const response = await call(base, method, "/api/sidebar-sections?section=Routing%20fixture",
        method === "GET" ? undefined : {}, { origin: base, authorization: `Bearer ${token}` });
      expect(response.status, method).toBe(403);
    }
  });
});
