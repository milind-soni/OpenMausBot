import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Message } from "../store.ts";
import { createBugReportCardRoutes } from "./bug-report-cards.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve() {
  const rows: Message[] = [{ id: "m1", at: 1, role: "bot", kind: "bugreport", text: "Scout drafted a bug report", bugReport: { summary: "Broken", details: "" } }];
  const resume = vi.fn((_threadId: string, _messageId: string, _text: string) => true);
  const owners: Array<[string, string]> = [];
  const routes = [createBugReportCardRoutes({
    store: {
      activePath: (threadId) => (threadId === "t1" ? rows : []),
      patchMessage: (_threadId, messageId, patch) => {
        const index = rows.findIndex((row) => row.id === messageId);
        rows[index] = { ...rows[index]!, ...patch };
        return rows[index]!;
      },
    },
    ownerOf: (botId, threadId) => { owners.push([botId, threadId]); return botId === "scout" ? {} : null; },
    resume,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { base, rows, resume, owners, post };
}

describe("bug report card routes", () => {
  it("records Send for the named bot, thread and card, and resumes the bot with the report id", async () => {
    const { rows, resume, owners, post } = await serve();
    expect(await post("/api/bots/scout/bug-report-cards/m1/sent", { threadId: "t1", reportId: "br_7" })).toEqual({ status: 200, body: { sent: true, resumed: true } });
    expect(owners).toEqual([["scout", "t1"]]);
    expect(resume).toHaveBeenCalledExactlyOnceWith("t1", "m1", expect.stringContaining("(report br_7)"));
    expect(rows[0]!.bugReport).toEqual({ summary: "Broken", details: "", sent: true, reportId: "br_7", resumed: true });
  });

  it("records Dismiss", async () => {
    const { rows, post } = await serve();
    expect(await post("/api/bots/scout/bug-report-cards/m1/dismissed", { threadId: "t1" })).toEqual({ status: 200, body: { dismissed: true, resumed: true } });
    expect(rows[0]!.bugReport).toMatchObject({ dismissed: true });
  });

  it("refuses another bot's card and another conversation", async () => {
    const { resume, post } = await serve();
    expect((await post("/api/bots/piper/bug-report-cards/m1/sent", { threadId: "t1" })).status).toBe(404);
    expect((await post("/api/bots/scout/bug-report-cards/m1/sent", { threadId: "t2" })).status).toBe(404);
    expect(resume).not.toHaveBeenCalled();
  });

  it("leaves other methods and paths to the next route", async () => {
    const { base, resume, post } = await serve();
    expect(await (await fetch(`${base}/api/bots/scout/bug-report-cards/m1/sent`)).json()).toEqual({ from: "inline routes" });
    expect((await post("/api/bots/scout/bug-report-cards/m1/send", { threadId: "t1" })).body).toEqual({ from: "inline routes" });
    expect(resume).not.toHaveBeenCalled();
  });
});
