// A stand-in for cloudflare/control-plane for tests of `openmausbot login`
// and `serve --tunnel`: the routes the desktop's control-plane client uses,
// answering in the shapes its validators accept. Authorization is only "is
// this a credential this stub issued". Records every call so a test can
// assert what the client did, not only what it got.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

interface StubInstallation {
  id: string;
  clientInstanceId: string;
  name: string;
  platform: string;
  appVersion: string | null;
  credential: string;
}

export interface ControlPlaneStub {
  url: string;
  otp: string;
  endpointUrl: string;
  connectorToken: string;
  /** "METHOD /path", in order. */
  calls: string[];
  installations: Map<string, StubInstallation>;
  close(): Promise<void>;
}

const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;

const newCredential = () => `omb_install_${randomBytes(16).toString("base64url")}.${randomBytes(32).toString("base64url")}`;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const parsed: unknown = raw ? JSON.parse(raw) : {};
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : {};
}

export async function startControlPlaneStub(options: { otp?: string; endpointUrl?: string } = {}): Promise<ControlPlaneStub> {
  const otp = options.otp ?? "24681357";
  const endpointUrl = options.endpointUrl ?? "https://c-stub.openmausbot.invalid";
  const connectorToken = `stub-connector-${randomBytes(48).toString("base64url")}`;
  const accountTokens = new Set<string>();
  const installations = new Map<string, StubInstallation>();
  const calls: string[] = [];
  const publicView = (inst: StubInstallation) => ({
    id: inst.id,
    clientInstanceId: inst.clientInstanceId,
    name: inst.name,
    platform: inst.platform,
    appVersion: inst.appVersion,
    createdAt: 1,
    updatedAt: 1,
    lastSeenAt: null,
  });
  const endpoint = () => ({
    url: endpointUrl,
    hostname: new URL(endpointUrl).hostname,
    status: "active",
    generation: 1,
    updatedAt: 1,
    lastReconciledAt: 1,
    lastErrorCode: null,
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const method = req.method ?? "GET";
    const path = url.pathname;
    calls.push(`${method} ${path}`);
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const byCredential = () => [...installations.values()].find((inst) => inst.credential === bearer) ?? null;
    const account = accountTokens.has(bearer);

    if (method === "GET" && path === "/healthz") return send(200, { ok: true, service: "openmausbot-control-plane" });
    if (method === "POST" && path === "/api/auth/email-otp/send-verification-otp") {
      await readJson(req);
      return send(200, { success: true });
    }
    if (method === "POST" && path === "/api/auth/sign-in/email-otp") {
      const body = await readJson(req);
      if (body.otp !== otp) return send(401, { error: "invalid_otp", message: "Invalid code" });
      const token = `acct_${randomBytes(24).toString("base64url")}`;
      accountTokens.add(token);
      return send(200, { token: "db-token-never-used", user: { id: "user_stub", email: body.email, name: "stub", emailVerified: true } }, { "set-auth-token": token });
    }
    if (method === "POST" && path === "/api/auth/sign-out") return send(200, { success: true });
    if (method === "GET" && path === "/v1/me") {
      return account ? send(200, { user: { id: "user_stub", email: "stub@example.test", name: "stub", emailVerified: true } }) : send(401, { error: "unauthorized" });
    }
    if (path === "/v1/installations" && method === "GET") {
      return account ? send(200, { installations: [...installations.values()].map(publicView) }) : send(401, { error: "unauthorized" });
    }
    if (path === "/v1/installations" && method === "POST") {
      if (!account) return send(401, { error: "unauthorized" });
      const body = await readJson(req);
      const inst: StubInstallation = {
        id: randomUUID(),
        clientInstanceId: String(body.clientInstanceId ?? ""),
        name: String(body.name ?? "This computer"),
        platform: String(body.platform ?? "linux"),
        appVersion: typeof body.appVersion === "string" ? body.appVersion : null,
        credential: newCredential(),
      };
      installations.set(inst.id, inst);
      return send(201, { installation: publicView(inst), credential: inst.credential, credentialExpiresAt: Date.now() + NINETY_DAYS });
    }
    const rotate = /^\/v1\/installations\/([^/]+)\/credentials\/rotate$/.exec(path);
    if (rotate && method === "POST") {
      if (!account) return send(401, { error: "unauthorized" });
      const inst = installations.get(decodeURIComponent(rotate[1]));
      if (!inst) return send(404, { error: "not_found" });
      inst.credential = newCredential();
      return send(201, { credential: inst.credential, createdAt: Date.now(), credentialExpiresAt: Date.now() + NINETY_DAYS });
    }
    if (path === "/v1/installations/self" && method === "GET") {
      const inst = byCredential();
      return inst ? send(200, { installation: publicView(inst), credentialExpiresAt: Date.now() + NINETY_DAYS }) : send(401, { error: "unauthorized" });
    }
    if (path === "/v1/installations/self/endpoint") {
      if (!byCredential()) return send(401, { error: "unauthorized" });
      if (method === "GET") return send(200, { endpoint: endpoint() });
      if (method === "POST") return send(200, { endpoint: endpoint(), connectorToken });
      if (method === "DELETE") return send(204);
    }
    const one = /^\/v1\/installations\/([^/]+)$/.exec(path);
    if (one && method === "DELETE") {
      if (!account) return send(401, { error: "unauthorized" });
      installations.delete(decodeURIComponent(one[1]));
      return send(204);
    }
    return send(404, { error: "not_found" });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    otp,
    endpointUrl,
    connectorToken,
    calls,
    installations,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
