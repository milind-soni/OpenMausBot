import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OUTLOOK_SCOPES, outlookTenant } from "../shared/direct-apps.ts";
import { isOutboundTool } from "../shared/outbound.ts";
import {
  OutlookMail,
  mountOutlookMail,
  outlookAuthorizeUrl,
  outlookGraphCall,
  type OutlookSignInStatus,
} from "./outlook-mail.ts";
import { startFakeOAuth, type FakeOAuth } from "./testing/fake-oauth-server.ts";

let dir: string;
let oauth: FakeOAuth | undefined;
let mail: OutlookMail | undefined;
const MAIL_SCOPE = "offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outlook-mail-"));
});

afterEach(async () => {
  mail?.dispose();
  await oauth?.close();
  oauth = undefined;
  mail = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("outlook mail grant", () => {
  it("asks Microsoft for mail scopes only and never for an MCP resource", () => {
    expect([...OUTLOOK_SCOPES]).toEqual([
      "offline_access",
      "https://graph.microsoft.com/Mail.ReadWrite",
      "https://graph.microsoft.com/Mail.Send",
    ]);
    expect(outlookTenant(undefined)).toBe("common");
    expect(outlookTenant(" organizations ")).toBe("organizations");
    expect(outlookTenant("consumers")).toBe("consumers");
    expect(outlookTenant("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(outlookTenant("common/../admin")).toBeNull();
    expect(outlookTenant("https://evil.test")).toBeNull();
    const url = outlookAuthorizeUrl({
      endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      clientId: "app",
      redirectUri: "http://127.0.0.1:23456/mcp-oauth/callback",
      state: "state",
      challenge: "challenge",
    });
    expect(url.searchParams.get("scope")).toBe(OUTLOOK_SCOPES.join(" "));
    expect(url.searchParams.has("resource")).toBe(false);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("reads and drafts through Graph and sends only from send_mail", () => {
    const listed = outlookGraphCall("list_messages", {});
    expect(listed.ok && listed.request.path).toContain("/me/mailFolders/inbox/messages");
    const search = outlookGraphCall("list_messages", { query: "from:ada", top: 5 });
    expect(search.ok && search.request.path.startsWith("/me/messages?")).toBe(true);
    expect(search.ok && search.request.headers?.ConsistencyLevel).toBe("eventual");
    expect(outlookGraphCall("list_messages", { folder: "calendar" })).toEqual({
      ok: false,
      error: "Folder must be inbox, drafts, sentitems, deleteditems, junkemail, or archive.",
    });
    const draft = outlookGraphCall("create_draft", { to: "a@b.co", subject: "Hello", body: "Draft text" });
    expect(draft.ok && draft.request).toMatchObject({ method: "POST", path: "/me/messages" });
    expect(JSON.stringify(draft.ok && draft.request.body)).not.toContain("sendMail");
    const sent = outlookGraphCall("send_mail", { to: "a@b.co, c@d.co", subject: "Hello", body: "Go" });
    expect(sent.ok && sent.request.path).toBe("/me/sendMail");
    expect(isOutboundTool("send_mail")).toBe(true);
    expect(isOutboundTool("mcp__outlook__send_mail")).toBe(true);
    expect(isOutboundTool("create_draft")).toBe(false);
    expect(isOutboundTool("mcp__outlook__create_draft")).toBe(false);
  });

  it("keeps a taken outlook name and a restricted workspace off the turn", () => {
    const spec = { type: "http" as const, url: "http://127.0.0.1:8799/api/outlook/mcp", headers: { Authorization: "Bearer gate" } };
    expect(mountOutlookMail({}, spec, { restricted: false, userNamedOutlook: false }).outlook).toBe(spec);
    expect(mountOutlookMail({}, spec, { restricted: true, userNamedOutlook: false })).toEqual({});
    expect(mountOutlookMail({}, spec, { restricted: false, userNamedOutlook: true })).toEqual({});
    expect(mountOutlookMail({ outlook: spec }, spec, { restricted: false, userNamedOutlook: false }).outlook).toBe(spec);
  });

  it("signs in without a resource parameter and serves mail only to the loopback gate", async () => {
    oauth = await startFakeOAuth({ preRegistered: { "app-id": "app-secret" } });
    const seen: string[] = [];
    const graph: { url?: string; body?: string } = {};
    mail = new OutlookMail({
      file: join(dir, "outlook-oauth.json"),
      authorizeEndpoint: () => `${oauth!.issuer}/authorize`,
      tokenEndpoint: () => `${oauth!.issuer}/token`,
      graphBase: "https://graph.test/v1.0",
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/token")) {
          const form = String(init?.body ?? "");
          seen.push(form);
          expect(form).not.toContain("resource=");
          const response = await fetch(input, init);
          const body = await response.json() as Record<string, unknown>;
          body.scope = MAIL_SCOPE;
          return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
        }
        if (url.startsWith("https://graph.test/")) {
          graph.url = url;
          graph.body = typeof init?.body === "string" ? init.body : undefined;
          const header = new Headers(init?.headers).get("authorization") ?? "";
          expect(header.startsWith("Bearer ")).toBe(true);
          expect(header).not.toContain(mail!.gateToken());
          if (url.includes("/me/messages/") && !url.includes("/me/messages?")) {
            return Response.json({
              id: "m1",
              subject: "Hello",
              from: { emailAddress: { address: "ada@example.com" } },
              body: { contentType: "html", content: `<p>${"x".repeat(4500)}</p>` },
              isDraft: false,
            });
          }
          if (url.includes("/me/sendMail")) return new Response(null, { status: 202 });
          if (init?.method === "POST") return Response.json({ id: "draft-1" });
          return Response.json({ value: [{ id: "m1", subject: "Hello", from: { emailAddress: { address: "ada@example.com" } }, isRead: false, bodyPreview: "Hi" }] });
        }
        return fetch(input, init);
      },
    });

    expect(mail.status().auth).toBe("none");
    expect(mail.engineSpec(8799)).toBeNull();
    const first = await mail.route({
      method: "POST",
      path: "/api/outlook/sign-in",
      owner: "session",
      restricted: false,
      body: { clientId: "app-id", clientSecret: "app-secret", tenant: "common" },
    });
    const started = await mail.route({
      method: "POST",
      path: "/api/outlook/sign-in",
      owner: "session",
      restricted: false,
      body: { clientId: "app-id", clientSecret: "app-secret", tenant: "organizations" },
    });
    if (!first || !started || started.status !== 200) throw new Error("sign-in did not start");
    const auth = (started.body as { auth: OutlookSignInStatus }).auth;
    const previous = (first.body as { auth: OutlookSignInStatus }).auth;
    expect(auth.phase).toBe("waiting");
    expect(auth.flowId).not.toBe(previous.flowId);
    expect(auth.phase).toBe("waiting");
    expect(new URL(auth.authorizationUrl!).searchParams.has("resource")).toBe(false);
    const page = await fetch(auth.authorizationUrl!);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/Signed in/);
    expect(mail.status().auth).toBe("signed-in");
    if (process.platform !== "win32") expect(statSync(join(dir, "outlook-oauth.json")).mode & 0o777).toBe(0o600);
    const saved = readFileSync(join(dir, "outlook-oauth.json"), "utf8");
    expect(saved).toContain("app-secret");
    expect(saved).not.toContain(mail.gateToken());

    const spec = mail.engineSpec(8799);
    expect(spec).toEqual({
      type: "http",
      url: "http://127.0.0.1:8799/api/outlook/mcp",
      headers: { Authorization: `Bearer ${mail.gateToken()}` },
    });
    expect(JSON.stringify(spec)).not.toContain(JSON.parse(saved).tokens.access);

    const endpoint = await serve(mail);
    try {
      const refused = await fetch(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(refused.status).toBe(404);

      const listed = await postMcp(endpoint.url, mail.gateToken(), { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["list_messages", "get_message", "create_draft", "send_mail"]);

      const messages = await postMcp(endpoint.url, mail.gateToken(), {
        jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_messages", arguments: {} },
      });
      expect(messages.result.content[0].text).toContain("id: m1");
      expect(graph.url).toContain("/me/mailFolders/inbox/messages");

      const full = await postMcp(endpoint.url, mail.gateToken(), {
        jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_message", arguments: { id: "m1" } },
      });
      expect(full.result.content[0].text).toContain("[truncated]");
      expect(full.result.content[0].text.length).toBeLessThan(4500);

      const draft = await postMcp(endpoint.url, mail.gateToken(), {
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "create_draft", arguments: { to: "a@b.co", subject: "Note", body: "Keep" } },
      });
      expect(draft.result.content[0].text).toContain("draft-1");
      expect(graph.url).toContain("/me/messages");
      expect(graph.url).not.toContain("sendMail");
      expect(graph.body).not.toContain("sendMail");

      const sent = await postMcp(endpoint.url, mail.gateToken(), {
        jsonrpc: "2.0", id: 5, method: "tools/call",
        params: { name: "send_mail", arguments: { to: "a@b.co", subject: "Note", body: "Go" } },
      });
      expect(sent.result.content[0].text).toBe("Sent.");
      expect(graph.url).toContain("/me/sendMail");
    } finally {
      await endpoint.close();
    }

    const signedOut = await mail.route({ method: "POST", path: "/api/outlook/sign-out", owner: "session", restricted: false });
    expect(signedOut?.body).toMatchObject({ auth: "needs-sign-in" });
    expect(mail.engineSpec(8799)).toBeNull();
    expect(seen.length).toBeGreaterThan(0);
  });
});

function postMcp(url: string, gate: string, body: unknown): Promise<any> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${gate}` },
    body: JSON.stringify(body),
  }).then(async (response) => {
    expect(response.status).toBe(200);
    return response.json();
  });
}

function serve(service: OutlookMail): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if (!service.allowsMcp(req)) {
      res.writeHead(404).end("not found");
      return;
    }
    void service.handleMcp(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/api/outlook/mcp`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
