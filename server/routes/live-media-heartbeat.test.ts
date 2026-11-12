import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { expect, it, vi } from "vitest";
import { createUpgrades } from "./upgrades.ts";
import { createLiveMediaRoutes } from "./live-media.ts";
import { dispatchRoutes } from "./table.ts";
import { json, readBody } from "../harness/http.ts";

it("keeps an idle PCM connection alive, closes an unresponsive peer, and logs no peer-supplied reason", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const upgrades = createUpgrades();
  const lines: string[] = [];
  const calls = {
    bindMedia: vi.fn(() => true), inputMedia: vi.fn(() => true),
    playbackCredit: vi.fn(() => true), clientFailure: vi.fn(() => true),
    mediaDisconnected: vi.fn(), end: vi.fn(async () => null),
  };
  const media = createLiveMediaRoutes({ upgrades, calls, log: (line) => lines.push(line) });
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await dispatchRoutes([media], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody });
  };
  const server = createServer(handle);
  upgrades.attach(server, handle);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/live/media`;
  const sockets: WebSocket[] = [];
  const open = async (autoPong: boolean) => {
    const socket = new WebSocket(url, { autoPong }); sockets.push(socket);
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "bind", callId: "fixture-call" }));
    await new Promise((done) => setTimeout(done, 20));
    return socket;
  };
  try {
    const healthy = await open(true);
    for (let i = 0; i < 3; i++) {
      const ping = once(healthy, "ping");
      await vi.advanceTimersByTimeAsync(25_000);
      await ping;
      await new Promise((done) => setTimeout(done, 20));
      expect(healthy.readyState).toBe(WebSocket.OPEN);
    }
    const closedHealthy = once(healthy, "close");
    healthy.close(1000, "private-peer-text-must-never-be-logged");
    await closedHealthy;
    const unresponsive = await open(false);
    const ping = once(unresponsive, "ping");
    await vi.advanceTimersByTimeAsync(25_000);
    await ping;
    const closed = once(unresponsive, "close");
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await closed)[0]).toBe(1006);
    expect(lines.some((line) => /code=1000 bound=yes ms=\d+/.test(line))).toBe(true);
    expect(lines.join("\n")).not.toContain("private-peer-text");
    expect(calls.mediaDisconnected).toHaveBeenCalledWith("fixture-call");
  } finally {
    for (const socket of sockets) socket.terminate();
    media.close(); upgrades.close();
    await new Promise<void>((done) => server.close(() => done()));
    vi.useRealTimers();
  }
});
