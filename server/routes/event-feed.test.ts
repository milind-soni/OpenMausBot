import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { openSse } from "../testing/sse.ts";
import { createUpgrades } from "./upgrades.ts";
import { createEventFeed, type EventWriter } from "./event-feed.ts";

it("disconnects a stalled socket without stalling a healthy event stream", async () => {
  const upgrades = createUpgrades();
  const feed = createEventFeed(upgrades, 60_000, () => true);
  const writers = new Set<EventWriter>();
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    let current: EventWriter;
    feed(req, res, { kind: "session", via: "cookie", scopes: ["client"], session: { id: "reader", tokenHash: "0".repeat(64), label: "fixture", scopes: ["client"], createdAt: 0, lastSeenAt: 0, expiresAt: Date.now() + 60_000 } }, writer => {
      current = writer;
      writers.add(writer);
      writer.send("hello", '{"kind":"hello"}');
    }, () => writers.delete(current));
  };
  const server = createServer(handle);
  upgrades.attach(server, handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const slow = new WebSocket(`${url}/api/events`, { origin: url });
  const stream = await openSse(`${url}/api/events`);
  try {
    await stream.until(f => f.kind === "hello");
    await expect.poll(() => slow.readyState).toBe(WebSocket.OPEN);
    slow.pause();
    const payload = JSON.stringify({ kind: "message", text: "x".repeat(256 * 1024) });
    for (let n = 0; n < 128 && writers.size === 2; n++) {
      for (const writer of writers) writer.send("message", payload);
      await setImmediate();
    }
    expect(writers.size).toBe(1);
    for (const writer of writers) writer.send("message", '{"kind":"message","text":"still here"}');
    await stream.until(f => f.text === "still here");
  } finally {
    slow.terminate();
    stream.close();
    for (const writer of writers) writer.close();
    upgrades.close();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});
