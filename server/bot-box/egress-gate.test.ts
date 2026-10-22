import { createServer, request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BOX_EGRESS_RULES, boxRefusal, openBoxEgressGate, type BoxEgressGate } from "./egress-gate.ts";

const PUBLIC = { address: "203.0.113.7", family: 4 };

function connectVia(socketPath: string, target: string): Promise<{ status: string; blocked: string | null }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath, () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      if (!buffer.includes("\r\n\r\n")) return;
      socket.destroy();
      resolve({ status: /^HTTP\/1\.1 (\d{3})/.exec(buffer)?.[1] ?? "malformed", blocked: /X-Omb-Blocked: (\S+)/.exec(buffer)?.[1] ?? null });
    });
    socket.once("error", reject);
  });
}

function getVia(socketPath: string, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: url, method: "GET", headers: { host: new URL(url).host } }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

// The box runs only on a Linux Cloud home (detect.ts says "not-linux" anywhere else): its egress gate listens on a
// unix socket, which Windows refuses at a file path (EACCES).
const linuxBox = describe.skipIf(process.platform === "win32");

linuxBox("the box's egress gate", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

  async function gate(options: Partial<Parameters<typeof openBoxEgressGate>[0]> = {}): Promise<BoxEgressGate> {
    const dir = mkdtempSync(join(tmpdir(), "omb-egress-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const opened = await openBoxEgressGate({ socketPath: join(dir, "e.sock"), ...options });
    cleanup.push(() => opened.close());
    return opened;
  }

  it("refuses this machine, the local network, link-local, the metadata service and reserved addresses by their resolved addresses", async () => {
    const refused: string[] = [];
    const opened = await gate({ resolve: async (host) => [{ address: host, family: 4 }], onRefusal: (_target, reason) => refused.push(reason) });
    expect(await connectVia(opened.socketPath, "127.0.0.1:8799")).toEqual({ status: "403", blocked: "omb" });
    expect(await connectVia(opened.socketPath, "10.0.0.5:443")).toEqual({ status: "403", blocked: "local-network" });
    expect(await connectVia(opened.socketPath, "192.168.1.1:80")).toEqual({ status: "403", blocked: "local-network" });
    expect(await connectVia(opened.socketPath, "169.254.169.254:80")).toEqual({ status: "403", blocked: "metadata" });
    expect(await connectVia(opened.socketPath, "0.0.0.0:80")).toEqual({ status: "403", blocked: "reserved" });
    expect(refused).toEqual(["omb", "local-network", "local-network", "metadata", "reserved"]);
    expect(opened.refused).toBe(5);
  });

  it("a public name that resolves to a private address is refused too (rebinding), and a name that resolves nowhere is 502", async () => {
    const opened = await gate({ resolve: async (host) => host === "evil.example" ? [PUBLIC, { address: "127.0.0.1", family: 4 }] : [] });
    expect((await connectVia(opened.socketPath, "evil.example:443")).status).toBe("403");
    expect((await connectVia(opened.socketPath, "nowhere.example:443")).status).toBe("502");
  });

  it("lets a public destination through, and only to the address it checked", async () => {
    // A loopback listener stands in for the public host: the resolver says it is public, and the gate connects to the checked address.
    const upstream = createServer((req, res) => res.end(`served ${req.url}`));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const port = (upstream.address() as { port: number }).port;
    const opened = await gate({ resolve: async () => [{ address: "127.0.0.1", family: 4 }], decide: async () => null });
    expect((await connectVia(opened.socketPath, `example.com:${port}`)).status).toBe("200");
    expect(await getVia(opened.socketPath, `http://example.com:${port}/page`)).toEqual({ status: 200, body: "served /page" });
    expect(opened.refused).toBe(0);
  });

  it("with the real policy a public address passes the decision and a loopback one does not", async () => {
    expect(await boxRefusal({ host: "example.com", port: 443 }, [PUBLIC])).toBeNull();
    expect(await boxRefusal({ host: "localhost", port: 8799 }, [{ address: "127.0.0.1", family: 4 }])).toBe("omb");
    expect(await boxRefusal({ host: "x", port: 443 }, [{ address: "fd12::1", family: 6 }])).toBe("local-network");
    expect(BOX_EGRESS_RULES.host).toBe("cloud");
    expect(await BOX_EGRESS_RULES.botPort(3000)).toBe(false);
    expect(BOX_EGRESS_RULES.allowed("10.0.0.1", 443)).toBe(false);
  });

  it("refuses a CONNECT it cannot parse and a non-absolute request", async () => {
    const opened = await gate();
    expect((await connectVia(opened.socketPath, "no-port")).status).toBe("400");
    const answer = await new Promise<number>((resolve, reject) => {
      const req = request({ socketPath: opened.socketPath, path: "/relative", method: "GET" }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end();
    });
    expect(answer).toBe(400);
  });
});
