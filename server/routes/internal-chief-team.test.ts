import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord } from "../store.ts";
import type { LibraryTeamRoles } from "../team-library.ts";
import { createInternalChiefTeamRoutes } from "./internal-chief-team.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const bot = (id: string, extra: Partial<BotRecord> = {}): BotRecord => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", soul: "", notifications: true, color: "blue", unread: false,
  createdAt: 1, resumeCursors: {}, modelSelection: { instanceId: "claude", model: "sonnet" }, ...extra,
});

const TEAMS: LibraryTeamRoles[] = [{ name: "Inbox Follow-up", summary: "Recover quiet sales threads.", roles: [{ name: "Scout", title: "Researcher" }] }];

async function serve(caller: BotRecord, library: () => Promise<LibraryTeamRoles[]>, team: { teams?: string[]; bots?: BotRecord[] } = {}) {
  const state = { caller: caller as BotRecord | null, active: true };
  const routes = [createInternalChiefTeamRoutes({
    bot: () => state.caller,
    requireActive: () => { if (!state.active) throw Object.assign(new Error("the internal turn capability has expired"), { status: 401 }); },
    teams: () => team.teams ?? [""],
    bots: () => team.bots ?? [caller],
    instances: async () => [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available" },
      models: { default: "sonnet", options: [] }, capabilities: { effortLevels: ["low", "high"] } }],
    library,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    try {
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "next routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: (error as Error).message });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { state, get };
}

describe("what a Chief of Staff reads about its team", () => {
  it("gives an active Chief the library's teams and roles, read only", async () => {
    const library = vi.fn(async () => TEAMS);
    const { get } = await serve(bot("chief", { chiefOfStaff: true }), library);
    expect(await get("/api/internal/team-library")).toEqual({ status: 200, body: { teams: TEAMS } });
    expect(library).toHaveBeenCalledOnce();
  });

  it("refuses any other bot before it reads anything", async () => {
    const library = vi.fn(async () => TEAMS);
    const { get } = await serve(bot("helper"), library);
    for (const path of ["/api/internal/team-library", "/api/internal/team-setup-catalog"]) {
      expect(await get(path)).toEqual({ status: 403, body: { error: "Only an active Chief may plan team setup" } });
    }
    expect(library).not.toHaveBeenCalled();
    const hidden = await serve(bot("archived", { chiefOfStaff: true, hidden: true }), library);
    expect((await hidden.get("/api/internal/team-library")).status).toBe(403);
  });

  it("says plainly when the library can't be reached", async () => {
    const { get } = await serve(bot("chief", { chiefOfStaff: true }), async () => { throw new Error("GitHub returned HTTP 503"); });
    expect(await get("/api/internal/team-library")).toEqual({
      status: 502, body: { error: "The team library can't be reached right now. Build the team from what the person asked." },
    });
  });

  it("answers nothing once the turn's capability expired or the bot stopped being the Chief while the library loaded", async () => {
    const loading: Array<(teams: LibraryTeamRoles[]) => void> = [];
    const { state, get } = await serve(bot("chief", { chiefOfStaff: true }), () => new Promise((resolve) => { loading.push(resolve); }));
    const expired = get("/api/internal/team-library");
    await vi.waitFor(() => expect(loading).toHaveLength(1));
    state.active = false;
    loading[0]!(TEAMS);
    expect((await expired).status).toBe(401);
    state.active = true;
    const demoted = get("/api/internal/team-library");
    await vi.waitFor(() => expect(loading).toHaveLength(2));
    state.caller = bot("chief");
    loading[1]!(TEAMS);
    expect((await demoted).status).toBe(403);
  });

  it("lists the teams, reachable teammates and exact model choices a Chief plans team setup with", async () => {
    const chief = bot("chief", { chiefOfStaff: true, section: "Work" });
    const { get } = await serve(chief, async () => TEAMS, {
      teams: ["", "Work", "Private"],
      bots: [chief, bot("writer", { section: "Work", title: "Writer" }), bot("gone", { section: "Work", hidden: true }), bot("other", { section: "Private" })],
    });
    expect((await get("/api/internal/team-setup-catalog")).body).toMatchObject({
      teams: ["Work"],
      bots: [
        { id: "chief", section: "Work", chiefOfStaff: true },
        { id: "writer", title: "Writer", section: "Work", chiefOfStaff: false, modelSelection: { instanceId: "claude", model: "sonnet" } },
      ],
      instances: [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", state: "available", effortLevels: ["low", "high"] }],
    });
  });

  it("leaves every other route to the next handler", async () => {
    const { get } = await serve(bot("chief", { chiefOfStaff: true }), async () => TEAMS);
    expect(await get("/api/internal/team-setup-requests")).toEqual({ status: 404, body: { from: "next routes" } });
  });
});
