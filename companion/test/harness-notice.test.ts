// The companion's notice to the harness that it unpaired a phone. It travels
// the relay's own authenticated path: loopback, the companion's marker, the
// device id, and the private relay token when the desktop app holds one.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { notifyDeviceRevoked } from "../src/harness-notice.ts";

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** A stand-in harness that answers `status` and records what reached it. */
async function harness(status = 200): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ call: null }));
    });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { port: (server.address() as AddressInfo).port, seen };
}

const TOKEN = "a".repeat(43);

describe("notifyDeviceRevoked", () => {
  it("names the unpaired phone to the harness the way the relay speaks to it", async () => {
    const { port, seen } = await harness();
    await expect(notifyDeviceRevoked({ harnessPort: port, deviceId: "phone-1", mutationToken: TOKEN })).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/live/device-revoked", body: "" });
    expect(seen[0].headers).toMatchObject({
      "x-openmausbot-companion": "1",
      "x-openmausbot-companion-device": "phone-1",
      "x-openmausbot-companion-auth": TOKEN,
    });
    // the phone's bearer means nothing to the harness and never travels
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers.origin).toBeUndefined();
  });

  it("sends no relay token to a standalone harness", async () => {
    const { port, seen } = await harness();
    await expect(notifyDeviceRevoked({ harnessPort: port, deviceId: "phone-1" })).resolves.toBe(true);
    expect(seen[0].headers["x-openmausbot-companion-device"]).toBe("phone-1");
    expect(seen[0].headers["x-openmausbot-companion-auth"]).toBeUndefined();
  });

  it("reports a refusal, and never names a malformed device", async () => {
    const refusing = await harness(403);
    await expect(notifyDeviceRevoked({ harnessPort: refusing.port, deviceId: "phone-1", mutationToken: TOKEN })).resolves.toBe(false);
    const { port, seen } = await harness();
    await expect(notifyDeviceRevoked({ harnessPort: port, deviceId: "../phone" })).resolves.toBe(false);
    expect(seen).toEqual([]);
  });

  it("gives up quietly when the harness is not running", async () => {
    const { port } = await harness();
    await new Promise((done) => servers.pop()!.close(done));
    await expect(notifyDeviceRevoked({ harnessPort: port, deviceId: "phone-1" })).resolves.toBe(false);
  });
});
