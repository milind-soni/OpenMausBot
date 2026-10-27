// The device link end to end in one process: the real shared-computers routes behind a real HTTP server's upgrades,
// My Cloud's DeviceLinks, and the computer's own link client with its own check on each connection.
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as tcpConnect, createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { runDeviceLink } from "../electron/device-link.mjs";
import { LINK_ENDED, linkPath } from "../electron/device-link-protocol.mjs";
import { DeviceLinks } from "./device-links.ts";
import { json, readBody } from "./harness/http.ts";
import { createSharedComputerRoutes } from "./routes/shared-computers.ts";
import { createUpgrades } from "./routes/upgrades.ts";
import { LentComputers, SharedComputers } from "./shared-computers.ts";
import type { RequestAuth } from "./request-auth.ts";

const secret = "a".repeat(64);
const PERSON = "cloud-home";
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** My Cloud's HTTP side for lending: a bearer of `session-<id>` is that paired session. */
async function cloud(options: { sleeping?: () => boolean; sleep?: AbortController } = {}) {
  const live = new Set(["owner", "other"]);
  const links = new DeviceLinks({ pingMs: 100 });
  const lent = new LentComputers(`/nonexistent-${randomUUID()}/lent-computers.json`);
  const computers = new SharedComputers((id) => live.has(id), lent, links);
  const upgrades = createUpgrades();
  const sleep = options.sleep ?? new AbortController();
  const route = createSharedComputerRoutes({
    enabled: () => true, computers, sessionLive: (id) => live.has(id), environmentId: "11111111-1111-4111-8111-111111111111",
    cloudHomeLender: PERSON, principal: () => PERSON, personKey: () => PERSON,
    power: () => ({ sleeping: options.sleeping ?? (() => false), sleepSignal: () => sleep.signal }),
    links, upgrades,
  });
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://cloud.test");
    const bearer = /^Bearer session-(\w+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    if (!bearer || !live.has(bearer)) return json(res, 401, { error: "unauthorized" });
    const auth = { kind: "session", session: { id: bearer }, scopes: ["admin", "client"], via: "bearer" } as unknown as RequestAuth;
    try {
      await route({ req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: String(error) });
    }
  };
  const server: Server = createServer((req, res) => void handle(req, res));
  upgrades.attach(server, handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => new Promise<void>((resolve) => { computers.close(); links.close(); upgrades.close(); server.closeAllConnections(); server.close(() => resolve()); }));
  const register = async (session = "owner", internet = true, id: string = randomUUID(), chrome = false) => {
    const response = await fetch(`${base}/api/shared-computers/connect`, { method: "POST", headers: { authorization: `Bearer session-${session}`, "content-type": "application/json", "x-omb-computer-secret": secret },
      body: JSON.stringify({ id, name: "Ash's MacBook", environmentId: "11111111-1111-4111-8111-111111111111", folders: [], terminal: false, computer: false, platform: "darwin", internet, ...(chrome ? { chrome } : {}) }) });
    expect(response.status, await response.clone().text()).toBe(200);
    return id;
  };
  return { base, links, computers, lent, live, register, sleep };
}

/** A web server standing in for the public internet, reached only through the computer's own connect. */
async function website() {
  const seen: Array<{ remotePort: number; host: string | undefined }> = [];
  const server = createServer((req, res) => { seen.push({ remotePort: req.socket.remotePort!, host: req.headers.host }); res.end(`hello from ${req.headers.host}`); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { port: (server.address() as AddressInfo).port, seen };
}

/** The computer's link: names resolve only here, to a public address the test routes to `website`. */
function link(base: string, id: string, websitePort: number, options: { session?: string; secret?: string } = {}) {
  const stop = new AbortController();
  const outgoing: number[] = [];
  let opens = 0;
  const ended = runDeviceLink({
    url: `${base.replace("http", "ws")}${linkPath(id)}`, signal: stop.signal, onOpen: () => opens++,
    headers: { authorization: `Bearer session-${options.session ?? "owner"}`, "x-omb-computer-secret": options.secret ?? secret },
    egress: {
      interfaces: () => ({}),
      resolve: async (host: string) => (host.endsWith(".example") ? [{ address: "93.184.215.14", family: 4 }] : host === "router.example.net" ? [{ address: "192.168.1.1", family: 4 }] : []),
      connect: (connectOptions: { port: number }) => {
        // The public internet, for this test: only the checked public address on port 443 reaches the website.
        const socket = tcpConnect(connectOptions.port === 443 ? websitePort : 1, "127.0.0.1");
        socket.once("connect", () => outgoing.push(socket.localPort!));
        return socket;
      },
    },
  });
  cleanups.push(() => { stop.abort(); return ended; });
  return { stop, ended, outgoing, opens: () => opens };
}

const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`timed out waiting for ${what}`);
};

/** One HTTP request through a route, as a bot's Chrome would make it through the egress gate. */
async function fetchThrough(route: NonNullable<ReturnType<DeviceLinks["route"]>>, host: string, port = 443) {
  const opened = await route.open({ host, port });
  if (!("join" in opened)) return opened;
  const relay = createTcpServer();
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const accepted = new Promise<Socket>((resolve) => relay.once("connection", resolve));
  const client = tcpConnect((relay.address() as AddressInfo).port, "127.0.0.1");
  opened.join(await accepted, [Buffer.from(`GET / HTTP/1.1\r\nhost: ${host}\r\nconnection: close\r\n\r\n`)]);
  let text = "";
  client.on("data", (chunk) => { text += chunk; });
  await new Promise((resolve) => client.once("close", resolve));
  relay.close();
  return { text };
}

describe("the device link", () => {
  it("lets the computer that lent its internet connection carry My Cloud's browsing, and answers the website from the computer's own connection", async () => {
    const home = await cloud();
    const site = await website();
    const id = await home.register();
    const mac = link(home.base, id, site.port);
    await until(() => home.links.route(PERSON) !== null, "the link to be offered as a way out");
    const answer = await fetchThrough(home.links.route(PERSON)!, "www.instagram.example");
    expect("text" in answer && answer.text).toContain("hello from www.instagram.example");
    expect(site.seen.map((entry) => entry.remotePort), "the website saw the computer's own connection").toEqual(mac.outgoing);
    expect(await home.links.route(PERSON)!.open({ host: "router.example.net", port: 443 })).toEqual({ refused: "home-network" });
    expect(await home.links.route(PERSON)!.open({ host: "www.instagram.example", port: 25 })).toEqual({ refused: "port" });
    expect(home.computers.known(PERSON)[0]!.scopes.internet).toBe(true);
  });

  it("marks the computer used when a page opens through it, at most once a minute, and not for a refusal", async () => {
    const home = await cloud();
    const site = await website();
    const id = await home.register();
    link(home.base, id, site.port);
    await until(() => home.links.route(PERSON) !== null, "the link to be offered as a way out");
    let marks = 0;
    const used = home.lent.used.bind(home.lent);
    home.lent.used = (person, computer) => { marks++; used(person, computer); };
    expect(await home.links.route(PERSON)!.open({ host: "router.example.net", port: 443 })).toEqual({ refused: "home-network" });
    expect(marks, "a refusal is not a use").toBe(0);
    expect(home.computers.known(PERSON)[0]!.lastUsedAt).toBeNull();
    await fetchThrough(home.links.route(PERSON)!, "www.instagram.example");
    expect(marks).toBe(1);
    expect(home.computers.known(PERSON)[0]!.lastUsedAt).toEqual(expect.any(Number));
    await fetchThrough(home.links.route(PERSON)!, "www.youtube.example");
    expect(marks, "a page's many connections are one use a minute").toBe(1);
  });

  it("opens only for the session and secret that registered the computer, and never for one that does not lend its connection", async () => {
    const home = await cloud();
    const site = await website();
    const id = await home.register();
    for (const wrong of [{ secret: "b".repeat(64) }, { session: "other" }]) {
      const attempt = link(home.base, id, site.port, wrong);
      expect((await attempt.ended).code).toBe(1006);
      expect(attempt.opens()).toBe(0);
    }
    expect((await link(home.base, randomUUID(), site.port).ended).code, "a computer that never registered").toBe(1006);
    const folderOnly = await home.register("owner", false);
    const notLent = link(home.base, folderOnly, site.port);
    await until(() => notLent.opens() === 1, "the link of a computer that lends folders only");
    expect(home.links.route(PERSON), "its link exists, but My Cloud never sends browsing through it").toBeNull();
  });

  it("ends the link when lending stops, when the session ends, and when a newer link replaces it; the route goes with it", async () => {
    const home = await cloud();
    const site = await website();
    const id = await home.register();
    const first = link(home.base, id, site.port);
    await until(() => home.links.route(PERSON) !== null, "the first link");
    const second = link(home.base, id, site.port);
    expect((await first.ended).code, "the newer link replaces the older").toBe(1000);
    await until(() => second.opens() === 1 && home.links.route(PERSON) !== null, "the second link");
    await fetch(`${home.base}/api/shared-computers/${id}/disconnect`, { method: "POST", headers: { authorization: "Bearer session-owner", "content-type": "application/json", "x-omb-computer-secret": secret }, body: "{}" });
    expect((await second.ended).code).toBe(LINK_ENDED);
    expect(home.links.route(PERSON)).toBeNull();
  });

  it("carries no more browsing the moment the computer's session is signed out, and ends its link", async () => {
    const home = await cloud();
    const site = await website();
    const id = await home.register();
    const mac = link(home.base, id, site.port);
    await until(() => home.links.route(PERSON) !== null, "the link");
    home.live.delete("owner");
    expect(home.links.route(PERSON), "the next page goes My Cloud's own way").toBeNull();
    expect((await mac.ended).code).toBe(LINK_ENDED);
  });

  it("ends the link when the computer registers again without its internet connection, and keeps it through any other registration", async () => {
    const home = await cloud();
    const site = await website();
    const id = await home.register();
    const mac = link(home.base, id, site.port);
    let ended = false;
    void mac.ended.then(() => { ended = true; });
    await until(() => home.links.route(PERSON) !== null, "the link");
    await home.register("owner", true, id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ended, "the same grant registered again keeps its link").toBe(false);
    expect(home.links.route(PERSON)).not.toBeNull();
    await home.register("owner", false, id);
    expect(home.links.route(PERSON), "no page goes through a computer that stopped lending its connection").toBeNull();
    expect((await mac.ended).code).toBe(LINK_ENDED);
  });

  it("leaves no sleep listener behind when a link ends, however often the computer reconnects while My Cloud stays awake", async () => {
    const sleep = new AbortController();
    const home = await cloud({ sleep });
    const site = await website();
    const id = await home.register();
    for (let round = 0; round < 5; round++) {
      const mac = link(home.base, id, site.port);
      await until(() => mac.opens() === 1, "the link");
      mac.stop.abort();
      await mac.ended;
      await until(() => home.links.route(PERSON) === null, "the link to end on My Cloud");
    }
    await until(() => getEventListeners(sleep.signal, "abort").length === 0, "every ended link's sleep listener to go", 2_000);
  });

  it("closes as asleep when My Cloud agrees to sleep, and refuses a new link while it sleeps", async () => {
    let sleeping = false;
    const sleep = new AbortController();
    const home = await cloud({ sleeping: () => sleeping, sleep });
    const site = await website();
    const id = await home.register();
    const mac = link(home.base, id, site.port);
    await until(() => mac.opens() === 1, "the link");
    sleeping = true;
    sleep.abort();
    expect(await mac.ended).toEqual({ code: 4001, reason: "asleep" });
    expect(home.links.route(PERSON)).toBeNull();
    expect((await link(home.base, id, site.port).ended).code, "a link dialled while My Cloud sleeps is told so at once").toBe(4001);
  });

  it("a Chrome stream goes only to a computer that lends Chrome, through its own door", async () => {
    const home = await cloud();
    const echo = createTcpServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { echo.close(() => resolve()); }));
    const id = await home.register("owner", false, randomUUID(), true);
    const stop = new AbortController();
    const ended = runDeviceLink({
      url: `${home.base.replace("http", "ws")}${linkPath(id)}`, signal: stop.signal,
      headers: { authorization: "Bearer session-owner", "x-omb-computer-secret": secret },
      lends: () => ({ internet: false, chrome: true }),
      chrome: { open: async () => ({ socket: tcpConnect((echo.address() as AddressInfo).port, "127.0.0.1") }) },
    });
    cleanups.push(() => { stop.abort(); return ended; });
    await until(() => home.links.chromeRoute(PERSON) !== null, "the link to be offered as a way to Chrome");
    expect(home.links.route(PERSON), "it does not lend its internet connection").toBeNull();
    const opened = await home.links.chromeRoute(PERSON)!.open();
    expect("join" in opened).toBe(true);
    const relay = createTcpServer();
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const accepted = new Promise<Socket>((resolve) => relay.once("connection", resolve));
    const client = tcpConnect((relay.address() as AddressInfo).port, "127.0.0.1");
    (opened as { join: (socket: Socket, head: Buffer[]) => void }).join(await accepted, []);
    client.write("ping");
    const echoed = await new Promise<string>((resolve) => client.once("data", (chunk) => resolve(String(chunk))));
    expect(echoed).toBe("ping");
    client.destroy();
    relay.close();
  });

  it("a computer registered without Chrome has no Chrome route, while its internet route still works", async () => {
    const home = await cloud();
    const site = await website();
    const id = await home.register();
    link(home.base, id, site.port);
    await until(() => home.links.route(PERSON) !== null, "the link");
    expect(home.links.chromeRoute(PERSON)).toBeNull();
  });

  it("drops a link that stops answering, so My Cloud's browsing never waits on a computer that went to sleep", async () => {
    const home = await cloud();
    const id = await home.register();
    // A computer that opens the link and then answers nothing, not even WebSocket pings.
    const url = new URL(`${home.base}${linkPath(id)}`);
    const socket = tcpConnect(Number(url.port), "127.0.0.1");
    socket.on("error", () => {});
    await new Promise((resolve) => socket.once("connect", resolve));
    socket.write(`GET ${url.pathname} HTTP/1.1\r\nhost: ${url.host}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-version: 13\r\nsec-websocket-key: ${Buffer.from(randomUUID().slice(0, 16)).toString("base64")}\r\nauthorization: Bearer session-owner\r\nx-omb-computer-secret: ${secret}\r\n\r\n`);
    await until(() => home.links.route(PERSON) !== null, "the silent link to be accepted");
    socket.pause();
    await until(() => home.links.route(PERSON) === null, "the silent link to be dropped", 2_000);
    socket.destroy();
  });
});
