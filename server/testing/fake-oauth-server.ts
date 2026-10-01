// A tiny OAuth 2.1 authorization server for tests: protected-resource and
// authorization-server metadata, dynamic client registration, an /authorize
// that approves at once (302 back to the redirect URI, like a person who
// clicked Allow), a token endpoint that checks PKCE, and revocation.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOAuthOptions {
  /** seconds until an access token expires (default 3600) */
  expiresIn?: number;
  /** omit registration_endpoint from the metadata */
  noRegistration?: boolean;
  /** answer every refresh with invalid_grant */
  rejectRefresh?: boolean;
  /** /authorize answers ?error=access_denied instead of a code */
  deny?: boolean;
  /** hold every token response this long */
  tokenDelayMs?: number;
  /** answer refreshes with this status and a non-grant error */
  refreshStatus?: number;
  /** metadata claims this issuer instead of its own address */
  claimIssuer?: string;
}

export interface FakeOAuth {
  issuer: string;
  prmUrl: string;
  /** `WWW-Authenticate` value an MCP server behind this issuer would send */
  challenge: string;
  isValid(authorization: string | undefined): boolean;
  /** a valid access token, as if issued out of band (a personal token) */
  mint(): string;
  counts: { register: number; token: number; refresh: number; revoke: number };
  lastAuthorize: URLSearchParams | null;
  options: FakeOAuthOptions;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

export async function startFakeOAuth(options: FakeOAuthOptions = {}): Promise<FakeOAuth> {
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string }>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  const clients = new Set<string>();
  const counts = { register: 0, token: 0, refresh: 0, revoke: 0 };
  let issuer = "";
  const fake: Partial<FakeOAuth> = { lastAuthorize: null, options };

  const issue = () => {
    const token = `at_${randomBytes(12).toString("hex")}`;
    const refreshToken = `rt_${randomBytes(12).toString("hex")}`;
    access.add(token);
    refresh.add(refreshToken);
    return { access_token: token, token_type: "Bearer", expires_in: options.expiresIn ?? 3600, refresh_token: refreshToken, scope: "mcp" };
  };
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", issuer);
      if (req.method === "GET" && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return json(res, 200, { resource: `${issuer}/mcp`, authorization_servers: [issuer], scopes_supported: ["mcp"] });
      }
      if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        return json(res, 200, {
          issuer: options.claimIssuer ?? issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          ...(options.noRegistration ? {} : { registration_endpoint: `${issuer}/register` }),
          revocation_endpoint: `${issuer}/revoke`,
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (req.method === "POST" && url.pathname === "/register") {
        counts.register += 1;
        const body = JSON.parse(await readBody(req)) as { redirect_uris?: string[] };
        const clientId = `client_${counts.register}`;
        clients.add(clientId);
        return json(res, 201, { client_id: clientId, redirect_uris: body.redirect_uris });
      }
      if (req.method === "GET" && url.pathname === "/authorize") {
        fake.lastAuthorize = url.searchParams;
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        if (options.deny) {
          redirect.searchParams.set("error", "access_denied");
        } else {
          const code = `code_${randomBytes(8).toString("hex")}`;
          codes.set(code, {
            challenge: url.searchParams.get("code_challenge") ?? "",
            clientId: url.searchParams.get("client_id") ?? "",
            redirectUri: url.searchParams.get("redirect_uri") ?? "",
          });
          redirect.searchParams.set("code", code);
        }
        res.writeHead(302, { location: redirect.toString() }).end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/token") {
        const form = new URLSearchParams(await readBody(req));
        if (options.tokenDelayMs) await new Promise((resolve) => setTimeout(resolve, options.tokenDelayMs));
        if (form.get("grant_type") === "authorization_code") {
          counts.token += 1;
          const entry = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          const ok = entry
            && entry.clientId === form.get("client_id")
            && entry.redirectUri === form.get("redirect_uri")
            && createHash("sha256").update(verifier).digest("base64url") === entry.challenge;
          return ok ? json(res, 200, issue()) : json(res, 400, { error: "invalid_grant" });
        }
        if (form.get("grant_type") === "refresh_token") {
          counts.refresh += 1;
          if (options.refreshStatus) return json(res, options.refreshStatus, { error: "slow_down" });
          const token = form.get("refresh_token") ?? "";
          if (options.rejectRefresh || !refresh.has(token)) return json(res, 400, { error: "invalid_grant" });
          refresh.delete(token);
          return json(res, 200, issue());
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      if (req.method === "POST" && url.pathname === "/revoke") {
        counts.revoke += 1;
        const form = new URLSearchParams(await readBody(req));
        access.delete(form.get("token") ?? "");
        refresh.delete(form.get("token") ?? "");
        res.writeHead(200).end();
        return;
      }
      res.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, {
    issuer,
    prmUrl: `${issuer}/.well-known/oauth-protected-resource`,
    challenge: `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
    mint: () => issue().access_token,
    isValid: (authorization: string | undefined) => Boolean(authorization?.startsWith("Bearer ") && access.has(authorization.slice(7))),
    counts,
    options,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  }) as FakeOAuth;
}
