import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { createMcpUrlChecks, initializeAnswer, RECHECK_AFTER_ENGINE_MS, RECHECK_NOT_MCP_MS, type UrlAnswer } from "./mcp-url-checks.ts";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const WIKI = { wiki: { type: "http" as const, url: "https://wiki.example.test/", headers: {} } };
const PAUL = { id: "paul", name: "Paul" };

/** Checks over WIKI whose probe answers `answer()`, with a settable clock; `probes` counts the probes. */
function checksOf(answer: () => UrlAnswer | Promise<UrlAnswer>, options: { file?: string; servers?: () => Record<string, { url: string }> } = {}) {
  let clock = 1_000, probes = 0;
  const told: string[] = [];
  const checks = createMcpUrlChecks({
    servers: options.servers ?? (() => WIKI), users: () => [PAUL], tell: (text) => told.push(text), now: () => clock,
    probe: async () => { probes += 1; return answer(); }, ...(options.file ? { file: options.file } : {}),
  });
  return { checks, told, probes: () => probes, tick: (ms: number) => { clock += ms; } };
}

it("tries a server left out again after half an hour, keeping it out meanwhile, and lets it back once it answers as MCP", async () => {
  let answer: UrlAnswer = { ok: false, status: 405 };
  const { checks, probes, tick } = checksOf(() => answer);
  checks.checkAll();
  await checks.settled();
  expect(Object.keys(checks.usable({ ...WIKI }))).toEqual([]);
  tick(RECHECK_NOT_MCP_MS - 1);
  expect(Object.keys(checks.usable({ ...WIKI }))).toEqual([]);
  await checks.settled();
  expect(probes(), "not due yet").toBe(1);
  answer = { ok: true };
  tick(1);
  expect(Object.keys(checks.usable({ ...WIKI })), "out until the new check says otherwise").toEqual([]);
  await checks.settled();
  expect(probes()).toBe(2);
  expect(Object.keys(checks.usable({ ...WIKI }))).toEqual(["wiki"]);
});

it("keeps a server left out when a recheck merely times out: only a real MCP answer brings it back", async () => {
  let answer: UrlAnswer = { ok: false, status: 405 };
  const { checks, probes, tick } = checksOf(() => answer);
  checks.checkAll();
  await checks.settled();
  answer = { ok: false };
  tick(RECHECK_NOT_MCP_MS);
  checks.usable({ ...WIKI });
  await checks.settled();
  expect(probes()).toBe(2);
  expect(Object.keys(checks.usable({ ...WIKI })), "a timeout proves nothing").toEqual([]);
  tick(RECHECK_NOT_MCP_MS - 1);
  checks.usable({ ...WIKI });
  await checks.settled();
  expect(probes(), "the failed recheck counts as a try").toBe(2);
});

it("keeps a server in that answered 404 (it may hide until signed in), a redirect, or a probe that throws", async () => {
  for (const answer of [() => ({ ok: false, status: 404 }) as UrlAnswer, () => ({ ok: false, status: 307 }) as UrlAnswer, (): UrlAnswer => { throw new Error("boom"); }]) {
    const { checks } = checksOf(answer);
    checks.changed(["wiki"]);
    await checks.settled();
    expect(checks.off(["wiki"])).toEqual([]);
  }
});

it("checks a server an engine reports failed at most once per address in ten minutes; a change is checked at once", async () => {
  const { checks, probes, tick } = checksOf(() => ({ ok: true }));
  for (let session = 0; session < 5; session += 1) {
    checks.engineFailed(["wiki"]);
    await checks.settled();
  }
  expect(probes()).toBe(1);
  checks.changed(["wiki"]);
  await checks.settled();
  expect(probes()).toBe(2);
  tick(RECHECK_AFTER_ENGINE_MS);
  checks.engineFailed(["wiki"]);
  await checks.settled();
  expect(probes()).toBe(3);
});

it("tells the person once, across restarts, and again for a server whose address changed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-url-checks-"));
  dirs.push(dir);
  const file = join(dir, "mcp-url-checks.json");
  let current: Record<string, { url: string }> = WIKI;
  for (let start = 0; start < 2; start += 1) {
    const { checks, told } = checksOf(() => ({ ok: false, status: 405 }), { file, servers: () => current });
    checks.checkAll();
    await checks.settled();
    expect(told, `start ${start}`).toHaveLength(start === 0 ? 1 : 0);
  }
  current = { wiki: { url: "https://wiki.example.test/other" } };
  const { checks, told } = checksOf(() => ({ ok: false, status: 405 }), { file, servers: () => current });
  checks.checkAll();
  await checks.settled();
  expect(told).toHaveLength(1);
});

it("reads a web page's answer to MCP's first request as its HTTP status, and a refused connection as no status", async () => {
  // A web page that serves GET only.
  const page = await serve((request, response) => {
    response.writeHead(request.method === "GET" ? 200 : 405, { "content-type": "text/html" });
    response.end("<html></html>");
  });
  expect(await initializeAnswer({ type: "http", url: `${page}/pages/1/`, headers: {} }, { timeoutMs: 10_000 })).toEqual({ ok: false, status: 405 });
  expect(await initializeAnswer({ type: "http", url: "http://127.0.0.1:9/mcp", headers: {} }, { timeoutMs: 10_000 })).toEqual({ ok: false });
});

it("counts a server of MCP's older HTTP+SSE transport, saved as http, as MCP: it refuses the POST but streams to a GET", async () => {
  const legacy = await serve((request, response) => {
    if (request.method !== "GET") return void response.writeHead(405).end();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: endpoint\ndata: /messages?session=1\n\n");
  });
  expect(await initializeAnswer({ type: "http", url: `${legacy}/sse`, headers: {} }, { timeoutMs: 10_000 })).toEqual({ ok: true });
});

it("reads a legacy SSE server whatever case its content type is in, and a POST 405 whose GET tells nothing as no answer", async () => {
  const upper = await serve((request, response) => {
    if (request.method !== "GET") return void response.writeHead(405).end();
    response.writeHead(200, { "content-type": "Text/Event-Stream" });
    response.write("event: endpoint\ndata: /messages?session=1\n\n");
  });
  expect(await initializeAnswer({ type: "http", url: `${upper}/sse`, headers: {} }, { timeoutMs: 10_000 })).toEqual({ ok: true });
  const refused = await serve((request, response) => { response.writeHead(request.method === "GET" ? 401 : 405).end(); });
  expect(await initializeAnswer({ type: "http", url: `${refused}/mcp`, headers: {} }, { timeoutMs: 10_000 }), "neither MCP nor a page").toEqual({ ok: false });
});

it("never follows a redirect, so a server's keys never reach another address", async () => {
  const seen: IncomingHttpHeaders[] = [];
  const elsewhere = await serve((request, response) => { seen.push(request.headers); response.writeHead(405).end(); });
  const moved = await serve((_request, response) => { response.writeHead(307, { location: `${elsewhere}/mcp` }).end(); });
  const answer = await initializeAnswer({ type: "http", url: `${moved}/mcp`, headers: { "x-api-key": "key-value-1", authorization: "Bearer token-1" } }, { timeoutMs: 10_000 });
  expect(seen).toEqual([]);
  expect(answer).toEqual({ ok: false, status: 307 });
});
