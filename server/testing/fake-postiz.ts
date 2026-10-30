// A stand-in for a Postiz backend, written from Postiz's published behaviour (its OAuth metadata at
// api.postiz.com, checked 2026-10-29, and its MCP docs), never from its code: RFC 8414 path-based issuer metadata for
// /mcp-oauth-dynamic, dynamic client registration for https or loopback redirects, an authorize that approves at once
// (or denies), a PKCE-checked token endpoint that hands out never-expiring `pos_` tokens with no refresh token, and
// streamable-HTTP MCP at /mcp-oauth-dynamic (sign-in tokens and API keys) and /mcp (a bearer key).
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_POSTIZ_KEY = "fixture-postiz-org-key-0001";

export interface FakePostizCall { name: string; arguments: Record<string, unknown>; authorization: string }

export interface FakePostiz {
  /** The backend address, as a person would enter it (no path). */
  url: string;
  /** Every Authorization header an MCP request carried. */
  authorizations: string[];
  /** Every tools/call, with the credential it came with. */
  calls: FakePostizCall[];
  /** `pos_` tokens issued by the token endpoint. */
  issued: string[];
  counts: { register: number; token: number; mcp: number };
  options: { deny: boolean };
  /** Revoke a token or key, as Postiz does when a person disconnects the app or regenerates the key. */
  revoke(credential: string): void;
  /** Accept a credential again. */
  grant(credential: string): void;
  close(): Promise<void>;
}

const TOOLS = [
  { name: "integrationList", description: "List the connected social media channels.", inputSchema: { type: "object", properties: { group: { type: "string" } } } },
  { name: "integrationSchema", description: "Posting rules and settings for one platform.", inputSchema: { type: "object", properties: { platform: { type: "string" } }, required: ["platform"] } },
  { name: "schedulePostTool", description: "Schedule, draft, or immediately publish posts.", inputSchema: {
    type: "object", required: ["socialPost"], properties: { socialPost: { type: "array", items: { type: "object", properties: {
      integrationId: { type: "string" }, date: { type: "string" }, type: { type: "string", enum: ["draft", "schedule", "now"] },
      shortLink: { type: "boolean" }, isPremium: { type: "boolean" }, settings: { type: "array" },
      postsAndComments: { type: "array", items: { type: "object", properties: { content: { type: "string" } } } },
    } } } },
  } },
  { name: "postsListTool", description: "List posts scheduled between two dates.", inputSchema: { type: "object", properties: { startDate: { type: "string" }, endDate: { type: "string" } } } },
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

export async function startFakePostiz(): Promise<FakePostiz> {
  let base = "";
  const clients = new Map<string, string[]>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string }>();
  const valid = new Set<string>([FAKE_POSTIZ_KEY]);
  const fake: Omit<FakePostiz, "url" | "close"> = {
    authorizations: [], calls: [], issued: [], counts: { register: 0, token: 0, mcp: 0 }, options: { deny: false },
    revoke: (credential) => { valid.delete(credential); },
    grant: (credential) => { valid.add(credential); },
  };

  const mcp = async (req: IncomingMessage, res: ServerResponse, path: "/mcp" | "/mcp-oauth-dynamic") => {
    const authorization = req.headers.authorization ?? "";
    fake.authorizations.push(authorization);
    const token = authorization.replace(/^Bearer /u, "");
    if (!valid.has(token)) {
      // The OAuth path points a client at its sign-in; the key path only refuses (Postiz 2.25 does the same).
      if (path === "/mcp-oauth-dynamic") {
        return json(res, 401, { error: "invalid_token", error_description: "Invalid API Key or OAuth token" },
          { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp-oauth-dynamic"` });
      }
      res.writeHead(401, { "content-type": "text/html; charset=utf-8" }).end(authorization ? "Invalid API Key or OAuth token" : "Missing Authorization header");
      return;
    }
    fake.counts.mcp += 1;
    const frame = JSON.parse(await readBody(req) || "{}") as { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (frame.id === undefined) { res.writeHead(202).end(); return; }
    const answer = (result: unknown) => json(res, 200, { jsonrpc: "2.0", id: frame.id, result });
    if (frame.method === "initialize") return answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Postiz MCP", version: "1.0.0" } });
    if (frame.method === "tools/list") return answer({ tools: TOOLS });
    if (frame.method === "tools/call") {
      const name = frame.params?.name ?? "";
      fake.calls.push({ name, arguments: frame.params?.arguments ?? {}, authorization });
      if (name === "integrationList") return answer({ content: [{ type: "text", text: JSON.stringify([{ id: "int_linkedin", name: "Example Co", identifier: "linkedin" }]) }] });
      if (name === "schedulePostTool") {
        const posts = Array.isArray(frame.params?.arguments?.socialPost) ? frame.params!.arguments!.socialPost as Array<{ type?: string }> : [];
        return answer({ content: [{ type: "text", text: JSON.stringify({ created: posts.map((post, index) => ({ postId: `post_${index + 1}`, type: post.type ?? "draft" })) }) }] });
      }
      return answer({ content: [{ type: "text", text: "[]" }] });
    }
    return json(res, 200, { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Method not found" } });
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", base);
      const issuer = `${base}/mcp-oauth-dynamic`;
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp-oauth-dynamic") {
        return json(res, 200, { resource: issuer, authorization_servers: [issuer], scopes_supported: ["mcp:read", "mcp:write"], bearer_methods_supported: ["header"] });
      }
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server/mcp-oauth-dynamic") {
        return json(res, 200, {
          issuer, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`,
          response_types_supported: ["code"], grant_types_supported: ["authorization_code"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
          code_challenge_methods_supported: ["S256"], scopes_supported: ["mcp:read", "mcp:write"],
        });
      }
      if (req.method === "POST" && url.pathname === "/oauth/register") {
        fake.counts.register += 1;
        const body = JSON.parse(await readBody(req) || "{}") as { redirect_uris?: string[]; token_endpoint_auth_method?: string };
        const uris = body.redirect_uris ?? [];
        const allowed = uris.length > 0 && uris.every((uri) => {
          try { const parsed = new URL(uri); return parsed.protocol === "https:" || (parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)); } catch { return false; }
        });
        if (!allowed) return json(res, 400, { error: "invalid_redirect_uri" });
        const clientId = `pcd_${randomBytes(8).toString("hex")}`;
        clients.set(clientId, uris);
        return json(res, 201, { client_id: clientId, redirect_uris: uris, grant_types: ["authorization_code"], token_endpoint_auth_method: "none" });
      }
      if (req.method === "GET" && url.pathname === "/oauth/authorize") {
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        if (!clients.get(clientId)?.includes(redirectUri) || !challenge) return json(res, 400, { error: "invalid_request" });
        const redirect = new URL(redirectUri);
        const state = url.searchParams.get("state");
        if (state) redirect.searchParams.set("state", state);
        if (fake.options.deny) {
          redirect.searchParams.set("error", "access_denied");
        } else {
          const code = `pcc_${randomBytes(8).toString("hex")}`;
          codes.set(code, { clientId, redirectUri, challenge });
          redirect.searchParams.set("code", code);
        }
        res.writeHead(302, { location: redirect.toString() }).end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/oauth/token") {
        const form = new URLSearchParams(await readBody(req));
        if (form.get("grant_type") !== "authorization_code") return json(res, 400, { error: "unsupported_grant_type" });
        fake.counts.token += 1;
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verified = code && code.clientId === form.get("client_id") && code.redirectUri === form.get("redirect_uri")
          && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === code.challenge;
        if (!verified) return json(res, 400, { error: "invalid_grant" });
        const token = `pos_${randomBytes(20).toString("hex")}`;
        valid.add(token);
        fake.issued.push(token);
        return json(res, 200, { id: "org_fixture", access_token: token, token_type: "bearer", scope: "mcp:read mcp:write" });
      }
      if (req.method === "POST" && (url.pathname === "/mcp" || url.pathname === "/mcp-oauth-dynamic")) return mcp(req, res, url.pathname);
      json(res, 404, { message: `Cannot ${req.method} ${url.pathname}`, statusCode: 404 });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, {
    url: base,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  });
}
