import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountGateway, LINK_EXPIRED, maskEmail, SIGNED_OUT, SIGNUPS_FULL } from "./account-gateway.ts";
import type { AccountMailer, MagicLinkMail } from "./account-mail.ts";
import { AccountStore, type WorkspaceRef } from "./accounts.ts";
import { clientAddress } from "./request-auth.ts";
import type { Scope } from "./sessions.ts";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))); });

async function setup(options: { appUrl?: string | null; maxWorkspaces?: number; failMail?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const accounts = new AccountStore(":memory:");
  const mail: MagicLinkMail[] = [];
  const mailer: AccountMailer = {
    kind: "smtp",
    async send(message) {
      if (options.failMail) throw new Error("smtp 535 authentication failed");
      mail.push(message);
    },
  };
  const issued: Array<{ scopes: Scope[]; email?: string }> = [];
  const failures: string[] = [];
  const started: WorkspaceRef[] = [];
  const forwarded: Array<{ ref: WorkspaceRef; ip: string; path: string }> = [];
  const logs: string[] = [];
  const gateway = createAccountGateway({
    accounts,
    mailer,
    host: {
      async ensure(ref) { started.push(ref); return { port: 1, token: "t" }; },
      async forward(req, res, ref, ip) {
        forwarded.push({ ref, ip, path: req.url ?? "" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ workspace: ref.id }));
      },
    },
    sessions: {
      issue: (input) => { issued.push(input); return { token: "omb_sess_founder", session: { id: "s", label: input.label, scopes: input.scopes, createdAt: 0, lastSeenAt: 0, expiresAt: Date.now() + 86_400_000 } }; },
      attemptAllowed: () => ({ ok: true }),
      noteFailure: (source) => { failures.push(source); },
      clearFailures: () => {},
    },
    founderCookie: "omb_session_8799_env",
    founderScopes: (email) => (email === "founder@example.test" ? ["admin", "client"] : email === "cos@example.test" ? ["client"] : null),
    appUrl: () => (options.appUrl === undefined ? "https://thenation.city/swarm" : options.appUrl),
    environmentId: "env-1",
    maxWorkspaces: options.maxWorkspaces,
    env: options.env ?? {},
    log: (line) => logs.push(line),
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await gateway.handle(req, res, url)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ from: "desk" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, init: { body?: unknown; headers?: Record<string, string>; method?: string } = {}) => {
    const response = await fetch(base + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) as any, cookies: response.headers.getSetCookie() };
  };
  const tokenFrom = (message: MagicLinkMail) => message.link.split("#login=")[1]!;
  return { accounts, mail, issued, failures, started, forwarded, logs, call, tokenFrom, base };
}

describe("sending a sign-in link", () => {
  it("links to the configured app address whatever Host the request claims", async () => {
    const { call, mail } = await setup();
    const reply = await call("/api/auth/magic/start", { body: { email: " Alice@Example.test " }, headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" } });
    expect(reply.status).toBe(200);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.to).toBe("alice@example.test");
    expect(mail[0]!.link).toMatch(/^https:\/\/thenation\.city\/swarm\/#login=nml_[A-Za-z0-9_-]{43}$/);
    expect(mail[0]!.expiresInMinutes).toBe(15);
  });

  it("sends nothing through a proxy when no app address is configured", async () => {
    const { call, mail } = await setup({ appUrl: null });
    const reply = await call("/api/auth/magic/start", { body: { email: "alice@example.test" }, headers: { "x-forwarded-host": "evil.example" } });
    expect(reply.status).toBe(503);
    expect(mail).toHaveLength(0);
  });

  it("uses a loopback request's own origin in development", async () => {
    const { call, mail, base } = await setup({ appUrl: null });
    expect((await call("/api/auth/magic/start", { body: { email: "alice@example.test" } })).status).toBe(200);
    expect(mail[0]!.link.startsWith(`${base}/#login=`)).toBe(true);
  });

  it("refuses a bad address, a non-JSON body and too many requests", async () => {
    const { call, base } = await setup();
    expect((await call("/api/auth/magic/start", { body: { email: "nope" } })).status).toBe(400);
    const form = await fetch(`${base}/api/auth/magic/start`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=a@example.test" });
    expect(form.status).toBe(415);
    for (let i = 0; i < 3; i++) expect((await call("/api/auth/magic/start", { body: { email: "alice@example.test" } })).status).toBe(200);
    const limited = await call("/api/auth/magic/start", { body: { email: "alice@example.test" } });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatch(/Too many sign-in emails/);
  });

  it("counts each visitor behind a web front end once the operator names its header", async () => {
    // Every request reaches the server from the front end's one address, as
    // through a Vercel rewrite; only the named header tells visitors apart.
    const viaFrontEnd = (visitor: string) => ({ "x-forwarded-for": `${visitor}, 76.76.21.9`, "x-vercel-forwarded-for": visitor });
    const exhaust = async (call: Awaited<ReturnType<typeof setup>>["call"]) => {
      for (let i = 0; i < 20; i++) expect((await call("/api/auth/magic/start", { body: { email: `a${i}@example.test` }, headers: viaFrontEnd("198.51.100.7") })).status).toBe(200);
      expect((await call("/api/auth/magic/start", { body: { email: "a20@example.test" }, headers: viaFrontEnd("198.51.100.7") })).status).toBe(429);
      return (await call("/api/auth/magic/start", { body: { email: "b@example.test" }, headers: viaFrontEnd("203.0.113.44") })).status;
    };
    expect(await exhaust((await setup()).call)).toBe(429);
    expect(await exhaust((await setup({ env: { NATION_CLIENT_IP_HEADER: "x-vercel-forwarded-for" } })).call)).toBe(200);
  });

  it("reports a mail failure without putting the link in the log", async () => {
    const { call, logs } = await setup({ failMail: true });
    const reply = await call("/api/auth/magic/start", { body: { email: "alice@example.test" } });
    expect(reply.status).toBe(502);
    expect(reply.body.error).toBe("We could not send the email. Try again in a minute.");
    expect(logs.join("\n")).toContain("a…e@example.test");
    expect(logs.join("\n")).toContain("535");
    expect(logs.join("\n")).not.toMatch(/nml_|alice@/);
  });
});

describe("using a sign-in link", () => {
  it("gives a stranger an account cookie and a new workspace, and starts it", async () => {
    const { call, mail, tokenFrom, accounts, started, issued } = await setup();
    await call("/api/auth/magic/start", { body: { email: "alice@example.test" } });
    const token = tokenFrom(mail[0]!);
    expect((await call("/api/auth/magic/peek", { body: { token } })).body).toEqual({ email: "alice@example.test" });
    const verified = await call("/api/auth/magic/verify", { body: { token, label: "Safari on iPhone" } });
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ ok: true, destination: "workspace", created: true });
    expect(verified.cookies).toEqual([
      expect.stringMatching(/^nation_account=nas_[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/),
      "omb_session_8799_env=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    ]);
    const user = accounts.userByEmail("alice@example.test")!;
    expect(started).toEqual([{ id: accounts.workspaceOf(user.id)!.id, userId: user.id, email: "alice@example.test" }]);
    expect(issued).toEqual([]);
    // once only
    expect((await call("/api/auth/magic/verify", { body: { token } })).body.error).toBe(LINK_EXPIRED);
  });

  it("sends the founder and invited members to this server's desk instead", async () => {
    const { call, mail, tokenFrom, accounts, issued, started } = await setup();
    await call("/api/auth/magic/start", { body: { email: "founder@example.test" } });
    await call("/api/auth/magic/start", { body: { email: "cos@example.test" } });
    const founder = await call("/api/auth/magic/verify", { body: { token: tokenFrom(mail[0]!) } });
    expect(founder.body).toEqual({ ok: true, destination: "desk" });
    expect(founder.cookies[0]).toMatch(/^omb_session_8799_env=omb_sess_founder; /);
    expect(founder.cookies[1]).toBe("nation_account=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    await call("/api/auth/magic/verify", { body: { token: tokenFrom(mail[1]!) } });
    expect(issued.map((input) => [input.email, input.scopes])).toEqual([["founder@example.test", ["admin", "client"]], ["cos@example.test", ["client"]]]);
    expect(accounts.workspaceCount()).toBe(0);
    expect(started).toEqual([]);
  });

  it("does not spend the link when there is no room for a new workspace", async () => {
    const { call, mail, tokenFrom } = await setup({ maxWorkspaces: 0 });
    await call("/api/auth/magic/start", { body: { email: "alice@example.test" } });
    const token = tokenFrom(mail[0]!);
    const full = await call("/api/auth/magic/verify", { body: { token } });
    expect(full.status).toBe(503);
    expect(full.body.error).toBe(SIGNUPS_FULL);
    expect((await call("/api/auth/magic/peek", { body: { token } })).status).toBe(200);
  });

  it("counts a wrong or spent token against the caller", async () => {
    const { call, failures } = await setup();
    expect((await call("/api/auth/magic/verify", { body: { token: "nml_wrong" } })).status).toBe(401);
    expect((await call("/api/auth/magic/peek", { body: { token: 5 } })).status).toBe(401);
    expect(failures).toEqual(["127.0.0.1", "127.0.0.1"]);
  });
});

describe("requests from a signed-in account", () => {
  async function signedIn(env?: NodeJS.ProcessEnv) {
    const context = await setup({ env });
    await context.call("/api/auth/magic/start", { body: { email: "alice@example.test" } });
    const verified = await context.call("/api/auth/magic/verify", { body: { token: context.tokenFrom(context.mail[0]!) } });
    const cookie = verified.cookies[0]!.split(";")[0]!;
    return { ...context, cookie };
  }

  it("go to the account's own workspace, with the caller's address", async () => {
    const { call, cookie, forwarded, accounts } = await signedIn();
    const reply = await call("/api/bots?limit=5", { headers: { cookie } });
    const workspace = accounts.workspaceOf(accounts.userByEmail("alice@example.test")!.id)!;
    expect(reply.body).toEqual({ workspace: workspace.id });
    expect(forwarded).toEqual([{ ref: { id: workspace.id, userId: workspace.userId, email: "alice@example.test" }, ip: "127.0.0.1", path: "/api/bots?limit=5" }]);
    // the cookie's term slides
    expect(reply.cookies[0]).toMatch(/^nation_account=nas_/);
  });

  it("give the workspace the visitor's address that the web front end names", async () => {
    const { call, cookie, forwarded } = await signedIn({ NATION_CLIENT_IP_HEADER: "x-vercel-forwarded-for" });
    await call("/api/credits/status", { headers: { cookie, "x-forwarded-for": "76.76.21.9", "x-vercel-forwarded-for": "198.51.100.7" } });
    expect(forwarded.map((item) => item.ip)).toEqual(["198.51.100.7"]);
  });

  it("never reach the workspace server's own loopback routes", async () => {
    const { call, cookie, forwarded } = await signedIn();
    expect((await call("/api/workspace-host/session", { headers: { cookie, "x-nation-workspace-key": "guess" }, body: { email: "alice@example.test", userId: "x" } })).status).toBe(404);
    expect((await call("/api/workspace-host/activity", { headers: { cookie } })).status).toBe(404);
    expect(forwarded).toEqual([]);
  });

  it("answer who is signed in without the workspace", async () => {
    const { call, cookie, forwarded } = await signedIn();
    const session = (await call("/api/auth/session", { headers: { cookie } })).body;
    expect(session).toMatchObject({ kind: "session", scopes: ["client"], email: "alice@example.test", via: "cookie", environmentId: "env-1" });
    expect(forwarded).toEqual([]);
  });

  it("never reach the desk: cross-site, stale or signed out", async () => {
    const { call, cookie } = await signedIn();
    const crossSite = await call("/api/bots", { headers: { cookie, origin: "https://evil.example" } });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body.from).toBeUndefined();
    const stale = await call("/api/bots", { headers: { cookie: "nation_account=nas_" + "B".repeat(43) } });
    expect(stale.status).toBe(401);
    expect(stale.body.error).toBe(SIGNED_OUT);
    expect(stale.cookies).toEqual(["nation_account=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"]);
    expect((await call("/api/auth/logout", { headers: { cookie }, body: {} })).status).toBe(200);
    expect((await call("/api/bots", { headers: { cookie } })).status).toBe(401);
  });

  it("leave every other request to the desk", async () => {
    const { call, cookie } = await signedIn();
    expect((await call("/api/bots")).body).toEqual({ from: "desk" });
    expect((await call("/swarm/", { headers: { cookie } })).body).toEqual({ from: "desk" });
  });
});

describe("helpers", () => {
  it("masks an address for the log", () => {
    expect(maskEmail("alice@example.test")).toBe("a…e@example.test");
    expect(maskEmail("a@example.test")).toBe("a…@example.test");
  });

  it("trusts X-Real-IP only when the operator says the proxy writes it", () => {
    const req = { headers: { "x-real-ip": "203.0.113.9" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
    expect(clientAddress(req, {})).toBe("127.0.0.1");
    expect(clientAddress(req, { NATION_TRUST_PROXY: "1" })).toBe("203.0.113.9");
    const forged = { headers: { "x-real-ip": "1.2.3.4, evil" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as IncomingMessage;
    expect(clientAddress(forged, { NATION_TRUST_PROXY: "1" })).toBe("127.0.0.1");
  });

  it("reads a web front end's visitor header only from the proxy on this machine", () => {
    const env = { NATION_CLIENT_IP_HEADER: "X-Vercel-Forwarded-For" };
    const via = (remoteAddress: string, headers: Record<string, string>) => ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;
    const edge = { "x-forwarded-for": "76.76.21.9" };
    expect(clientAddress(via("127.0.0.1", { ...edge, "x-vercel-forwarded-for": "198.51.100.7" }), env)).toBe("198.51.100.7");
    expect(clientAddress(via("127.0.0.1", { ...edge, "x-vercel-forwarded-for": "198.51.100.7, 76.76.21.9" }), env)).toBe("198.51.100.7");
    expect(clientAddress(via("::1", { ...edge, "x-vercel-forwarded-for": "::ffff:198.51.100.7" }), env)).toBe("198.51.100.7");
    expect(clientAddress(via("127.0.0.1", { ...edge, "x-vercel-forwarded-for": "2001:db8::7" }), env)).toBe("2001:db8::7");
    // unset, missing or not an address: the proxy hop, as before
    expect(clientAddress(via("127.0.0.1", { ...edge, "x-vercel-forwarded-for": "198.51.100.7" }), {})).toBe("76.76.21.9");
    expect(clientAddress(via("127.0.0.1", edge), env)).toBe("76.76.21.9");
    expect(clientAddress(via("127.0.0.1", { ...edge, "x-vercel-forwarded-for": "evil\n<script>" }), env)).toBe("76.76.21.9");
    // a connection that did not come through this machine's proxy is its own source
    expect(clientAddress(via("192.0.2.1", { "x-vercel-forwarded-for": "198.51.100.7" }), env)).toBe("192.0.2.1");
    // a workspace behind the gateway keeps reading the X-Real-IP the gateway wrote
    expect(clientAddress(via("127.0.0.1", { "x-real-ip": "203.0.113.9", "x-vercel-forwarded-for": "198.51.100.7" }), { ...env, NATION_TRUST_PROXY: "1" })).toBe("203.0.113.9");
  });
});
