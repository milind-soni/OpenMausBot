import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { JournalEntry } from "../saved-steps/driver-wire.ts";
import type { JournalCapability, JournalScope } from "../saved-steps/journal.ts";
import { COMPUTER_JOURNAL_PATH } from "../saved-steps/journal-tap.ts";
import { createComputerJournalRoutes } from "./computer-journal.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const HOST: JournalCapability = { botId: "b1", threadId: "t1", generation: "g1", kind: "computer" };
const ENTRY: JournalEntry = { tool: "click", arguments: { element: "Save" }, result: { isError: false } };

async function fixture(capability: JournalCapability = HOST, enabled = true) {
  let currentBody: unknown;
  const recorded: Array<{ scope: JournalScope; entry: JournalEntry }> = [];
  const routes = [createComputerJournalRoutes({
    capability,
    enabled: () => enabled,
    readBody: async () => currentBody,
    record: (scope, entry) => void recorded.push({ scope, entry }),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) {
      json(res, 404, { from: "no route" });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = async (body: unknown, method = "POST", path = COMPUTER_JOURNAL_PATH) => {
    currentBody = body;
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { recorded, send };
}

describe(`POST ${COMPUTER_JOURNAL_PATH}`, () => {
  it("records a host turn's entry", async () => {
    const { recorded, send } = await fixture();
    expect(await send({ ...ENTRY, botId: "someone-else", threadId: "t9" })).toEqual({ status: 200, body: { ok: true } });
    expect(recorded).toEqual([{ scope: { botId: "b1", threadId: "t1", generation: "g1" }, entry: ENTRY }]);
  });

  it("drops entries while saved steps are off", async () => {
    const { recorded, send } = await fixture(HOST, false);
    expect(await send(ENTRY)).toEqual({ status: 200, body: { ok: true, recorded: false } });
    expect(recorded).toEqual([]);
  });

  it("refuses a Local VM or cloud turn with 403", async () => {
    for (const capability of [{ ...HOST, localVmTarget: {} }, { ...HOST, boxId: null }, { ...HOST, boxId: "box1" }, { ...HOST, kind: "browser" }]) {
      const { recorded, send } = await fixture(capability);
      expect((await send(ENTRY)).status).toBe(403);
      expect(recorded).toEqual([]);
    }
  });

  it("answers 400 to a malformed body", async () => {
    const { recorded, send } = await fixture();
    expect((await send({ tool: "../x", arguments: {}, result: { isError: false } })).status).toBe(400);
    expect((await send({ tool: "click", arguments: {}, result: {} })).status).toBe(400);
    expect(recorded).toEqual([]);
  });

  it("passes other paths and methods", async () => {
    const { recorded, send } = await fixture();
    expect(await send(ENTRY, "POST", "/api/internal/computer/other")).toEqual({ status: 404, body: { from: "no route" } });
    expect(await send(ENTRY, "GET")).toEqual({ status: 404, body: { from: "no route" } });
    expect(recorded).toEqual([]);
  });
});
