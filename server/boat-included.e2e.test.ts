// The full server with Cloud Pro's included Boat computers, over its real
// HTTP boundary, against one stub that plays Boat (/boat) and the Admin's
// relay (/relay). Settings' Boat key rules hold across the two accounts:
// an own key cannot be added while this installation still has computers on
// the included account (the new account cannot reach them), and once they
// are gone the own key wins and clearing it falls back to the included one.
// Neither key is ever sent to the other side. Disposable home; no network.
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const INCLUDED = `box_omb_${randomUUID()}`;
const OWN = "box_own_person_key";
const INCLUDED_BOX = "bx_23456789";
let stub: Server;
let stubBase = "";
/** Computers each account holds, by stub prefix. */
const accounts: Record<string, Array<{ id: string; name: string; state: string }>> = { boat: [], relay: [] };
const requests: Array<{ side: string; method: string; path: string; auth: string }> = [];
let home: string;
let journal: string;
let base: string;
let child: ChildProcess;
let log = "";

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub.test");
    req.resume();
    req.on("end", () => {
      const [, side = ""] = /^\/(boat|relay)\//.exec(url.pathname) ?? [];
      requests.push({ side, method: req.method ?? "GET", path: url.pathname, auth: String(req.headers.authorization ?? "") });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const expected = side === "relay" ? `Bearer ${INCLUDED}` : side === "boat" ? `Bearer ${OWN}` : "";
      if (!side || req.headers.authorization !== expected) return send(401, { ok: false, code: "unauthorized", message: "Unauthorized" });
      const path = url.pathname.replace(/^\/(boat|relay)\/api\/box\/v1/, "");
      const rows = accounts[side]!;
      if (path === "/boxes" && req.method === "GET") return send(200, { ok: true, boxes: rows, pageInfo: { nextCursor: null } });
      const box = /^\/boxes\/([^/]+)$/.exec(path);
      if (box && req.method === "GET") {
        const row = rows.find((candidate) => candidate.id === box[1]);
        return row ? send(200, { ok: true, box: row }) : send(404, { ok: false, code: "not_found", message: "Not found" });
      }
      send(404, { ok: false, code: "not_found", message: "Not found" });
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubBase = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;

  home = mkdtempSync(join(tmpdir(), "omb-boat-included-"));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  // One deliberately unknown engine: nothing probes an installed CLI.
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: { fixture: { driver: "not-a-real-driver" } } }));
  // A computer this installation made on the included account.
  accounts.relay = [{ id: INCLUDED_BOX, name: "ogb-included-fixture", state: "archived" }];
  journal = join(dataDir, "box-create-requests.json");
  writeFileSync(journal, JSON.stringify({ version: 1, requests: [{
    botId: "included-fixture-bot", requestBody: JSON.stringify({ fixture: true }), idempotencyKey: randomUUID(),
    createdAt: Date.now(), boxId: INCLUDED_BOX, resolved: true,
  }] }));

  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH,
      ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      OMB_BOX_API: `${stubBase}/boat/api/box/v1`,
      OMB_CLOUD_BOAT_URL: `${stubBase}/relay/api/box/v1`,
      OMB_CLOUD_BOAT_TOKEN: INCLUDED,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited:\n${log}`);
    try { if ((await api("GET", "/api/health")).body?.pid === child.pid) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`the server did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (stub) await new Promise<void>((resolve) => stub.close(() => resolve()));
  if (home) await removeTempDir(home);
});

const crossed = () => requests.filter((request) =>
  (request.side === "relay" && request.auth.includes(OWN)) || (request.side === "boat" && request.auth.includes(INCLUDED)));

it("refuses an own Boat key while this installation has computers on the included account", async () => {
  expect((await api("GET", "/api/config")).body.box).toEqual({ configured: true, included: true });
  const refused = await api("PUT", "/api/config", { box: { token: OWN } });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toBe("that Boat token cannot access the remembered cloud computers from this installation");
  expect((await api("GET", "/api/config")).body.box).toEqual({ configured: true, included: true });
  expect(readFileSync(join(home, ".openmausbot", "config.json"), "utf8")).not.toContain(OWN);
  expect(crossed()).toEqual([]);
});

it("once they are gone, the own key wins; clearing it falls back to the included account", async () => {
  // The included computer was deleted (its record retired).
  accounts.relay = [];
  writeFileSync(journal, JSON.stringify({ version: 1, requests: [] }));
  const added = await api("PUT", "/api/config", { box: { token: OWN } });
  expect(added.status, JSON.stringify(added.body)).toBe(200);
  expect(added.body.box).toEqual({ configured: true });
  const cleared = await api("PUT", "/api/config", { box: { token: "" } });
  expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
  expect(cleared.body.box).toEqual({ configured: true, included: true });
  expect(readFileSync(join(home, ".openmausbot", "config.json"), "utf8")).not.toContain(INCLUDED);
  expect(requests.some((request) => request.side === "boat" && request.auth === `Bearer ${OWN}`)).toBe(true);
  expect(crossed()).toEqual([]);
  expect(log).not.toContain(INCLUDED);
});
