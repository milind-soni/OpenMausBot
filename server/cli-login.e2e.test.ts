import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

describe("a terminal signs in with one click in the desktop app", () => {
  let fixture: VerificationServer;
  const owner = randomBytes(32).toString("base64url");
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };
  const asApp = (method: string, path: string, body?: unknown) => call(method, path, body, { "x-openmausbot-desktop-owner": owner, origin: fixture.info.url });
  const ask = async (scope?: "client") => {
    const verifier = randomBytes(32).toString("base64url");
    const verifierHash = createHash("sha256").update(verifier).digest("base64url");
    const started = await call("POST", "/api/auth/cli-login", { label: "openmausbot CLI on test", verifierHash, ...(scope ? { scope } : {}) });
    return { ...started, verifier, poll: (secret = verifier) => call("POST", `/api/auth/cli-login/${started.body.id}`, { verifier: secret }) };
  };

  beforeAll(async () => {
    // The launcher names its starter bot as the app would; every request in the tests below says who sends it.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init = {}) => realFetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), "x-openmausbot-desktop-owner": owner } });
    try {
      fixture = await launchVerificationServer({ ...process.env, OMB_TEST_DESKTOP_OWNER_TOKEN: owner });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it("keeps refusing a change from a program here without a session, and gives the terminal a session only after Allow", async () => {
    const made = await asApp("POST", "/api/bots", { name: "Test Bot 1", useDefaults: false, requireAvailableModel: false });
    expect(made.status).toBe(201);
    const botId = made.body.bot.id as string;
    expect((await call("DELETE", `/api/bots/${botId}`)).status).toBe(403);

    const request = await ask();
    expect(request.status).toBe(201);
    expect(request.body.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(request.body).not.toHaveProperty("token");

    const listed = await asApp("GET", "/api/auth/cli-login");
    expect(listed.body.requests).toEqual([expect.objectContaining({ id: request.body.id, code: request.body.code, local: true, scopes: ["admin", "client"], label: "openmausbot CLI on test" })]);
    expect(JSON.stringify(listed.body)).not.toContain(request.verifier);

    expect((await request.poll()).status).toBe(202);
    expect((await request.poll(randomBytes(32).toString("base64url"))).status).toBe(404);
    expect((await call("POST", `/api/auth/cli-login/${request.body.id}/allow`, {})).status).toBe(403);
    expect((await request.poll()).body.state).toBe("waiting");

    expect(await asApp("POST", `/api/auth/cli-login/${request.body.id}/allow`, {})).toMatchObject({ status: 200, body: { state: "allowed" } });
    const collected = await request.poll();
    expect(collected.status).toBe(200);
    expect(collected.body.token).toMatch(/^omb_sess_/);
    expect(collected.body.session.scopes).toEqual(["admin", "client"]);
    expect(collected.body.environment.environmentId).toEqual(expect.any(String));
    expect((await request.poll()).status).toBe(404);

    const bearer = { authorization: `Bearer ${collected.body.token}` };
    const second = await ask("client");
    expect(await call("POST", `/api/auth/cli-login/${second.body.id}/allow`, {}, bearer)).toMatchObject({ status: 200, body: { state: "allowed" } });
    const chatOnly = (await second.poll()).body;
    expect(chatOnly.session.scopes).toEqual(["client"]);
    expect((await call("POST", "/api/turns/stop", { all: true }, { authorization: `Bearer ${chatOnly.token}` })).status).toBe(403);
    expect((await call("POST", `/api/auth/cli-login/${second.body.id}/allow`, {}, { authorization: `Bearer ${chatOnly.token}` })).status).toBe(403);
    expect((await call("POST", "/api/turns/stop", { all: true })).status).toBe(403);
    expect(await call("POST", "/api/turns/stop", { all: true }, bearer)).toMatchObject({ status: 200, body: { stopped: 0 } });
    expect((await call("DELETE", `/api/bots/${botId}`, undefined, bearer)).status).toBe(200);
  });

  it("tells the terminal it was denied, refuses a web page, and caps how many may wait", async () => {
    const denied = await ask("client");
    expect((await asApp("GET", "/api/auth/cli-login")).body.requests[0].scopes).toEqual(["client"]);
    expect((await asApp("POST", `/api/auth/cli-login/${denied.body.id}/deny`, {})).status).toBe(200);
    expect(await denied.poll()).toMatchObject({ status: 403, body: { state: "denied" } });
    expect((await asApp("POST", `/api/auth/cli-login/${denied.body.id}/allow`, {})).status).toBe(404);

    const verifierHash = createHash("sha256").update("x".repeat(43)).digest("base64url");
    expect((await call("POST", "/api/auth/cli-login", { verifierHash }, { "sec-fetch-site": "cross-site", "sec-fetch-dest": "empty" })).status).toBe(403);

    const waiting = [];
    for (let index = 0; index < 2; index++) waiting.push(await ask());
    expect(waiting.map((request) => request.status)).toEqual([201, 201]);
    expect((await ask()).status).toBe(429);
    for (const request of waiting) await asApp("POST", `/api/auth/cli-login/${request.body.id}/deny`, {});
    expect((await asApp("GET", "/api/auth/cli-login")).body.requests).toEqual([]);
  });
});
