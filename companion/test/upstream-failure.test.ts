// What happens to the sidecar when the harness dies underneath it.
//
// Not covered by proxy.test.ts, which boots a healthy harness and keeps it
// that way: the interesting case is the one where the harness goes away
// *after* the response to the phone has already been opened. There is no way
// to answer 502 at that point — the status line is long gone — and trying to
// is not merely futile, it throws ERR_HTTP_HEADERS_SENT out of an error
// handler where nothing is waiting to catch it. One phone whose stream broke
// then takes down every other paired device with it.
//
// A fake harness rather than the real one, because the failure has to happen
// on demand and at a chosen moment.
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

/** A sidecar in front of `harness`, both listening. */
const stand = async (harness: Server): Promise<string> => {
  servers.push(harness);
  const harnessPort = await listen(harness);
  const sidecar = createServer(
    createProxyHandler({
      harnessPort,
      authenticate: () => ({ cloudDesktopAccess: true }),
      redeem: () => ({ error: "not in this test" }),
      serverName: () => "Ada's computer",
    }),
  );
  servers.push(sidecar);
  return `http://127.0.0.1:${await listen(sidecar)}`;
};

/** Collect anything that escapes to the top level while `body` runs. Vitest
 * would report these anyway, but only as a mysteriously dead worker — naming
 * them here is what makes a regression readable. */
const watchingForCrashes = async (body: () => Promise<void>): Promise<Error[]> => {
  const escaped: Error[] = [];
  const onUncaught = (error: Error) => escaped.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    await body();
    // give the error handlers a tick to run after the response ends
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
        // rip the socket out from under the proxy, which is what a harness
        // that exits while a phone is connected looks like from here
        setTimeout(() => res.socket?.destroy(), 50);
      }),
    );

    const escaped = await watchingForCrashes(async () => {
      const res = await fetch(`${base}/api/events`, { headers: { authorization: "Bearer omb_x" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      try {
        // read until the stream dies — the point is that it dies here and
        // not in the sidecar's process
        for await (const _chunk of res.body as unknown as AsyncIterable<Uint8Array>) void _chunk;
      } catch {
        /* a destroyed connection is exactly what this is provoking */
      }
    });

    expect(opened).toBeDefined();
    expect(escaped).toEqual([]);

    // and the sidecar is still answering, which is the whole claim
    const after = await fetch(`${base}/api/health`, { headers: { authorization: "Bearer omb_x" } });
    expect([200, 502]).toContain(after.status);
  }, 20_000);

  // The branch that carries images through byte-for-byte. `pipe` does not
  // carry a source failure to the destination, so an interrupted upstream
  // used to leave the phone holding a connection with a content-length that
  // would never be satisfied — waiting for the rest of a picture forever,
  // which reads as a frozen app rather than as a request that failed.
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
      // the assertion is that this settles at all, either way — the bug was
      // that it never did
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
    // The other half of the same handler: nothing has been written yet, so
    // there is a status line to spend, and a phone deserves the real reason.
    const dead = createServer(() => {});
    servers.push(dead);
    const harnessPort = await listen(dead);
    await close(dead);

    const sidecar = createServer(
      createProxyHandler({
        harnessPort,
        authenticate: () => ({ cloudDesktopAccess: true }),
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
