// A fake provider for the Cloud's browser sandbox: the provider's API (list, create, name, resume, state, commands, host,
// delete) and the sandbox's door behind its relay, which answers a WebSocket upgrade as Chrome would and echoes every
// frame. Nothing here reaches a real provider or starts a real sandbox.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";

export const OWN_KEY = "boat_own-test-key";
export const RELAY_TOKEN = "relay-token-123";

type Request = { method: string; path: string; command?: string; body?: Record<string, unknown> };

export interface FakeComputer {
  base: string;
  state: string;
  /** Whether the sandbox exists yet; a create makes it. */
  exists: boolean;
  /** Status the next resumes and creates answer with (a 2xx makes the sandbox ready). */
  startStatus: number;
  startBody: Record<string, unknown>;
  /** Whether the launch command prints the relay URL. */
  printUrl: boolean;
  /** Whether the provider's host route answers. */
  hostRoute: boolean;
  chromeStarts: boolean;
  /** Plays a relay that knows the browser sandbox: its create answer carries `purpose`. */
  knowsPurpose: boolean;
  requests: Request[];
  upgrades: Array<{ path: string; host: string | undefined; origin: string | undefined }>;
  frames: string[];
  resumes(): number;
  creates(): number;
  launches(): number;
  quits(): number;
  /** The profile folders the launches named, in order. */
  profiles(): string[];
  close(): Promise<void>;
}

const legacyName = (owner: string) => `ogb-${owner.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "")}-${createHash("sha256").update(owner).digest("hex").slice(0, 6)}`;

export async function startFakeComputer(boxId = "bx_23456789"): Promise<FakeComputer> {
  const secrets = new Map<string, string>();
  const wss = new WebSocketServer({ noServer: true });
  const fake = {
    base: "", state: "ready", exists: true, startStatus: 200, startBody: { ok: true }, printUrl: false, hostRoute: true, chromeStarts: true, knowsPurpose: true,
    requests: [], upgrades: [], frames: [],
  } as unknown as FakeComputer;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      fake.requests.push({ method: req.method ?? "GET", path: url.pathname, ...(typeof body.command === "string" ? { command: body.command } : {}), body });
      const send = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json", connection: "close" }); res.end(JSON.stringify(payload)); };
      if (req.headers.authorization !== `Bearer ${OWN_KEY}`) return send(401, { ok: false });
      const row = { id: boxId, name: legacyName("browser"), state: fake.state };
      const rest = url.pathname.replace(/^\/api\/v1/, "");
      if (rest === "/sandboxes" && req.method === "GET") return send(200, { ok: true, sandboxes: fake.exists ? [row] : [], pageInfo: { nextCursor: null } });
      if (rest === "/sandboxes" && req.method === "POST") {
        if (fake.startStatus >= 300) return send(fake.startStatus, fake.startBody);
        fake.exists = true;
        fake.state = "ready";
        return send(202, { ok: true, sandbox: { id: boxId, state: "provisioning", ...(fake.knowsPurpose && body.purpose ? { purpose: body.purpose } : {}) } });
      }
      if (rest === `/sandboxes/${boxId}` && req.method === "PATCH") return send(200, { ok: true, sandbox: row });
      if (rest === `/sandboxes/${boxId}` && req.method === "GET") return fake.exists ? send(200, { ok: true, sandbox: row }) : send(404, { ok: false });
      if (rest === `/sandboxes/${boxId}` && req.method === "DELETE") { fake.exists = false; return send(200, { ok: true, operation: { id: `bdop_${"a".repeat(32)}`, status: "completed", kind: "sandbox", targetId: boxId } }); }
      if (rest === `/sandboxes/${boxId}/resume`) {
        if (fake.startStatus < 300) fake.state = "ready";
        return send(fake.startStatus, fake.startBody);
      }
      if (rest === `/sandboxes/${boxId}/host`) return fake.hostRoute ? send(200, { ok: true, url: `${fake.base}/door?_token=${RELAY_TOKEN}` }) : send(404, { ok: false, code: "not_found" });
      if (rest === `/sandboxes/${boxId}/commands`) {
        const command = String(body.command ?? "");
        const key = /K="\$D\/([a-f0-9]{16})"/.exec(command)?.[1], secret = /printf %s '([a-f0-9]+)'/.exec(command)?.[1];
        if (key && secret) {
          secrets.set(key, secret);
          const printed = fake.printUrl ? `${fake.base}/door?_token=${RELAY_TOKEN}` : "";
          return send(200, { exitCode: 0, stdout: `${JSON.stringify({ chrome: fake.chromeStarts, url: printed })}\n`, stderr: "" });
        }
        return send(200, { exitCode: 0, stdout: "", stderr: "" });
      }
      if (rest === `/sandboxes/${boxId}/stop`) { fake.state = "archived"; return send(200, { ok: true }); }
      send(404, { ok: false, code: "not_found" });
    });
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://fake");
    fake.upgrades.push({ path: url.pathname, host: req.headers.host, origin: req.headers.origin });
    const [, key = "", secret = ""] = /^\/([a-f0-9]{16})\/([a-f0-9]+)$/.exec(url.pathname) ?? [];
    if (!key || secrets.get(key) !== secret || url.searchParams.get("_token") !== RELAY_TOKEN) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => { const text = String(data); fake.frames.push(text); ws.send(`echo:${key}:${text}`); });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const count = (test: (request: Request) => boolean) => fake.requests.filter(test).length;
  fake.resumes = () => count((request) => request.method === "POST" && request.path.endsWith("/resume"));
  fake.creates = () => count((request) => request.method === "POST" && request.path === "/api/v1/sandboxes");
  fake.launches = () => count((request) => request.command?.includes("printf %s") === true);
  fake.quits = () => count((request) => request.command?.includes("pkill -TERM") === true);
  fake.profiles = () => fake.requests.flatMap((request) => {
    const key = request.command?.includes("printf %s") ? /K="\$D\/([a-f0-9]{16})"/.exec(request.command)?.[1] : undefined;
    return key ? [key] : [];
  });
  fake.close = async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return fake;
}
