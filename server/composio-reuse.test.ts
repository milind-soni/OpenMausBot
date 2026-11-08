// A fresh installation that connects a Composio project an earlier installation used picks up that installation's
// Composio user, so the apps connected there come back without connecting each one again.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prepareProjectSession } from "./composio.ts";
import { forgetProjectAuthConfigs } from "./composio-project.ts";

let api: Server;
let accounts: Array<Record<string, unknown>> = [];
let accountsDown = false;
const accountQueries: URLSearchParams[] = [];
const sessionUsers: string[] = [];

beforeAll(async () => {
  api = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers["x-api-key"] !== "ak_reuse") return json(401, { error: { message: "invalid project key" } });
    if (req.method === "GET" && url.pathname === "/api/v3.1/auth_configs") return json(200, { items: [] });
    if (req.method === "GET" && url.pathname === "/api/v3.1/connected_accounts") {
      accountQueries.push(url.searchParams);
      if (accountsDown) return json(503, { error: { message: "accounts unavailable" } });
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const items = accounts.slice(start, start + 2);
      return json(200, { items, next_cursor: start + 2 < accounts.length ? String(start + 2) : null });
    }
    if (req.method === "POST" && url.pathname === "/api/v3.1/tool_router/session") {
      sessionUsers.push(body.user_id);
      return json(201, {
        session_id: `trs_${sessionUsers.length}`,
        mcp: { type: "http", url: `https://app.composio.dev/tool_router/v3/trs_${sessionUsers.length}/mcp` },
        config: { user_id: body.user_id, multi_account: body.multi_account, auth_configs: {} },
      });
    }
    return json(404, { error: { message: "not found" } });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  process.env.OMB_COMPOSIO_API = `http://127.0.0.1:${(api.address() as { port: number }).port}/api/v3.1`;
});

afterAll(async () => {
  delete process.env.OMB_COMPOSIO_API;
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

beforeEach(() => {
  forgetProjectAuthConfigs();
  accounts = [];
  accountsDown = false;
  accountQueries.length = 0;
  sessionUsers.length = 0;
});

const account = (user_id: string, slug: string, status = "ACTIVE") => ({ id: `ca_${user_id}_${slug}`, user_id, status, toolkit: { slug } });
const NEW_USER = /^openmausbot_[0-9a-f-]{36}$/u;

describe("a fresh installation connecting a project an earlier installation used", () => {
  it("keeps the earlier installation's Composio user, so its connected apps come back", async () => {
    accounts = [
      account("openmausbot_earlier", "gmail"),
      account("openmausbot_earlier", "github"),
      account("openmausbot_earlier", "slack"),
      account("someone_elses_app", "notion"),
    ];
    const prepared = await prepareProjectSession("ak_reuse");
    expect(prepared.userId).toBe("openmausbot_earlier");
    expect(sessionUsers).toEqual(["openmausbot_earlier"]);
    expect(accountQueries.length).toBe(2);
    expect(accountQueries.every((query) => !query.has("user_ids"))).toBe(true);
  });

  it("reads only a few pages, and starts a new user when the project is too big to tell", async () => {
    accounts = Array.from({ length: 30 }, (_, n) => account("openmausbot_earlier", `app${n}`));
    const prepared = await prepareProjectSession("ak_reuse");
    expect(prepared.userId).toMatch(NEW_USER);
    expect(accountQueries.length).toBe(4);
  });

  it("starts a new user when the project has no earlier installation's live connections", async () => {
    accounts = [account("someone_elses_app", "notion"), account("openmausbot_gone", "gmail", "EXPIRED")];
    const prepared = await prepareProjectSession("ak_reuse");
    expect(prepared.userId).toMatch(NEW_USER);
  });

  it("starts a new user when several earlier installations share the project, since it can't tell whose apps are whose", async () => {
    accounts = [
      account("openmausbot_one", "gmail"),
      account("openmausbot_two", "github"),
      account("someone_elses_app", "notion"),
      account("someone_elses_app", "slack"),
    ];
    const prepared = await prepareProjectSession("ak_reuse");
    expect(prepared.userId).toMatch(NEW_USER);
    expect(accountQueries.length).toBe(1);
  });

  it("starts a new user when another installation's connections have only expired", async () => {
    accounts = [account("openmausbot_earlier", "gmail"), account("openmausbot_other", "github", "EXPIRED")];
    const prepared = await prepareProjectSession("ak_reuse");
    expect(prepared.userId).toMatch(NEW_USER);
  });

  it("still connects, as a new user, when Composio can't list the project's connections", async () => {
    accountsDown = true;
    const prepared = await prepareProjectSession("ak_reuse");
    expect(prepared.userId).toMatch(NEW_USER);
    expect(sessionUsers).toEqual([prepared.userId]);
  });

  it("never looks for another user when this installation already has one", async () => {
    accounts = [account("openmausbot_earlier", "gmail")];
    const prepared = await prepareProjectSession("ak_reuse", { userId: "openmausbot_mine" });
    expect(prepared.userId).toBe("openmausbot_mine");
    expect(accountQueries).toEqual([]);
  });
});
