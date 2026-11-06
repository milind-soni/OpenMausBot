import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openCredentialBroker } from "./broker.ts";
import { openBoxEgressGate } from "./egress-gate.ts";
import { openHarnessGate } from "./harness-gate.ts";

const servers = [
  { name: "credential broker", open: (socketPath: string) => openCredentialBroker({ socketPath }), probeStatus: 404 },
  { name: "harness gate", open: (socketPath: string) => openHarnessGate({ socketPath, port: 9 }), probeStatus: 403 },
  { name: "egress gate", open: (socketPath: string) => openBoxEgressGate({ socketPath }), probeStatus: 400 },
];

function probe(socketPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: "/shutdown-probe", agent: false }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
      res.once("error", reject);
    });
    req.once("error", reject);
    req.end();
  });
}

describe.skipIf(process.platform === "win32").each(servers)("$name shutdown", ({ open, probeStatus }) => {
  it.each([
    { client: "idle", headers: "" },
    { client: "partial GET", headers: "GET / HTTP/1.1\r\nHost: fixture\r\n" },
    { client: "partial CONNECT", headers: "CONNECT fixture:443 HTTP/1.1\r\nHost: fixture\r\n" },
  ])("closes with a $client client still connected", async ({ headers }) => {
    const dir = mkdtempSync(join(tmpdir(), "omb-shutdown-"));
    try {
      const opened = await open(join(dir, "s.sock"));
      const client = createConnection(opened.socketPath);
      client.on("error", () => {});
      let closing: Promise<void> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await once(client, "connect");
        if (headers) await new Promise<void>((resolve, reject) => client.write(headers, (error) => error ? reject(error) : resolve()));
        expect(await probe(opened.socketPath)).toBe(probeStatus);
        const disconnected = once(client, "close");
        closing = opened.close();
        await Promise.race([
          Promise.all([closing, disconnected]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Shutdown waited for an incomplete HTTP client")), 1_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        client.destroy();
        await (closing ?? opened.close());
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
