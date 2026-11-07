// The move grant inside an encrypted session: the e2e refusals must run before the grant is read or the owner is asked.
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createE2EOrigin } from "../src/e2e/origin.ts";
import { MoveGrants } from "../src/move-grants.ts";
import { createProxyHandler } from "../src/proxy.ts";

const MARK = "x-openmausbot-companion-move";
const servers: Server[] = [];
const listen = (server: Server) => new Promise<number>((resolve) => {
  servers.push(server);
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});
const closers: Array<() => void> = [];
afterEach(() => {
  closers.splice(0).forEach((close) => close());
  servers.splice(0).forEach((server) => { server.closeAllConnections(); server.close(); });
});

async function fixture() {
  const seen: Array<{ method: string; headers: IncomingHttpHeaders }> = [];
  const harness = createServer((req, res) => {
    seen.push({ method: req.method ?? "", headers: req.headers });
    req.resume();
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
  });
  const devices: Record<string, { id: string; name: string; cloudDesktopAccess: boolean; browserControlAccess: boolean; e2eAt?: number }> = {
    tokX: { id: "devX", name: "Omkar's iPhone", cloudDesktopAccess: false, browserControlAccess: false, e2eAt: 1 },
    tokY: { id: "devY", name: "Other phone", cloudDesktopAccess: false, browserControlAccess: false },
  };
  const moves = new MoveGrants();
  const asks: Array<{ deviceId: string; deviceName: string; bots: number }> = [];
  const proxy = createProxyHandler({
    harnessPort: await listen(harness),
    mutationToken: () => "M".repeat(43),
    authenticate: (token) => (token ? devices[token] ?? null : null),
    redeem: () => ({ error: "no" }),
    serverName: () => "mac",
    moves,
    askOwner: (ask) => { asks.push(ask); return true; },
    e2eDescriptor: () => null,
    e2ePaired: () => {},
  });
  const origin = createE2EOrigin((req, res) => proxy(req, res), (req, socket, head) => proxy.upgrade(req, socket, head));
  closers.push(() => origin.close());
  const lanPort = await listen(createServer((req, res) => proxy(req, res, "lan")));

  const viaE2E = async (peer: object, method: string, path: string, token?: string, body?: string, extra: Record<string, string> = {}) => {
    const near = await origin.connect({ peer, route: "relay" } as never);
    const head = [`${method} ${path} HTTP/1.1`, "Host: x", "Connection: close", ...(token ? [`Authorization: Bearer ${token}`] : []),
      ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
      ...(body !== undefined ? ["Content-Type: application/json", `Content-Length: ${Buffer.byteLength(body)}`] : ["Content-Length: 0"])];
    near.write(`${head.join("\r\n")}\r\n\r\n${body ?? ""}`);
    const chunks: Buffer[] = [];
    near.on("data", (chunk: Buffer) => chunks.push(chunk));
    await new Promise((resolve) => { near.on("end", resolve); near.on("close", resolve); setTimeout(resolve, 3000); });
    near.destroy();
    return Buffer.concat(chunks).toString("utf8").split("\r\n")[0] ?? "";
  };
  const viaLan = (method: string, path: string, token: string) => new Promise<number>((resolve) => {
    request({ port: lanPort, host: "127.0.0.1", method, path, headers: { authorization: `Bearer ${token}`, "content-length": "0" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).end();
  });
  return { seen, asks, moves, viaE2E, viaLan, last: () => seen.at(-1) };
}

const X = { kind: "device", id: "devX" };

describe("a move inside an encrypted session", () => {
  it("forwards a move-capable request unmarked when no grant is held", async () => {
    const { viaE2E, seen, last } = await fixture();
    expect(await viaE2E(X, "POST", "/api/bots", "tokX", "{}")).toContain("200");
    expect(seen).toHaveLength(1);
    expect(last()?.headers[MARK]).toBeUndefined();
  });

  it("drops a mark header the phone made up", async () => {
    const { viaE2E, seen, last } = await fixture();
    await viaE2E(X, "POST", "/api/bots", "tokX", "{}", { [MARK]: "1" });
    expect(seen).toHaveLength(1);
    expect(last()?.headers[MARK]).toBeUndefined();
  });

  it("refuses a move-only route at the sidecar without a grant", async () => {
    const { viaE2E, seen } = await fixture();
    expect(await viaE2E(X, "PUT", "/api/cloud-send/kind", "tokX", "{}")).toMatch(/40[34]/);
    expect(seen).toHaveLength(0);
  });

  it("hands the ask to the owner with the bearer's id and name", async () => {
    const { viaE2E, asks } = await fixture();
    await viaE2E(X, "POST", "/api/companion/move", "tokX", JSON.stringify({ v: 1, bots: 3 }));
    expect(asks).toEqual([expect.objectContaining({ deviceId: "devX", deviceName: "Omkar's iPhone", bots: 3 })]);
  });

  it("marks a move route and carries the relay token once the owner allowed", async () => {
    const { viaE2E, moves, seen, last } = await fixture();
    await viaE2E(X, "POST", "/api/companion/move", "tokX", JSON.stringify({ v: 1, bots: 3 }));
    expect(moves.allow("devX", (moves.state("devX") as { expiresAt: number }).expiresAt)).toBe(true);
    await viaE2E(X, "PUT", "/api/cloud-send/kind", "tokX", "{}");
    expect(seen).toHaveLength(1);
    expect(last()?.headers[MARK]).toBe("1");
    expect(last()?.headers["x-openmausbot-companion-auth"]).toBe("M".repeat(43));
    expect(last()?.headers["x-openmausbot-companion-device"]).toBe("devX");
  });

  it("leaves a route that is not a move route unmarked under a grant", async () => {
    const { viaE2E, moves, seen, last } = await fixture();
    await viaE2E(X, "POST", "/api/companion/move", "tokX", JSON.stringify({ v: 1, bots: 3 }));
    moves.allow("devX", (moves.state("devX") as { expiresAt: number }).expiresAt);
    await viaE2E(X, "GET", "/api/bots", "tokX");
    expect(seen).toHaveLength(1);
    expect(last()?.headers[MARK]).toBeUndefined();
  });

  it("refuses another device's token on the session with 401, even under that device's grant", async () => {
    const { viaE2E, moves, seen } = await fixture();
    await viaE2E({ kind: "device", id: "devY" }, "POST", "/api/companion/move", "tokY", JSON.stringify({ v: 1, bots: 1 }));
    moves.allow("devY", (moves.state("devY") as { expiresAt: number }).expiresAt);
    seen.length = 0;
    expect(await viaE2E(X, "PUT", "/api/cloud-send/kind", "tokY", "{}")).toContain("401");
    expect(seen).toHaveLength(0);
  });

  it("answers a session still pairing 401 and raises no dialog", async () => {
    const { viaE2E, asks } = await fixture();
    expect(await viaE2E({ kind: "pairing", admHash: null }, "POST", "/api/companion/move", "tokX", JSON.stringify({ v: 1, bots: 1 }))).toContain("401");
    expect(asks).toHaveLength(0);
  });

  it("answers plain Wi-Fi 426 for a device that went e2e, on a move route and on the ask, under a live grant", async () => {
    const { viaLan, moves, seen, viaE2E } = await fixture();
    await viaE2E(X, "POST", "/api/companion/move", "tokX", JSON.stringify({ v: 1, bots: 1 }));
    moves.allow("devX", (moves.state("devX") as { expiresAt: number }).expiresAt);
    expect(await viaLan("PUT", "/api/cloud-send/kind", "tokX")).toBe(426);
    expect(await viaLan("POST", "/api/companion/move", "tokX")).toBe(426);
    expect(seen).toHaveLength(0);
  });
});
