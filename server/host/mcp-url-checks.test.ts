import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";

import { createMcpUrlChecks, initializeAnswer, RECHECK_NOT_MCP_MS, type UrlAnswer } from "./mcp-url-checks.ts";

it("tries a server left out again after half an hour, keeping it out meanwhile, and lets it back once it answers as MCP", async () => {
  let clock = 1_000, answer: UrlAnswer = { ok: false, status: 404 };
  const servers = { wiki: { type: "http" as const, url: "https://wiki.example.test/", headers: {} } };
  let probes = 0;
  const checks = createMcpUrlChecks({
    servers: () => servers, users: () => [{ id: "paul", name: "Paul" }], tell: () => {}, now: () => clock,
    probe: async () => { probes += 1; return answer; },
  });
  checks.checkAll();
  await checks.settled();
  expect(Object.keys(checks.usable({ ...servers }))).toEqual([]);
  clock += RECHECK_NOT_MCP_MS - 1;
  expect(Object.keys(checks.usable({ ...servers }))).toEqual([]);
  await checks.settled();
  expect(probes, "not due yet").toBe(1);
  answer = { ok: true };
  clock += 1;
  expect(Object.keys(checks.usable({ ...servers })), "out until the new check says otherwise").toEqual([]);
  await checks.settled();
  expect(probes).toBe(2);
  expect(Object.keys(checks.usable({ ...servers }))).toEqual(["wiki"]);
});

it("a probe that throws keeps the server in", async () => {
  const servers = { wiki: { url: "https://wiki.example.test/mcp" } };
  const checks = createMcpUrlChecks({ servers: () => servers, users: () => [], tell: () => {}, probe: async () => { throw new Error("boom"); } });
  checks.check(["wiki"]);
  await checks.settled();
  expect(checks.off(["wiki"])).toEqual([]);
});

it("reads a web page's answer to MCP's first request as its HTTP status, and a refused connection as no status", async () => {
  // A web page that serves GET only, as a spreadsheet's address does.
  const page = createServer((request, response) => {
    response.writeHead(request.method === "GET" ? 200 : 405, { "content-type": "text/html" });
    response.end("<html></html>");
  });
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = page.address() as AddressInfo;
    expect(await initializeAnswer({ type: "http", url: `http://127.0.0.1:${port}/spreadsheets/u/1/`, headers: {} }, 10_000)).toEqual({ ok: false, status: 405 });
  } finally {
    await new Promise((resolve) => page.close(resolve));
  }
  expect(await initializeAnswer({ type: "http", url: "http://127.0.0.1:9/mcp", headers: {} }, 10_000)).toEqual({ ok: false });
});
