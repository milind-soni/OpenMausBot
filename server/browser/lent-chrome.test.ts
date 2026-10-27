import { createServer, connect, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { LinkOpened } from "../../electron/device-link-protocol.mjs";
import type { ChromeRoute } from "../device-links.ts";
import { LentChromeDoors, lentChromeGuidance, type LentChromeDeps } from "./lent-chrome.ts";

const servers: Server[] = [];
const sockets: Socket[] = [];
const doors: LentChromeDoors[] = [];

afterEach(() => {
  for (const door of doors.splice(0)) door.close();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.close();
});

const within = <T>(promise: Promise<T>, ms = 2000): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, fail) => setTimeout(() => fail(new Error("timed out")), ms).unref())]);

async function echo(): Promise<{ port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("data", (chunk: Buffer) => { received.push(chunk); socket.write(chunk); });
    socket.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { port: (server.address() as { port: number }).port, received };
}

function joining(port: number): ChromeRoute {
  return {
    open: async (): Promise<LinkOpened> => ({
      join(socket, early) {
        const upstream = connect(port, "127.0.0.1");
        sockets.push(upstream);
        upstream.on("error", () => socket.destroy());
        for (const chunk of early ?? []) upstream.write(chunk);
        upstream.pipe(socket);
        socket.pipe(upstream);
        socket.on("close", () => upstream.destroy());
      },
      cancel() {},
    }),
  };
}

/** A route whose far end answers `reply` in two writes once joined, or holds the connection without a word. */
function answering(reply: string | null): ChromeRoute & { joined: Promise<void> } {
  let joined = () => {};
  const done = new Promise<void>((resolve) => { joined = resolve; });
  return {
    joined: done,
    open: async (): Promise<LinkOpened> => ({
      join(socket) {
        if (reply !== null) for (const part of [reply.slice(0, 7), reply.slice(7)]) socket.write(Buffer.from(part));
        joined();
      },
      cancel() {},
    }),
  };
}

function make(route: ChromeRoute | null, extra: Partial<LentChromeDeps> = {}) {
  const calls = { open: 0 };
  const counted: ChromeRoute | null = route && { open: () => { calls.open += 1; return route.open(); } };
  const door = new LentChromeDoors({ route: () => counted, allowed: () => true, idleMs: () => 60_000, ...extra });
  doors.push(door);
  return { door, calls };
}

const head = (path: string) => Buffer.from(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);

async function client(url: string, bytes?: Buffer, pathOverride?: string): Promise<Socket> {
  const parsed = new URL(url);
  const socket = connect(Number(parsed.port), "127.0.0.1");
  sockets.push(socket);
  await within(new Promise<void>((done) => socket.once("connect", done)));
  socket.write(bytes ?? head(pathOverride ?? parsed.pathname));
  return socket;
}

const received = (socket: Socket, length: number) => within(new Promise<string>((done) => {
  let got = "";
  socket.on("data", (chunk: Buffer) => { got += chunk.toString("latin1"); if (got.length >= length) done(got); });
}));
const nextData = (socket: Socket) => within(new Promise<Buffer>((done) => socket.once("data", (chunk: Buffer) => done(chunk))));
const closed = (socket: Socket) => within(new Promise<void>((done) => { socket.resume(); socket.once("close", () => done()); }));

describe("LentChromeDoors", () => {
  it("hands out one tokenized loopback address per session", async () => {
    const { door } = make(null);
    const first = await door.door("s1");
    expect(await door.door("s1")).toBe(first);
    expect(first).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9]{64}$/);
    const other = await door.door("s2");
    expect(new URL(other).port).not.toBe(new URL(first).port);
    expect(new URL(other).pathname).not.toBe(new URL(first).pathname);
    expect(door.owns("s1")).toBe(true);
    expect(door.owns("x")).toBe(false);
  });

  it("a connection without the token gets 404, opens no stream and records nothing", async () => {
    const target = await echo();
    const { door, calls } = make(joining(target.port));
    const url = await door.door("s1");
    const socket = await client(url, undefined, `/devtools/browser/${"0".repeat(64)}`);
    expect((await nextData(socket)).toString()).toMatch(/^HTTP\/1\.1 404/);
    expect(calls.open).toBe(0);
    expect(door.problem("s1")).toBeNull();
  });

  it("joins the session's connection through the route, head included", async () => {
    const target = await echo();
    const { door } = make(joining(target.port));
    const url = await door.door("s1");
    const sent = head(new URL(url).pathname);
    const socket = await client(url, sent);
    let got = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => { got = Buffer.concat([got, chunk]); });
    await within(new Promise<void>((done) => { const timer = setInterval(() => { if (got.length >= sent.length) { clearInterval(timer); done(); } }, 5); timer.unref(); }));
    expect(Buffer.concat(target.received).subarray(0, sent.length).equals(sent)).toBe(true);
    socket.write("hello");
    const tail = await within(new Promise<string>((done) => {
      const timer = setInterval(() => { if (got.toString().endsWith("hello")) { clearInterval(timer); done("hello"); } }, 5);
      timer.unref();
    }));
    expect(tail).toBe("hello");
  });

  it("a refused holder gets 403 and not-allowed", async () => {
    const target = await echo();
    const { door, calls } = make(joining(target.port), { allowed: () => false });
    const socket = await client(await door.door("s1"));
    expect((await nextData(socket)).toString()).toMatch(/^HTTP\/1\.1 403/);
    expect(door.problem("s1")).toBe("not-allowed");
    expect(calls.open).toBe(0);
  });

  it("each way of not reaching Chrome is recorded", async () => {
    const cases: [ChromeRoute | null, string][] = [
      [null, "offline"],
      [{ open: async () => ({ gone: true }) }, "offline"],
      [{ open: async () => ({ refused: "not-lent" }) }, "not-lent"],
      [{ open: async () => ({ refused: "port" }) }, "unreachable"],
      [{ open: async () => ({ failed: "no-chrome" }) }, "no-chrome"],
      [{ open: async () => ({ failed: "timeout" }) }, "unreachable"],
    ];
    for (const [route, problem] of cases) {
      const { door } = make(route);
      const socket = await client(await door.door("s1"));
      expect((await nextData(socket)).toString()).toMatch(/^HTTP\/1\.1 50/);
      expect(door.problem("s1")).toBe(problem);
    }
    let current: ChromeRoute | null = { open: async () => ({ gone: true }) };
    const door = new LentChromeDoors({ route: () => current, allowed: () => true, idleMs: () => 60_000 });
    doors.push(door);
    const url = await door.door("s1");
    await nextData(await client(url));
    expect(door.problem("s1")).toBe("offline");
    const switched = "HTTP/1.1 101 Switching Protocols\r\n\r\n";
    current = answering(switched);
    await received(await client(url), switched.length);
    expect(door.problem("s1")).toBeNull();
  });

  it("a joined connection counts as reaching Chrome only once Chrome answers 101", async () => {
    const silent = answering(null);
    const held = make(silent).door;
    await client(await held.door("s1"));
    await within(silent.joined);
    expect(held.problem("s1"), "Chrome waits for the person to click Allow").toBe("unreachable");

    const denied = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n";
    const refused = make(answering(denied)).door;
    expect(await received(await client(await refused.door("s1")), denied.length)).toBe(denied);
    expect(refused.problem("s1"), "the person clicked Deny").toBe("unreachable");

    const switched = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";
    const letIn = make(answering(switched)).door;
    expect(await received(await client(await letIn.door("s1")), switched.length), "every byte, in order").toBe(switched);
    expect(letIn.problem("s1")).toBeNull();
  });

  it("drop ends the session's open connections and nothing else's", async () => {
    const target = await echo();
    const { door } = make(joining(target.port));
    const a = await client(await door.door("s1"));
    const b = await client(await door.door("s2"));
    await nextData(a);
    await nextData(b);
    door.drop("s1");
    await closed(a);
    b.write("still");
    expect((await nextData(b)).toString()).toBe("still");
  });

  it("a connection unused for the idle time is closed", async () => {
    const target = await echo();
    const { door } = make(joining(target.port), { idleMs: () => 50, sweepMs: 10 });
    const socket = await client(await door.door("s1"));
    await closed(socket);
  });

  it("guidance names the computer and what to do", () => {
    const text = lentChromeGuidance("offline", { name: "Omkar's MacBook", device: "Mac", online: false });
    expect(text).toContain("Omkar's MacBook");
    expect(text).toContain("open OpenMausBot on that Mac");
    expect(lentChromeGuidance("no-chrome", null)).toContain("chrome://inspect/#remote-debugging");
    const notLent = lentChromeGuidance("not-lent", null);
    expect(notLent, "an older desktop has no switch").toContain("updating OpenMausBot there if the switch is missing");
    expect(notLent, "or the way back to the built-in browser").toContain("switch this profile to Built-in under Settings → Browser profiles");
  });
});
