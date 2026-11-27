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
  /** Cookies of one site Chrome keeps at most (its per-site limit); null keeps all. */
  cookieCap: number | null;
  /** How an Admin from before the browser sandbox answers its probe: 404, or 403 `not_available`. */
  oldRelayAnswer: 403 | 404;
  /** Answers the relay holds back, by path ending: the request waits this many ms (a sandbox stuck provisioning). */
  stall: Map<string, number>;
  /** The profile keys an erase action named. */
  erased: string[];
  /** The caps the probe says this Cloud's plan has. */
  caps: { resumesPerDay: number; awakeMinutesPerDay: number } | null;
  /** Status the PATCH of a sandbox answers with. */
  patchStatus: number;
  /** How many Chromes the probe says this Cloud's sandbox takes (by its plan's size). */
  chromes: number;
  /** A resume during `archiving` finds the machine already gone. */
  takeBackFails: boolean;
  /** Whether the launch could write the Chrome policy (sudo in the sandbox). */
  policy: boolean;
  requests: Request[];
  upgrades: Array<{ path: string; host: string | undefined; origin: string | undefined; query?: string }>;
  frames: string[];
  boxId: string;
  /** Files on the sandbox's disk by path (downloads the page made, uploads the home sent). */
  files: Map<string, Buffer>;
  /** Each bot's cookies in its sandbox Chrome, by profile key, as `Storage.setCookies` left them. */
  cookies: Map<string, Array<Record<string, unknown>>>;
  /** Every DevTools command the sandbox's Chromes got, with its profile key. */
  commands: Array<{ key: string; method: string; params: Record<string, unknown> }>;
  /** DevTools commands the sandbox's Chrome answers with an error, by method; `Storage.setCookies` also refuses a
   * SameSite=None cookie without Secure, as Chrome does. */
  failing: Set<string>;
  /** Sends a DevTools event to the connections of a profile that asked for download events. */
  emit(key: string, method: string, params: Record<string, unknown>): void;
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
  let retired = true;
  const fake = {
    base: "", state: "ready", exists: true, startStatus: 200, startBody: { ok: true }, oldRelay: false, available: true, unavailableReason: "fleet_starts",
    unavailableUntil: null, hostRoute: true, unprotected: false, chromeStarts: true, policy: true, takeBackFails: false, chromes: 2, caps: null, patchStatus: 200, oldRelayAnswer: 404, cookieCap: null, stall: new Map(), erased: [], requests: [], upgrades: [], frames: [], boxId: "bx_23456789",
    files: new Map(), cookies: new Map(), commands: [], failing: new Set(),
  } as unknown as FakeComputer;
  const watchers = new Map<string, Set<import("ws").WebSocket>>();
  const HOME = "/home/user";
  /** A held-back answer waits its time first (a sandbox stuck provisioning); every other answers at once. */
  const after = (path: string, respond: () => void) => {
    const entry = [...fake.stall].find(([ending]) => path.endsWith(ending));
    if (!entry) return respond();
    fake.stall.delete(entry[0]);
    setTimeout(respond, entry[1]);
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => after(url.pathname, () => {
      // The transfer links: no bearer, as the provider's signed links need none.
      if (url.pathname === "/file" && req.method === "GET") {
        const file = fake.files.get(url.searchParams.get("p") ?? "");
        res.writeHead(file ? 200 : 404, { "content-length": String(file?.length ?? 0), connection: "close" });
        res.end(file ?? "");
        return;
      }
      if (url.pathname === "/put" && req.method === "PUT") {
        fake.files.set(url.searchParams.get("p") ?? "", Buffer.concat(chunks));
        res.writeHead(200, { connection: "close" });
        res.end();
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw && !url.pathname.startsWith("/put") ? JSON.parse(raw) as Record<string, unknown> : {};
      fake.requests.push({ method: req.method ?? "GET", path: url.pathname, body });
      const send = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json", connection: "close" }); res.end(JSON.stringify(payload)); };
      if (req.headers.authorization !== `Bearer ${RELAY_KEY}`) return send(401, { ok: false });
      const boxId = fake.boxId;
      const row = { id: boxId, name: legacyName("browser"), state: fake.state };
      const rest = url.pathname.replace(/^\/api\/v1/, "");
      if (rest === "/browser-sandbox") {
        if (fake.oldRelay) return fake.oldRelayAnswer === 403 ? send(403, { ok: false, code: "not_available", message: "Not available." }) : send(404, { ok: false, code: "not_found" });
        return send(200, { ok: true, type: "browser.sandbox", available: fake.available, boxId: fake.exists ? boxId : null, sandboxType: fake.chromes > 2 ? "default" : "small", chromes: fake.chromes, ...(fake.caps ? { caps: fake.caps } : {}),
          ...(fake.available ? {} : { reason: fake.unavailableReason, ...(fake.unavailableUntil ? { resetsAt: fake.unavailableUntil } : {}) }) });
      }
      if (rest === "/sandboxes" && req.method === "GET") return send(200, { ok: true, sandboxes: fake.exists ? [row] : [], pageInfo: { nextCursor: null } });
      if (rest === "/sandboxes" && req.method === "POST") {
        if (fake.startStatus >= 300) return send(fake.startStatus, fake.startBody);
        // A sandbox made after one was deleted is a new one, with an id of its own.
        if (retired) { made += 1; fake.boxId = `bx_2345678${"abcdefgh"[made % 8]}`; retired = false; }
        fake.exists = true;
        fake.state = "ready";
        return send(202, { ok: true, sandbox: { id: fake.boxId, state: "provisioning", ...(!fake.oldRelay && body.purpose ? { purpose: body.purpose } : {}) } });
      }
      if (rest === `/sandboxes/${boxId}` && req.method === "PATCH") return body.ttlSeconds !== undefined && fake.patchStatus >= 300 ? send(fake.patchStatus, { ok: false }) : send(200, { ok: true, sandbox: row });
      if (rest === `/sandboxes/${boxId}` && req.method === "GET") return fake.exists ? send(200, { ok: true, sandbox: row }) : send(404, { ok: false });
      if (rest === `/sandboxes/${boxId}` && req.method === "DELETE") {
        fake.exists = false;
        retired = true;
        fake.state = "ready";
        return send(200, { ok: true, operation: { id: `bdop_${"a".repeat(32)}`, status: "completed", kind: "sandbox", targetId: boxId } });
      }
      if (rest === `/sandboxes/${boxId}/resume`) {
        // Taken back while still stopping, unless the machine already went: then the stop finishes and the answer is 409.
        if (fake.state === "archiving" && fake.takeBackFails) { fake.state = "archived"; return send(409, { ok: false, code: "sandbox_stopping" }); }
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
          return send(200, { ok: true, chrome: fake.chromeStarts, policy: fake.policy, home: HOME });
        }
        if (body.action === "erase" && typeof body.key === "string") { fake.erased.push(body.key); fake.cookies.delete(body.key); return send(200, { ok: true }); }
        if (body.action === "remove-download") fake.files.delete(`${HOME}/.omb-browser/.downloads/${String(body.key)}/${String(body.name)}`);
        return send(200, { ok: true });
      }
      if (rest === `/sandboxes/${boxId}/commands`) return send(404, { ok: false, code: "not_found" });
      if (rest === `/sandboxes/${boxId}/files/download-url` || rest === `/sandboxes/${boxId}/files/upload-url`) {
        const path = String(body.path ?? "");
        const download = rest.endsWith("download-url");
        if (!new RegExp(`^${HOME}/\\.omb-browser/\\.${download ? "downloads" : "uploads"}/[a-f0-9]{16}/[^/.][^/]*$`).test(path)) return send(404, { ok: false, code: "not_found" });
        return send(200, { ok: true, url: `${fake.base}/${download ? "file" : "put"}?p=${encodeURIComponent(path)}`, method: download ? "GET" : "PUT", path });
      }
      if (rest === `/sandboxes/${boxId}/stop`) { fake.state = "archived"; return send(200, { ok: true }); }
      send(404, { ok: false, code: "not_found" });
    }));
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://fake");
    fake.upgrades.push({ path: url.pathname, host: req.headers.host, origin: req.headers.origin });
    const [, key = "", secret = ""] = /^\/([a-f0-9]{16})\/([a-f0-9]+)$/.exec(url.pathname) ?? [];
    // The provider's edge takes the token as the `_port_auth` cookie from an API client; a `?_token=` request gets a redirect.
    const cookie = /(?:^|;\s*)_port_auth=([^;]+)/.exec(String(req.headers.cookie ?? ""))?.[1];
    fake.upgrades.at(-1)!.query = url.search;
    if (!key || secrets.get(key) !== secret || cookie !== RELAY_TOKEN || url.search) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => {
        const text = String(data);
        fake.frames.push(text);
        const message = JSON.parse(text) as { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string };
        // A DevTools command gets Chrome's answer; anything else (the engine's frames in these tests) comes back echoed.
        if (typeof message.method !== "string") { ws.send(`echo:${key}:${text}`); return; }
        const params = message.params ?? {};
        fake.commands.push({ key, method: message.method, params });
        let result: Record<string, unknown> = {};
        const refusedCookie = message.method === "Storage.setCookies" && (params.cookies as Array<Record<string, unknown>>).some((cookie) => cookie.sameSite === "None" && cookie.secure !== true);
        // A sandbox that stopped answers nothing on a connection it had: as if the machine went.
        if (fake.state === "archived" || fake.state === "archiving") { ws.terminate(); return; }
        if (fake.failing.has(message.method) || refusedCookie) {
          ws.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Sanitizing cookie failed" } }));
          return;
        }
        if (message.method === "Storage.clearCookies") fake.cookies.set(key, []);
        if (message.method === "Storage.setCookies") {
          // Chrome keeps at most so many cookies of one site and drops the rest by itself, as it does past its per-site limit.
          const all = [...(fake.cookies.get(key) ?? []), ...(params.cookies as Array<Record<string, unknown>>)];
          fake.cookies.set(key, fake.cookieCap === null ? all : all.filter((cookie, i) => all.slice(0, i).filter((one) => one.domain === cookie.domain).length < fake.cookieCap!));
        }
        if (message.method === "Storage.getCookies") result = { cookies: (fake.cookies.get(key) ?? []).map((cookie) => ({ ...cookie, size: 1, session: cookie.expires === undefined, expires: cookie.expires ?? -1 })) };
        if (message.method === "Browser.setDownloadBehavior") { const set = watchers.get(key) ?? new Set(); set.add(ws); watchers.set(key, set); }
        if (message.method === "Target.createTarget") result = { targetId: "page-1" };
        if (message.method === "Target.attachToTarget") result = { sessionId: "session-1" };
        ws.send(JSON.stringify({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
      });
      ws.on("close", () => watchers.get(key)?.delete(ws));
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
  fake.emit = (key, method, params) => { for (const ws of watchers.get(key) ?? []) ws.send(JSON.stringify({ method, params })); };
  fake.close = async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return fake;
}
