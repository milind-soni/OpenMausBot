// Starter credit behind a web front end: every visitor reaches the server from
// the front end's few addresses, as through a Vercel rewrite, and the proxy on
// this machine adds that address to X-Forwarded-For. The front end names the
// visitor in its own header, which counts only when the operator names it.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, readBody, setResponseOwner } from "../harness/http.ts";
import { setCreditLedgerForTests } from "../nation-credit-context.ts";
import { CreditLedger } from "../nation-credits.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createNationCreditRoutes } from "./nation-credits.ts";
import { dispatchRoutes } from "./table.ts";

const FRONT_END = "76.76.21.9";
const servers: Server[] = [];

function member(email: string): RequestAuth {
  const session = { id: randomUUID(), tokenHash: "0".repeat(64), label: "Browser", scopes: ["client"] as const, createdAt: 0, lastSeenAt: 0, expiresAt: Date.now() + 1e9, email, userId: "usr_" + email };
  return { kind: "session", session: { ...session, scopes: ["client"] }, via: "cookie", scopes: ["client"] };
}
const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

beforeEach(() => {
  vi.stubEnv("NATION_TREASURY_ROBINHOOD", "");
  vi.stubEnv("NATION_TRUST_PROXY", "");
  vi.stubEnv("NATION_CLIENT_IP_HEADER", "");
  setCreditLedgerForTests(new CreditLedger(":memory:"));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  setCreditLedgerForTests(undefined);
  vi.unstubAllEnvs();
});

async function serve(): Promise<(auth: RequestAuth, path: string, headers?: Record<string, string>) => Promise<{ status: number; body: any }>> {
  let auth: RequestAuth = owner;
  const route = createNationCreditRoutes();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    setResponseOwner(res, false);
    try {
      const handled = await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "credit routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (as, path, headers = {}) => {
    auth = as;
    const response = await fetch(base + path, { headers });
    return { status: response.status, body: await response.json() };
  };
}

/** Three people on three phones, one after another through the front end. */
async function threeVisitors(call: Awaited<ReturnType<typeof serve>>) {
  const balances: number[] = [];
  for (const [index, visitor] of ["198.51.100.7", "203.0.113.44", "192.0.2.80"].entries()) {
    const reply = await call(member(`visitor${index}@example.test`), "/api/credits/status", {
      "x-forwarded-for": `${visitor}, ${FRONT_END}`, "x-vercel-forwarded-for": visitor, cookie: `nation_device=${randomUUID()}`,
    });
    expect(reply.status).toBe(200);
    balances.push(reply.body.balanceUsd);
  }
  return balances;
}

describe("starter credit behind a web front end", () => {
  it("runs out after two visitors a day while the front end's address stands for everyone", async () => {
    expect(await threeVisitors(await serve())).toEqual([3, 3, 0]);
  });

  it("reaches every visitor once the operator names the front end's visitor header", async () => {
    vi.stubEnv("NATION_CLIENT_IP_HEADER", "x-vercel-forwarded-for");
    expect(await threeVisitors(await serve())).toEqual([3, 3, 3]);
  });

  it("shows the owner the address their own request is counted as, and nobody else", async () => {
    vi.stubEnv("NATION_PRODUCT_OWNER", "1");
    vi.stubEnv("NATION_CLIENT_IP_HEADER", "x-vercel-forwarded-for");
    const call = await serve();
    const headers = { "x-forwarded-for": `198.51.100.7, ${FRONT_END}`, "x-vercel-forwarded-for": "198.51.100.7" };
    const seen = await call(owner, "/api/admin/credits/client-address", headers);
    expect(seen).toEqual({ status: 200, body: {
      address: "198.51.100.7", from: "x-vercel-forwarded-for", peer: "127.0.0.1",
      headers: { "x-forwarded-for": `198.51.100.7, ${FRONT_END}`, "x-real-ip": null, "x-vercel-forwarded-for": "198.51.100.7" },
    } });
    expect((await call(member("visitor@example.test"), "/api/admin/credits/client-address", headers)).status).toBe(403);
  });
});
