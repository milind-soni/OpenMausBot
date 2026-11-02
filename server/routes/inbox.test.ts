import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";

import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { BEN, CLEO, session, teamInbox } from "../testing/team-inbox-fixture.ts";
import { createInboxRoutes } from "./inbox.ts";
import { PASS, type RouteContext } from "./table.ts";

const fixtures: Array<ReturnType<typeof teamInbox>> = [];
afterEach(() => { for (const made of fixtures.splice(0)) made.close(); });

function setup(options: Parameters<typeof teamInbox>[0] = {}) {
  const f = teamInbox(options);
  fixtures.push(f);
  const route = createInboxRoutes(f.team);
  const call = async (method: string, path: string, auth: RequestAuth = session(BEN.email)) => {
    const sent: { status?: number; body?: any } = {};
    const out = await route({
      req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(path, "http://127.0.0.1"), path, method, auth,
      readBody: (async () => ({})) as RouteContext["readBody"],
      json: ((_res: ServerResponse, status: number, body: unknown) => { sent.status = status; sent.body = body; }) as RouteContext["json"],
    });
    return { out, ...sent };
  };
  return { f, call };
}

it("answers each member with their own inbox, which a client session may read and mark", async () => {
  const { f, call } = setup();
  f.team.pass("scout", "cleo-private", "Ben", "The launch moved to Friday.");
  const mine = await call("GET", "/api/inbox");
  expect(mine).toMatchObject({ status: 200, body: { botId: "bens-chief", rows: [{ text: "The launch moved to Friday.", tab: "info", unread: true }] } });
  const line = mine.body.rows[0].id as string;
  expect((await call("POST", `/api/inbox/${line}/read`)).body.rows[0]).toMatchObject({ unread: false, tab: "info" });
  expect((await call("POST", `/api/inbox/${line}/done`)).body.rows[0]).toMatchObject({ tab: "done" });
  expect(await call("POST", `/api/inbox/${line}/done`, session(CLEO.email)), "someone else's line").toMatchObject({ status: 404 });
  expect((await call("GET", "/api/inbox", session(CLEO.email))).body.rows).toEqual([]);
  expect(await call("DELETE", "/api/inbox")).toMatchObject({ status: 405 });
  expect((await call("GET", "/api/needs-you")).out).toBe(PASS);
  for (const [method, path] of [["GET", "/api/inbox"], ["POST", `/api/inbox/${line}/read`], ["POST", `/api/inbox/${line}/done`]] as const) {
    expect(requiredScope(method, path), `${method} ${path}`).toBe("client");
  }
});

it("refuses to mark an open ask done, which only its answer settles", async () => {
  const { f, call } = setup();
  f.bots.find((bot) => bot.id === "reporter")!.tasks.push({ threadId: "rep-shared", title: "Weekly numbers" });
  f.store.appendMessage("rep-shared", { role: "bot", kind: "options", text: "Run a command?", card: { title: "Run a command?", subtitle: "rm -rf ./build", options: ["Allow", "Deny"], requestId: "req-1", tool: "Bash", requestType: "permission" } });
  f.team.route({ kind: "approval", botId: "reporter", botName: "Reporter", threadId: "rep-shared", title: "Reporter needs approval", body: "Run: rm -rf ./build" });
  const [ask] = (await call("GET", "/api/inbox")).body.rows;
  expect(ask).toMatchObject({ tab: "needs-you", card: { requestId: "req-1" } });
  expect(await call("POST", `/api/inbox/${ask.id}/done`)).toMatchObject({ status: 409 });
});

it("has no inbox off a team", async () => {
  const { call } = setup({ team: false });
  expect(await call("GET", "/api/inbox")).toMatchObject({ status: 404 });
});
