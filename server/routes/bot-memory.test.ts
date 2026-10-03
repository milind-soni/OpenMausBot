// Locks for the bot-memory family's move from index.ts's inline routes
// into the route table: the family still answers only behind the auth gate
// (401/403 for strangers and chat-only sessions), a JSON-body hook installed
// before dispatchRoutes, where index.ts narrows what a member is sent,
// still transforms these routes' bodies, the 404 precheck still consults the
// store seam, and journal rows still name the chat through the
// taskByThread seam. The behavior itself (containment, conflicts, revert)
// stays covered by server/memory-routes.test.ts over the same HTTP surface.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { json, onJsonBody, readBody } from "../harness/http.ts";
import { recordMemoryChange } from "../memory-journal.ts";
import { commitLearned, planLearned } from "../profile-learned.ts";
import { requiredScope } from "../request-auth.ts";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-omb.ts";
import { createBotMemoryRoutes, type BotMemoryRouteDeps } from "./bot-memory.ts";
import { dispatchRoutes } from "./table.ts";

const BOTS: Record<string, { id: string }> = { "bot-123": { id: "bot-123" } };
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** The table the way index.ts runs it: hooks may be installed on the
 * response before dispatchRoutes, and anything the module passes on falls
 * to a stand-in for index.ts's inline routes. */
async function serve(deps: Partial<BotMemoryRouteDeps> = {}, beforeDispatch?: (res: import("node:http").ServerResponse) => void): Promise<string> {
  const routes = [createBotMemoryRoutes({
    bot: (id) => BOTS[id], taskByThread: () => undefined,
    upkeep: { status: () => ({ modelSteps: false }), tidy: async () => { throw new Error("unexpected tidy"); } },
    aboutMe: () => "", saveAboutMe: () => { throw new Error("unexpected profile save"); },
    ...deps,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    beforeDispatch?.(res);
    try {
      const handled = await dispatchRoutes(routes, {
        req, res, url, path: url.pathname, method: req.method ?? "GET",
        auth: { kind: "loopback", scopes: ["admin"] }, json, readBody,
      });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { error: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("the bot-memory module through the route table", () => {
  it("serves the overview and reads a file from the bot's workspace", async () => {
    const base = await serve();
    const overview = await fetch(`${base}/api/bots/bot-123/memory`);
    expect(overview.status).toBe(200);
    const body = (await overview.json()) as { botId: string; workspacePath: string; topics: unknown[]; logs: unknown[] };
    expect(body).toMatchObject({ botId: "bot-123", topics: [], logs: [] });
    expect(body.workspacePath).toContain(join("workspaces", "bot-123"));
    const file = await fetch(`${base}/api/bots/bot-123/memory/file`);
    expect(file.status).toBe(200);
    // Reads never create the workspace: a bot that has not run yet simply
    // has nothing to show.
    expect(await file.json()).toMatchObject({ path: "MEMORY.md", exists: false, text: "" });
  });

  it("names the chat in a journal row through the taskByThread seam, and keeps the prior text server-side", async () => {
    recordMemoryChange("bot-123", { path: "MEMORY.md", actor: "bot", via: "turn", threadId: "thread-1", before: null, after: "learned: short replies" });
    const base = await serve({ taskByThread: (botId, threadId) => (botId === "bot-123" && threadId === "thread-1" ? { title: "Trip planning" } : undefined) });
    const journal = await fetch(`${base}/api/bots/bot-123/memory/journal`);
    expect(journal.status).toBe(200);
    const { entries } = (await journal.json()) as { entries: Array<Record<string, unknown>> };
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: "MEMORY.md", actor: "bot", threadId: "thread-1", threadTitle: "Trip planning" });
    expect(entries[0]!.before).toBeUndefined();
    // Without a task for the thread the row simply carries no title.
    const plain = await serve();
    const untitled = await fetch(`${plain}/api/bots/bot-123/memory/journal`);
    expect(((await untitled.json()) as { entries: Array<Record<string, unknown>> }).entries[0]!.threadTitle).toBeUndefined();
  });

  it("keeps the 404 precheck on the store seam for every pattern", async () => {
    const base = await serve({ bot: () => undefined });
    for (const [method, path, body] of [
      ["GET", "/api/bots/missing/memory"],
      ["PUT", "/api/bots/missing/memory", { text: "x" }],
      ["GET", "/api/bots/missing/memory/file"],
      ["PUT", "/api/bots/missing/memory/file", { text: "x" }],
      ["DELETE", "/api/bots/missing/memory/file"],
      ["GET", "/api/bots/missing/memory/journal"],
      ["POST", "/api/bots/missing/memory/journal/e1/revert"],
      ["GET", "/api/bots/missing/memory/upkeep"],
      ["POST", "/api/bots/missing/memory/tidy"],
      ["POST", "/api/bots/missing/memory/open", { target: "folder" }],
    ] as Array<[string, string, unknown?]>) {
      const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json(), `${method} ${path}`).toEqual({ error: "no such bot" });
    }
  });

  it("uses the upkeep service and refuses tidying when the bot has switched it off", async () => {
    let enabled = true;
    const tidied: string[] = [];
    const report = { at: 1, expired: 2, duplicates: 0, superseded: 0, deferred: 0, contradictionsChecked: false };
    const base = await serve({
      bot: (id) => ({ id, memoryUpkeep: enabled }),
      upkeep: {
        status: () => ({ modelSteps: false, lastTidy: report }),
        tidy: async (id) => { tidied.push(id); return report; },
      },
    });
    expect(await (await fetch(`${base}/api/bots/bot-123/memory/upkeep`)).json()).toEqual({ enabled: true, modelSteps: false, lastTidy: report });
    const tidy = await fetch(`${base}/api/bots/bot-123/memory/tidy`, { method: "POST" });
    expect(tidy.status).toBe(200);
    expect(await tidy.json()).toMatchObject({ report, overview: { botId: "bot-123" } });
    enabled = false;
    expect(await (await fetch(`${base}/api/bots/bot-123/memory/upkeep`)).json()).toMatchObject({ enabled: false });
    expect((await fetch(`${base}/api/bots/bot-123/memory/tidy`, { method: "POST" })).status).toBe(409);
    expect(tidied).toEqual(["bot-123"]);
  });

  it("removes learned facts through the current About me and save seams", async () => {
    const facts = planLearned({ botId: "bot-123", botName: "Memo" }, ["Prefers tea"], "", "2026-09-28");
    commitLearned(facts);
    let aboutMe = `Handwritten note\n${facts[0]!.line}`;
    const saved: string[] = [];
    const base = await serve({ aboutMe: () => aboutMe, saveAboutMe: (text) => { aboutMe = text; saved.push(text); } });
    expect(await (await fetch(`${base}/api/profile/learned`)).json()).toEqual({ learned: facts });
    const remove = () => fetch(`${base}/api/profile/learned/${facts[0]!.id}/remove`, { method: "POST" });
    const removed = await remove();
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true, aboutMe: "Handwritten note", learned: [] });
    expect((await remove()).status).toBe(404);
    expect(saved).toEqual(["Handwritten note"]);
  });

  it("keeps a learned fact retryable when saving About me fails", async () => {
    const from = { botId: "bot-123", botName: "Memo" };
    const facts = planLearned(from, ["Prefers quiet cafes"], "", "2026-09-28");
    commitLearned(facts);
    const original = `Handwritten note\n${facts[0]!.line}`;
    let aboutMe = original;
    let failSave = true;
    const base = await serve({
      aboutMe: () => aboutMe,
      saveAboutMe: (text) => {
        if (failSave) throw new Error("synthetic profile write failure");
        aboutMe = text;
      },
    });
    const remove = () => fetch(`${base}/api/profile/learned/${facts[0]!.id}/remove`, { method: "POST" });
    expect((await remove()).status).toBe(500);
    expect(aboutMe).toBe(original);
    expect(await (await fetch(`${base}/api/profile/learned`)).json()).toEqual({ learned: facts });
    expect(planLearned(from, [facts[0]!.text], "", "2026-09-28")).toHaveLength(1);

    failSave = false;
    const retried = await remove();
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ ok: true, aboutMe: "Handwritten note", learned: [] });
    expect(planLearned(from, [facts[0]!.text], aboutMe, "2026-09-28")).toEqual([]);
    expect((await remove()).status).toBe(404);
  });

  it("passes wrong methods and near-miss paths to the next handler", async () => {
    const base = await serve();
    for (const [method, path] of [
      ["POST", "/api/bots/bot-123/memory"],
      ["DELETE", "/api/bots/bot-123/memory"],
      ["DELETE", "/api/bots/bot-123/memory/journal"],
      ["GET", "/api/bots/bot-123/memory/open"],
      ["POST", "/api/bots/bot-123/memory/upkeep"],
      ["GET", "/api/bots/bot-123/memory/tidy"],
      ["POST", "/api/profile/learned"],
      ["GET", "/api/profile/learned/e1/remove"],
      ["POST", "/api/profile/learned/e1/remove/extra"],
      ["GET", "/api/bots/bot-123/memory/file/extra"],
      ["GET", "/api/bots/bot-123/memory/journal/e/revert/extra"],
      // No topic route: the panel reads a topic through /memory/file.
      ["GET", "/api/bots/bot-123/memory/topics/x.md"],
      ["GET", "/api/bots/bot-123/checkpoints"],
    ] as const) {
      const response = await fetch(`${base}${path}`, { method });
      expect(await response.json(), `${method} ${path}`).toEqual({ from: "inline routes" });
    }
  });

  it("runs the bodies this module writes through JSON hooks installed before dispatchRoutes", async () => {
    // index.ts installs the member narrowing (memberBody) with onJsonBody
    // before dispatchRoutes; memory payloads carry no bot or room records,
    // so a visible marker stands in for the narrowing to pin the mechanism.
    const base = await serve({}, (res) => onJsonBody(res, (body) => ({ ...(body as object), narrowed: true })));
    const response = await fetch(`${base}/api/bots/bot-123/memory`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ botId: "bot-123", narrowed: true });
  });

  it("is admin-scoped by path in request-auth.ts, every arm of it", () => {
    for (const [method, path] of [
      ["GET", "/api/bots/b1/memory"],
      ["PUT", "/api/bots/b1/memory"],
      ["GET", "/api/bots/b1/memory/file"],
      ["PUT", "/api/bots/b1/memory/file"],
      ["DELETE", "/api/bots/b1/memory/file"],
      ["GET", "/api/bots/b1/memory/journal"],
      ["POST", "/api/bots/b1/memory/journal/e1/revert"],
      ["GET", "/api/bots/b1/memory/upkeep"],
      ["POST", "/api/bots/b1/memory/tidy"],
      ["GET", "/api/profile/learned"],
      ["POST", "/api/profile/learned/e1/remove"],
      ["POST", "/api/bots/b1/memory/open"],
    ] as const) {
      expect(requiredScope(method, path), `${method} ${path}`).toBe("admin");
    }
  });
});

describe("the bot-memory family behind the gate on a real server", () => {
  let fixture: VerificationServer;
  const arms: Array<[string, string, unknown?]> = [
    ["GET", "/api/bots/b1/memory"],
    ["PUT", "/api/bots/b1/memory", { text: "x" }],
    ["GET", "/api/bots/b1/memory/file"],
    ["PUT", "/api/bots/b1/memory/file", { text: "x" }],
    ["DELETE", "/api/bots/b1/memory/file"],
    ["GET", "/api/bots/b1/memory/journal"],
    ["POST", "/api/bots/b1/memory/journal/e1/revert"],
    ["GET", "/api/bots/b1/memory/upkeep"],
    ["POST", "/api/bots/b1/memory/tidy"],
    ["GET", "/api/profile/learned"],
    ["POST", "/api/profile/learned/e1/remove"],
    ["POST", "/api/bots/b1/memory/open", { target: "folder" }],
  ];
  const call = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response.status;
  };

  beforeAll(async () => {
    fixture = await launchVerificationServer();
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it("refuses every arm for a request with no session, before any handler runs", async () => {
    for (const [method, path, body] of arms) {
      const status = await call(method, path, body, { origin: "https://elsewhere.example.test" });
      expect([401, 403], `${method} ${path}`).toContain(status);
    }
  });

  it("refuses every arm for a chat-only paired session: admin scope, keyed by path", async () => {
    // A pairing opened without scopes grants both, so ask for chat only.
    const opened = await fetch(`${fixture.info.url}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify({ scopes: ["client"] }) });
    expect(opened.status).toBe(200);
    const code = ((await opened.json()) as { code: string }).code;
    const paired = await fetch(`${fixture.info.url}/api/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: fixture.info.url, "user-agent": "memory-routes-lock" },
      body: JSON.stringify({ code }),
    });
    expect(paired.status).toBe(200);
    const token = ((await paired.json()) as { token: string }).token;
    for (const [method, path, body] of arms) {
      const status = await call(method, path, body, { authorization: `Bearer ${token}`, origin: fixture.info.url });
      expect(status, `${method} ${path}`).toBe(403);
    }
  });
});
