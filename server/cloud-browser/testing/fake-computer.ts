// A fake Admin relay and provider for the Cloud's browser sandbox: the relay's API (probe, list, create, name, resume,
// state, browser actions, host, delete) and the sandbox's door behind its relay URL, which answers a WebSocket upgrade as
// Chrome would and echoes every frame. Nothing here reaches a real provider or starts a real sandbox.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";

export const RELAY_KEY = "box_omb_relay-test-key";
export const RELAY_TOKEN = "relay-token-123";

type Request = { method: string; path: string; body?: Record<string, unknown> };

export interface FakeComputer {
  base: string;
  state: string;
  /** Whether the sandbox exists yet; a create makes it. */
  exists: boolean;
  /** Status the next resumes and creates answer with (a 2xx makes the sandbox ready). */
  startStatus: number;
  startBody: Record<string, unknown>;
  /** Plays an Admin from before the browser sandbox: no probe route, and a create that does not say `purpose`. */
  oldRelay: boolean;
  /** The probe's answer while not old: available, or why not and until when. */
  available: boolean;
  unavailableReason: string;
  unavailableUntil: string | null;
  /** Whether the host route answers, and whether it says the URL is protected. */
  hostRoute: boolean;
  unprotected: boolean;
  chromeStarts: boolean;
  requests: Request[];
  upgrades: Array<{ path: string; host: string | undefined; origin: string | undefined }>;
  frames: string[];
  boxId: string;
  resumes(): number;
  creates(): number;
  launches(): number;
  /** Each quit action, as `quit:<key>` or `quit-all`. */
  quits(): string[];
  /** The profile keys the launches named, in order. */
  profiles(): string[];
  close(): Promise<void>;
}

const legacyName = (owner: string) => `ogb-${owner.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "")}-${createHash("sha256").update(owner).digest("hex").slice(0, 6)}`;

export async function startFakeComputer(): Promise<FakeComputer> {
  const secrets = new Map<string, string>();
  const wss = new WebSocketServer({ noServer: true });
  let made = 0;
  const fake = {
    base: "", state: "ready", exists: true, startStatus: 200, startBody: { ok: true }, oldRelay: false, available: true, unavailableReason: "fleet_starts",
    unavailableUntil: null, hostRoute: true, unprotected: false, chromeStarts: true, requests: [], upgrades: [], frames: [], boxId: "bx_23456789",
  } as unknown as FakeComputer;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      fake.requests.push({ method: req.method ?? "GET", path: url.pathname, body });
      const send = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json", connection: "close" }); res.end(JSON.stringify(payload)); };
      if (req.headers.authorization !== `Bearer ${RELAY_KEY}`) return send(401, { ok: false });
      const boxId = fake.boxId;
      const row = { id: boxId, name: legacyName("browser"), state: fake.state };
      const rest = url.pathname.replace(/^\/api\/v1/, "");
      if (rest === "/browser-sandbox") {
        if (fake.oldRelay) return send(404, { ok: false, code: "not_found" });
        return send(200, { ok: true, type: "browser.sandbox", available: fake.available, boxId: fake.exists ? boxId : null,
          ...(fake.available ? {} : { reason: fake.unavailableReason, ...(fake.unavailableUntil ? { resetsAt: fake.unavailableUntil } : {}) }) });
      }
      if (rest === "/sandboxes" && req.method === "GET") return send(200, { ok: true, sandboxes: fake.exists ? [row] : [], pageInfo: { nextCursor: null } });
      if (rest === "/sandboxes" && req.method === "POST") {
        if (fake.startStatus >= 300) return send(fake.startStatus, fake.startBody);
        made += 1;
        fake.boxId = made === 1 ? fake.boxId : `bx_2345678${"abcdefgh"[made % 8]}`;
        fake.exists = true;
        fake.state = "ready";
        return send(202, { ok: true, sandbox: { id: fake.boxId, state: "provisioning", ...(!fake.oldRelay && body.purpose ? { purpose: body.purpose } : {}) } });
      }
      if (rest === `/sandboxes/${boxId}` && req.method === "PATCH") return send(200, { ok: true, sandbox: row });
      if (rest === `/sandboxes/${boxId}` && req.method === "GET") return fake.exists ? send(200, { ok: true, sandbox: row }) : send(404, { ok: false });
      if (rest === `/sandboxes/${boxId}` && req.method === "DELETE") {
        fake.exists = false;
        fake.state = "ready";
        return send(200, { ok: true, operation: { id: `bdop_${"a".repeat(32)}`, status: "completed", kind: "sandbox", targetId: boxId } });
      }
      if (rest === `/sandboxes/${boxId}/resume`) {
        if (fake.startStatus < 300) fake.state = "ready";
        return send(fake.startStatus, fake.startBody);
      }
      if (rest === `/sandboxes/${boxId}/host`) {
        if (!fake.hostRoute) return send(404, { ok: false, code: "not_found" });
        return send(200, fake.unprotected ? { ok: true, url: `${fake.base}/door`, isProtected: false, access: "public" }
          : { ok: true, url: `${fake.base}/door?_token=${RELAY_TOKEN}`, isProtected: true, access: "private" });
      }
      if (rest === `/sandboxes/${boxId}/browser`) {
        if (body.action === "launch" && typeof body.key === "string" && typeof body.secret === "string") {
          secrets.set(body.key, body.secret);
          return send(200, { ok: true, chrome: fake.chromeStarts, policy: true });
        }
        return send(200, { ok: true });
      }
      if (rest === `/sandboxes/${boxId}/commands`) return send(404, { ok: false, code: "not_found" });
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
  const actions = (name: string) => fake.requests.filter((request) => request.path.endsWith("/browser") && request.body?.action === name);
  fake.resumes = () => fake.requests.filter((request) => request.method === "POST" && request.path.endsWith("/resume")).length;
  fake.creates = () => fake.requests.filter((request) => request.method === "POST" && request.path === "/api/v1/sandboxes").length;
  fake.launches = () => actions("launch").length;
  fake.quits = () => fake.requests.flatMap((request) => !request.path.endsWith("/browser") ? []
    : request.body?.action === "quit" ? [`quit:${String(request.body.key)}`] : request.body?.action === "quit-all" ? ["quit-all"] : []);
  fake.profiles = () => actions("launch").map((request) => String(request.body?.key));
  fake.close = async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return fake;
}
