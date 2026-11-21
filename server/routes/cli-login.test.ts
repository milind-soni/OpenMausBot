import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createCliLogin, type CliLoginDeps } from "./cli-login.ts";

const OWNER: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const GUEST: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

/** The module behind a real listener: asking and polling go to `open` as before the gate, the rest to its routes as `auth`. */
async function listen(overrides: Partial<CliLoginDeps> = {}) {
  let now = 1_000_000;
  const revoked: string[] = [];
  const deps: CliLoginDeps = {
    sessions: {
      openPairing: vi.fn(() => ({ id: "p1", code: "C", credential: "omb_pair_credential", expiresAt: now + 60_000 })),
      exchange: vi.fn(() => ({ ok: true as const, token: "omb_sess_minted", session: { id: "s1", label: "t", scopes: ["admin", "client"], createdAt: now, lastSeenAt: now, expiresAt: now + 1 } as never })),
      revoke: vi.fn((id: string) => { revoked.push(id); return true; }),
    },
    refusal: () => null, loopbackRefusal: () => null, environment: () => ({ environmentId: "env" }), changed: vi.fn(),
    now: () => now, ...overrides,
  };
  const login = createCliLogin(deps);
  let auth: RequestAuth = OWNER;
  server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (await login.open(req, res, path, req.method ?? "GET")) return;
    await login.routes({ req, res, url: new URL(req.url ?? "/", "http://x"), path, method: req.method ?? "GET", auth, json, readBody });
    if (!res.writableEnded) json(res, 404, { error: "no route" });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const ask = async () => {
    const verifier = randomBytes(32).toString("base64url");
    const started = await call("POST", "/api/auth/cli-login", { verifierHash: createHash("sha256").update(verifier).digest("base64url") });
    return { ...started, poll: () => call("POST", `/api/auth/cli-login/${started.body.id}`, { verifier }) };
  };
  return { deps, call, ask, revoked, as: (next: RequestAuth) => { auth = next; }, later: (ms: number) => { now += ms; } };
}

describe("the terminal sign-in route", () => {
  it("refuses a program on a shared server's own machine, where that is a bot's shell", async () => {
    const { ask } = await listen({ loopbackRefusal: () => "on this shared server a program here may not ask to sign in" });
    expect(await ask()).toMatchObject({ status: 403, body: { error: expect.stringContaining("shared server") } });
  });

  it("lets one place hold two waiting requests, and only the owner or an admin answer them", async () => {
    const { ask, call, as } = await listen();
    const first = await ask();
    expect((await ask()).status).toBe(201);
    expect((await ask()).status).toBe(429);
    as(GUEST);
    expect((await call("GET", "/api/auth/cli-login")).status).toBe(403);
    expect((await call("POST", `/api/auth/cli-login/${first.body.id}/allow`, {})).status).toBe(403);
    expect((await first.poll()).status).toBe(202);
  });

  it("says why when the session cannot be made, and revokes one the terminal never collects", async () => {
    const failing = await listen();
    vi.mocked(failing.deps.sessions.openPairing).mockImplementationOnce(() => { throw Object.assign(new Error("Only an admin session can sign in to this Cloud."), { code: "cloud_personal" }); });
    const refused = await failing.ask();
    expect(await failing.call("POST", `/api/auth/cli-login/${refused.body.id}/allow`, {})).toMatchObject({ status: 403, body: { error: "Only an admin session can sign in to this Cloud." } });
    expect(await refused.poll()).toMatchObject({ status: 403, body: { state: "failed", error: "Only an admin session can sign in to this Cloud." } });

    const forgotten = await failing.ask();
    expect((await failing.call("POST", `/api/auth/cli-login/${forgotten.body.id}/allow`, {})).status).toBe(200);
    failing.later(3 * 60_000);
    expect((await forgotten.poll()).status).toBe(404);
    expect(failing.revoked).toEqual(["s1"]);
  });

  it("ends a request nobody answers after ten minutes", async () => {
    const { ask, call, later } = await listen();
    const request = await ask();
    later(10 * 60_000);
    expect((await request.poll()).status).toBe(404);
    expect((await call("GET", "/api/auth/cli-login")).body.requests).toEqual([]);
  });
});
