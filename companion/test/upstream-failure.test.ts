// A fake harness, so the failure happens on demand: after the phone's response
// has opened, when writeHead would throw ERR_HTTP_HEADERS_SENT.
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createProxyHandler } from "../src/proxy.ts";

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
  );

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

const stand = async (harness: Server): Promise<string> => {
  servers.push(harness);
  const harnessPort = await listen(harness);
  const sidecar = createServer(
    createProxyHandler({
      harnessPort,
      authenticate: () => ({ cloudDesktopAccess: true, browserControlAccess: false }),
      redeem: () => ({ error: "not in this test" }),
      serverName: () => "Ada's computer",
    }),
  );
  servers.push(sidecar);
  return `http://127.0.0.1:${await listen(sidecar)}`;
};

/** Vitest would report these only as a mysteriously dead worker. */
const watchingForCrashes = async (body: () => Promise<void>): Promise<Error[]> => {
  const escaped: Error[] = [];
  const onUncaught = (error: Error) => escaped.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    await body();
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  return escaped;
};

describe("an upstream that fails mid-stream", () => {
  it("does not take the sidecar down with it", async () => {
    let opened: ServerResponse | undefined;
    const base = await stand(
      createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write('id: a:1\ndata: {"kind":"hello"}\n\n');
        opened = res;
        // What a harness that exits while a phone is connected looks like.
        setTimeout(() => res.socket?.destroy(), 50);
      }),
    );

    const escaped = await watchingForCrashes(async () => {
      const res = await fetch(`${base}/api/events`, { headers: { authorization: "Bearer omb_x" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      try {
        for await (const _chunk of res.body as unknown as AsyncIterable<Uint8Array>) void _chunk;
      } catch {
      }
    });

    expect(opened).toBeDefined();
    expect(escaped).toEqual([]);

    const after = await fetch(`${base}/api/health`, { headers: { authorization: "Bearer omb_x" } });
    expect([200, 502]).toContain(after.status);
  }, 20_000);

  it("ends the phone's request when an image stops half way", async () => {
    const base = await stand(
      createServer((_req, res) => {
        res.writeHead(200, { "content-type": "image/png", "content-length": "100000" });
        res.write(Buffer.alloc(1000, 1));
        setTimeout(() => res.socket?.destroy(), 40);
      }),
    );

    const escaped = await watchingForCrashes(async () => {
      const res = await fetch(`${base}/api/threads/t1/messages/m1/image`, {
        headers: { authorization: "Bearer omb_x" },
      });
      expect(res.status).toBe(200);
      await expect(
        Promise.race([
          res.arrayBuffer().then(() => "finished"),
          new Promise((resolve) => setTimeout(() => resolve("hung"), 4_000)),
        ]).catch(() => "failed"),
      ).resolves.not.toBe("hung");
    });
    expect(escaped).toEqual([]);
  }, 20_000);

  it("still says 502 when the harness was never there to begin with", async () => {
    const dead = createServer(() => {});
    servers.push(dead);
    const harnessPort = await listen(dead);
    await close(dead);

    const sidecar = createServer(
      createProxyHandler({
        harnessPort,
        authenticate: () => ({ cloudDesktopAccess: true, browserControlAccess: false }),
        redeem: () => ({ error: "not in this test" }),
        serverName: () => "Ada's computer",
      }),
    );
    servers.push(sidecar);
    const base = `http://127.0.0.1:${await listen(sidecar)}`;

    const escaped = await watchingForCrashes(async () => {
      const res = await fetch(`${base}/api/health`, { headers: { authorization: "Bearer omb_x" } });
      expect(res.status).toBe(502);
      expect((await res.json()) as { error: string }).toEqual({
        error: "OpenMausBot is not running on this computer",
      });
    });
    expect(escaped).toEqual([]);
  }, 20_000);
});
