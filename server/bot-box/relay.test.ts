import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { connect, createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dialRelay, openBoxRelay, type BoxRelay } from "./relay.ts";

// The box runs only on a Linux Cloud home; the relay is a unix socket at a POSIX path, which Windows does not have.
const linuxBox = describe.skipIf(process.platform === "win32");

linuxBox("the relay into a box's own loopback", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => { for (const step of cleanup.splice(0).reverse()) step(); });

  const relayAt = async (): Promise<BoxRelay> => {
    const dir = mkdtempSync(join(tmpdir(), "omb-relay-"));
    const relay = await openBoxRelay(join(dir, "relay.sock"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }), () => relay.close());
    return relay;
  };
  const listener = async (): Promise<{ server: Server; port: number; seen: string[] }> => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("signed in");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => server.close());
    return { server, port: (server.address() as { port: number }).port, seen };
  };
  const get = (relay: BoxRelay, port: number, path: string) => relay.connect(port).then((socket) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, createConnection: () => socket }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk) => { body += chunk; }).on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  }));

  it("carries a request the host sends to the loopback port it names, through the connection the box dialed", async () => {
    const relay = await relayAt();
    const { port, seen } = await listener();
    const box = dialRelay(relay.socketPath, 20);
    cleanup.push(() => box.close());
    expect(await get(relay, port, "/?state=s&code=c")).toEqual({ status: 200, body: "signed in" });
    expect(seen).toEqual(["/?state=s&code=c"]);
    // The box dialed again at once, so a second delivery needs no wait.
    expect(await get(relay, port, "/again")).toEqual({ status: 200, body: "signed in" });
    expect(seen).toEqual(["/?state=s&code=c", "/again"]);
  });

  it("waits for the box to dial in, and says so when it never does", async () => {
    const relay = await relayAt();
    const { port, seen } = await listener();
    const late = get(relay, port, "/late");
    setTimeout(() => { const box = dialRelay(relay.socketPath, 20); cleanup.push(() => box.close()); }, 50);
    expect(await late).toEqual({ status: 200, body: "signed in" });
    expect(seen).toEqual(["/late"]);

    const silent = await relayAt();
    await expect(silent.connect(port, 50)).rejects.toThrow(/did not answer/);
  });

  it("closing settles every pending connection and clears its deadline", async () => {
    const relay = await relayAt();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const errors: Error[] = [];
    try {
      for (const port of [1234, 5678]) void relay.connect(port).catch((error: Error) => { errors.push(error); });
      expect(vi.getTimerCount()).toBe(2);
      relay.close();
      relay.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(errors.map((error) => error.message)).toEqual([
        "The sign-in's box relay is closed.",
        "The sign-in's box relay is closed.",
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it("refuses a connection after close without starting another deadline", async () => {
    const relay = await relayAt();
    relay.close();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const errors: Error[] = [];
    try {
      void relay.connect(1234).catch((error: Error) => { errors.push(error); });
      await vi.advanceTimersByTimeAsync(0);
      expect(errors.map((error) => error.message)).toEqual(["The sign-in's box relay is closed."]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });

  it("the box side drops a connection whose first line is not a port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-relay-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const host = createNetServer();
    const dialed: Socket[] = [];
    host.on("connection", (socket) => dialed.push(socket));
    await new Promise<void>((resolve) => host.listen(join(dir, "relay.sock"), resolve));
    cleanup.push(() => host.close());
    const box = dialRelay(join(dir, "relay.sock"), 20);
    cleanup.push(() => box.close());
    const next = async () => {
      while (!dialed.length) await new Promise((resolve) => setTimeout(resolve, 5));
      return dialed.shift()!;
    };
    for (const line of ["70000\n", "0\n", "abc\n", "1234567"]) {
      const socket = await next();
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.write(line);
      await closed;
    }
    const relay = await relayAt();
    await expect(relay.connect(0)).rejects.toThrow(/Not a port/);
  });

  it("keeps only a few connections waiting from the box", async () => {
    const relay = await relayAt();
    const sockets = Array.from({ length: 8 }, () => connect(relay.socketPath));
    cleanup.push(() => { for (const socket of sockets) socket.destroy(); });
    const closed = await Promise.all(sockets.map((socket) => new Promise<boolean>((resolve) => {
      socket.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 300);
    })));
    expect(closed.filter(Boolean)).toHaveLength(4);
  });
});
