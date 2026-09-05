import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearSessionCookie,
  isAllowedOrigin,
  isLoopbackHost,
  isProxied,
  isSameOrigin,
  parseCookies,
  requestOrigin,
  requestSource,
  requiredScope,
  resolveRequestAuth,
  serializeSessionCookie,
  sessionCookieName,
} from "./request-auth.ts";
import { SessionRegistry } from "./sessions.ts";

function request(headers: Record<string, string>, method = "GET"): IncomingMessage {
  // SAFETY: the resolver reads only headers and method; a bare object is the whole contract here
  return { headers, method } as unknown as IncomingMessage;
}

describe("loopback rules (moved from the server entry, behaviour unchanged)", () => {
  it("accepts localhost, 127.x and ::1 with or without a port", () => {
    for (const host of ["localhost", "localhost:8799", "127.0.0.1", "127.9.9.9:80", "[::1]", "[::1]:8799", "LOCALHOST"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ["", "example.com", "127.0.0.1:x", "[::1]x", "100.64.0.1:8799", "localhost.evil.com", "[fe80::1]"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
  it("allows absent origins and loopback origins only", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:8799")).toBe(true);
    expect(isAllowedOrigin("https://localhost")).toBe(true);
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("ftp://localhost")).toBe(false);
    expect(isAllowedOrigin("not a url")).toBe(false);
  });
});

describe("origin and cookies", () => {
  it("derives the request origin from Host and the proxy's scheme", () => {
    expect(requestOrigin(request({ host: "bots.example.com" }))).toBe("http://bots.example.com");
    expect(requestOrigin(request({ host: "Bots.Example.com", "x-forwarded-proto": "https" }))).toBe("https://bots.example.com");
    expect(requestOrigin(request({ host: "a:8799", "x-forwarded-proto": "https, http" }))).toBe("https://a:8799");
    expect(requestOrigin(request({}))).toBeNull();
  });
  it("treats absent or matching Origin as same-origin, anything else as foreign", () => {
    expect(isSameOrigin(request({ host: "a.example" }))).toBe(true);
    expect(isSameOrigin(request({ host: "a.example", origin: "http://a.example" }))).toBe(true);
    expect(isSameOrigin(request({ host: "a.example", "x-forwarded-proto": "https", origin: "https://a.example" }))).toBe(true);
    expect(isSameOrigin(request({ host: "a.example", origin: "https://evil.example" }))).toBe(false);
  });
  it("parses cookies and names the session cookie per port and environment", () => {
    expect(parseCookies("a=1; omb_session_8799_abc=tok; b = 2")).toEqual(new Map([["a", "1"], ["omb_session_8799_abc", "tok"], ["b", "2"]]));
    expect(parseCookies(undefined).size).toBe(0);
    expect(sessionCookieName(8799, "3f2a-uuid-like-id")).toBe("omb_session_8799_3f2auuidlike");
    expect(serializeSessionCookie("c", "t", { secure: true, maxAgeSeconds: 60 })).toBe("c=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure");
    expect(serializeSessionCookie("c", "t", { secure: false, maxAgeSeconds: 60 })).not.toContain("Secure");
    expect(clearSessionCookie("c")).toContain("Max-Age=0");
  });
});

describe("request source for the lockout", () => {
  const withPeer = (peer: string, headers: Record<string, string>) =>
    // SAFETY: only headers and the socket peer are read
    ({ headers, method: "POST", socket: { remoteAddress: peer } }) as unknown as IncomingMessage;
  it("takes the forwarded address only from a proxy on this machine", () => {
    expect(requestSource(withPeer("127.0.0.1", { "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(requestSource(withPeer("::ffff:127.0.0.1", { "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(requestSource(withPeer("127.0.0.1", {}))).toBe("127.0.0.1");
    expect(requestSource(withPeer("100.64.0.7", { "x-forwarded-for": "1.1.1.1" }))).toBe("100.64.0.7");
  });
});

describe("scopes", () => {
  it("needs admin for pairing, session management and configuration writes; client elsewhere", () => {
    expect(requiredScope("POST", "/api/auth/pairing")).toBe("admin");
    expect(requiredScope("DELETE", "/api/auth/sessions/abc")).toBe("admin");
    expect(requiredScope("PUT", "/api/config")).toBe("admin");
    expect(requiredScope("GET", "/api/config")).toBe("client");
    expect(requiredScope("POST", "/api/instances")).toBe("admin");
    expect(requiredScope("GET", "/api/instances")).toBe("client");
    expect(requiredScope("POST", "/api/mcp/servers")).toBe("admin");
    expect(requiredScope("POST", "/api/mcp/servers/github/test")).toBe("admin");
    expect(requiredScope("GET", "/api/mcp/servers")).toBe("client");
    expect(requiredScope("GET", "/api/computers/boxes")).toBe("client");
    expect(requiredScope("POST", "/api/computers/boxes/bx_23456789/sleep")).toBe("admin");
    expect(requiredScope("POST", "/api/computers/boxes/bx_23456789/delete")).toBe("admin");
    expect(requiredScope("GET", "/api/computers/vps")).toBe("client");
    expect(requiredScope("POST", "/api/computers/vps/openmausbot-vps-one/remove")).toBe("admin");
    expect(requiredScope("POST", "/api/bots/x/messages")).toBe("client");
    expect(requiredScope("POST", "/api/auth/pair")).toBe("client");
    expect(requiredScope("POST", "/api/auth/stream-ticket")).toBe("client");
  });
});

describe("resolveRequestAuth", () => {
  let dir: string;
  let sessions: SessionRegistry;
  const cookieName = "omb_session_8799_env";
  const resolve = (headers: Record<string, string>, path = "/api/bots", method = "GET") =>
    resolveRequestAuth(request(headers, method), { sessions, cookieName, streamPath: "/api/events", url: new URL(path, "http://x") });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-auth-"));
    sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function pairedToken(scopes: Array<"admin" | "client"> = ["admin", "client"]): string {
    const { code } = sessions.openPairing({ scopes });
    const result = sessions.exchange({ code, label: "test", source: "1.2.3.4" });
    if (!result.ok) throw new Error(result.error);
    return result.token;
  }

  it("keeps the loopback owner path exactly as before", () => {
    expect(resolve({ host: "127.0.0.1:8799" }).auth).toEqual({ kind: "loopback", scopes: ["admin", "client"] });
    expect(resolve({ host: "127.0.0.1:8799", origin: "http://localhost:8799" }).auth?.kind).toBe("loopback");
    const foreignHost = resolve({ host: "100.64.0.9:8799" });
    expect(foreignHost.auth).toBeNull();
    expect(foreignHost.status).toBe(403);
    expect(foreignHost.error).toMatch(/loopback host required.*pair this device/);
    const foreignOrigin = resolve({ host: "127.0.0.1:8799", origin: "https://evil.example" });
    expect(foreignOrigin.status).toBe(403);
    expect(foreignOrigin.error).toBe("forbidden: cross-origin request");
  });

  it("requires the packaged desktop capability for public loopback mutations", () => {
    const options = (path: string) => ({
      sessions,
      cookieName,
      streamPath: "/api/events",
      url: new URL(path, "http://x"),
      loopbackMutationToken: "owner-token-123",
    });
    const denied = resolveRequestAuth(
      request({ host: "127.0.0.1:8799" }, "PATCH"),
      options("/api/bots/bot-1"),
    );
    expect(denied.auth).toBeNull();
    expect(denied.status).toBe(403);
    expect(denied.error).toMatch(/desktop app or a paired device/);

    const desktop = resolveRequestAuth(
      request({
        host: "127.0.0.1:8799",
        "x-openmausbot-desktop-owner": "owner-token-123",
      }, "POST"),
      options("/api/routines"),
    );
    expect(desktop.auth?.kind).toBe("loopback");

    expect(resolveRequestAuth(
      request({ host: "127.0.0.1:8799" }, "GET"),
      options("/api/bots"),
    ).auth?.kind).toBe("loopback");
    const connectorRefresh = resolveRequestAuth(
      request({ host: "127.0.0.1:8799" }, "GET"),
      options("/api/bots/bot-1/connector-cards/card-1/status?threadId=thread-1"),
    );
    expect(connectorRefresh.auth).toBeNull();
    expect(connectorRefresh.status).toBe(403);
    expect(resolveRequestAuth(
      request({ host: "127.0.0.1:8799" }, "POST"),
      options("/api/internal/ask-bot"),
    ).auth?.kind).toBe("loopback");
  });

  it("never grants loopback trust to a request that came through a proxy, whatever Host it carries", () => {
    expect(isProxied(request({ host: "localhost", "x-forwarded-for": "203.0.113.9" }))).toBe(true);
    expect(isProxied(request({ host: "localhost", "x-forwarded-proto": "https" }))).toBe(true);
    expect(isProxied(request({ host: "localhost" }))).toBe(false);
    const viaProxy = resolve({ host: "localhost", "x-forwarded-for": "203.0.113.9" });
    expect(viaProxy.auth).toBeNull();
    expect(viaProxy.status).toBe(403);
    expect(viaProxy.error).toMatch(/came through a proxy.*pair this device/);
    const rewritten = resolve({ host: "127.0.0.1:8799", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9" });
    expect(rewritten.auth).toBeNull();
    // a paired session through the same proxy is fine
    const token = pairedToken();
    expect(resolve({ host: "localhost", "x-forwarded-for": "203.0.113.9", authorization: `Bearer ${token}` }).auth?.kind).toBe("session");
  });

  it("admits a bearer session from any host and reports how it authenticated", () => {
    const token = pairedToken();
    const r = resolve({ host: "100.64.0.9:8799", authorization: `Bearer ${token}` });
    expect(r.auth?.kind).toBe("session");
    expect(r.auth?.kind === "session" && r.auth.via).toBe("bearer");
  });

  it("admits the cookie only same-origin, so a foreign page cannot ride it", () => {
    const token = pairedToken();
    const ok = resolve({ host: "bots.example.com", cookie: `${cookieName}=${token}`, origin: "http://bots.example.com" });
    expect(ok.auth?.kind).toBe("session");
    const csrf = resolve({ host: "bots.example.com", cookie: `${cookieName}=${token}`, origin: "https://evil.example" }, "/api/bots", "POST");
    expect(csrf.auth).toBeNull();
    expect(csrf.status).toBe(403);
    expect(csrf.error).toBe("forbidden: cross-origin request");
  });

  it("accepts a stream ticket on the event stream only, once", () => {
    const token = pairedToken();
    const session = sessions.authenticate(token);
    if (!session) throw new Error("no session");
    const { ticket } = sessions.issueStreamTicket(session.id);
    expect(resolve({ host: "bots.example.com" }, `/api/events?ticket=${ticket}`).auth?.kind).toBe("session");
    expect(resolve({ host: "bots.example.com" }, `/api/events?ticket=${ticket}`).status).toBe(401);
    const { ticket: other } = sessions.issueStreamTicket(session.id);
    expect(resolve({ host: "bots.example.com" }, `/api/bots?ticket=${other}`).auth).toBeNull();
  });

  it("enforces scope: a client-only session cannot manage pairing or write config", () => {
    const token = pairedToken(["client"]);
    const denied = resolve({ host: "bots.example.com", authorization: `Bearer ${token}` }, "/api/auth/pairing", "POST");
    expect(denied.status).toBe(403);
    expect(denied.error).toContain("lacks the admin scope");
    const mcpDenied = resolve(
      { host: "bots.example.com", authorization: `Bearer ${token}` },
      "/api/mcp/servers/github/test",
      "POST",
    );
    expect(mcpDenied.status).toBe(403);
    expect(mcpDenied.error).toContain("lacks the admin scope");
    expect(resolve({ host: "bots.example.com", authorization: `Bearer ${token}` }, "/api/bots").auth?.kind).toBe("session");
  });

  it("explains a dead credential instead of silently falling back, except on loopback", () => {
    const token = pairedToken();
    const session = sessions.authenticate(token);
    if (!session) throw new Error("no session");
    sessions.revoke(session.id);
    const remote = resolve({ host: "bots.example.com", authorization: `Bearer ${token}` });
    expect(remote.status).toBe(401);
    expect(remote.error).toMatch(/expired or was revoked; pair this device again/);
    // the owner on the same machine keeps working even with a stale cookie
    expect(resolve({ host: "127.0.0.1:8799", cookie: `${cookieName}=${token}` }).auth?.kind).toBe("loopback");
  });
});
