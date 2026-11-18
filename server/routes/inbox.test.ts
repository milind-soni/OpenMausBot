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
  expect(await call("GET", "/api/inbox/count")).toMatchObject({ status: 200, body: { count: 1 } });
  expect(requiredScope("GET", "/api/inbox/count")).toBe("client");
  const mine = await call("GET", "/api/inbox");
  expect(mine).toMatchObject({ status: 200, body: { botId: "bens-chief", rows: [{ text: "The launch moved to Friday.", tab: "info", unread: true }] } });
  const line = mine.body.rows[0].id as string;
  expect((await call("POST", `/api/inbox/${line}/read`)).body.rows[0]).toMatchObject({ unread: false, tab: "info" });
  expect((await call("POST", `/api/inbox/${line}/done`)).body.rows[0]).toMatchObject({ tab: "done" });
  expect(await call("POST", `/api/inbox/${line}/done`, session(CLEO.email)), "someone else's line").toMatchObject({ status: 404, body: { error: "That line is not in your inbox.", errorKey: "serverError.inbox.lineMissing" } });
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
  expect(await call("POST", `/api/inbox/${ask.id}/done`)).toMatchObject({ status: 409, body: { error: "This waits on your answer: answer it, or close it, where it asks.", errorKey: "serverError.inbox.answerRequired" } });
});

it("has no inbox off a team", async () => {
  const { call } = setup({ team: false });
  expect(await call("GET", "/api/inbox")).toMatchObject({ status: 404, body: { error: "There is no inbox here.", errorKey: "serverError.inbox.missing" } });
});

it("reads every unread line at once for the caller alone, leaves an ask waiting on its card, and repeats harmlessly", async () => {
  const { f, call } = setup();
  f.bots.find((bot) => bot.id === "reporter")!.tasks.push({ threadId: "rep-shared", title: "Weekly numbers" });
  f.team.pass("scout", "cleo-private", "Ben", "The launch moved to Friday.");
  f.team.pass("scout", "ben-private", "Cleo", "Cleo, the draft is ready.");
  f.store.appendMessage("rep-shared", { role: "bot", kind: "options", text: "Run a command?", card: { title: "Run a command?", subtitle: "rm -rf ./build", options: ["Allow", "Deny"], requestId: "req-1", tool: "Bash", requestType: "permission" } });
  f.team.route({ kind: "approval", botId: "reporter", botName: "Reporter", threadId: "rep-shared", title: "Reporter needs approval", body: "Run: rm -rf ./build" });
  const before = (await call("GET", "/api/inbox")).body.rows as Array<{ id: string; tab: string; unread: boolean; card?: unknown }>;
  expect(before.length).toBeGreaterThanOrEqual(2);
  expect(before.every((row) => row.unread)).toBe(true);
  const cleoBefore = (await call("GET", "/api/inbox", session(CLEO.email))).body.rows as Array<{ unread: boolean }>;
  expect(cleoBefore.some((row) => row.unread)).toBe(true);

  const first = await call("POST", "/api/inbox/read-all");
  expect(first.status).toBe(200);
  expect(first.body.rows.map((row: { id: string }) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
  expect(first.body.rows.every((row: { unread: boolean }) => !row.unread)).toBe(true);
  expect(first.body.rows.map((row: { id: string; tab: string }) => [row.id, row.tab]).sort()).toEqual(before.map((row) => [row.id, row.tab]).sort());
  const ask = first.body.rows.find((row: { kind: string }) => row.kind === "ask");
  expect(ask, "the ask is still listed, on the needs-you tab, with its card unanswered").toMatchObject({ tab: "needs-you", unread: false, card: { requestId: "req-1" } });
  expect(ask.card.answered).toBeUndefined();
  expect(f.store.messagesFor("rep-shared").find((message) => message.kind === "options")!.card).not.toHaveProperty("answered");

  expect(await call("POST", "/api/inbox/read-all")).toMatchObject({ status: 200, body: first.body });
  expect((await call("GET", "/api/inbox/count")).body.count, "only the ask still waits on them").toBe(1);
  expect(f.team.markAllRead(session(BEN.email))).toBe(0);

  expect((await call("GET", "/api/inbox", session(CLEO.email))).body.rows, "another person's rows stay unread").toEqual(cleoBefore);
  expect(await call("GET", "/api/inbox/read-all")).toMatchObject({ status: 405 });
  expect(await call("POST", "/api/inbox/read-all", session("stranger@nowhere.test"))).toMatchObject({ status: 404, body: { errorKey: "serverError.inbox.missing" } });
  expect(requiredScope("POST", "/api/inbox/read-all")).toBe("client");
});

it("has no bulk read off a team", async () => {
  const { call } = setup({ team: false });
  expect(await call("POST", "/api/inbox/read-all")).toMatchObject({ status: 404, body: { errorKey: "serverError.inbox.missing" } });
});
