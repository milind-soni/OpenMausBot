import { request, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createTailnetShare, hostAllowed, readTailnetShare, tailnetPeerAllowed, tailnetShareFromEnv } from "./tailnet-listener.ts";
import { freePortBlock } from "./testing/ports.ts";

const NAME = "macmini.tail1234.ts.net";

describe("a tailnet share's configuration", () => {
  it("takes a MagicDNS name with an HTTPS origin on that name, or addresses to listen on", () => {
    expect(readTailnetShare({ name: "MacMini.tail1234.ts.net.", served: "https://macmini.tail1234.ts.net" })).toEqual({ name: NAME, served: "https://macmini.tail1234.ts.net" });
    expect(readTailnetShare({ name: NAME, addresses: ["100.101.102.103", "::ffff:100.101.102.103", "fd7a:115c:a1e0::1"] }))
      .toEqual({ name: NAME, addresses: ["100.101.102.103", "fd7a:115c:a1e0::1"] });
    expect(readTailnetShare({ name: NAME })).toEqual({ name: NAME, addresses: "interface" });
  });

  it("fails closed on anything else: other names, other origins, wildcard or loopback addresses", () => {
    for (const input of [
      null, "x", { name: "macmini.example.com" }, { name: NAME, served: "https://evil.example.com" }, { name: NAME, served: "http://macmini.tail1234.ts.net" },
      { name: NAME, served: "https://macmini.tail1234.ts.net/pair" }, { name: NAME, addresses: ["0.0.0.0"] }, { name: NAME, addresses: ["::"] },
      { name: NAME, addresses: ["127.0.0.1"] }, { name: NAME, addresses: ["macmini.local"] }, { name: NAME, addresses: [] },
    ]) expect(readTailnetShare(input), JSON.stringify(input)).toBeNull();
  });

  it("reads the environment openmausbot serve --tailscale sets", () => {
    expect(tailnetShareFromEnv({})).toBeNull();
    expect(tailnetShareFromEnv({ OMB_TAILNET_NAME: NAME, OMB_TAILNET_ADDRESSES: "100.101.102.103, fd7a:115c:a1e0::1" }))
      .toEqual({ name: NAME, addresses: ["100.101.102.103", "fd7a:115c:a1e0::1"] });
    expect(tailnetShareFromEnv({ OMB_TAILNET_NAME: NAME })).toEqual({ name: NAME, addresses: "interface" });
    expect(tailnetShareFromEnv({ OMB_TAILNET_NAME: NAME, OMB_TAILNET_SERVED: `https://${NAME}` })).toEqual({ name: NAME, served: `https://${NAME}` });
  });
});

describe("who a tailnet listener answers", () => {
  it("answers Tailscale peers and this machine, never a LAN or public peer", () => {
    const bound = ["100.101.102.103"];
    expect(tailnetPeerAllowed("100.64.12.34", bound)).toBe(true);
    expect(tailnetPeerAllowed("::ffff:100.64.12.34", bound)).toBe(true);
    expect(tailnetPeerAllowed("fd7a:115c:a1e0::9", bound)).toBe(true);
    expect(tailnetPeerAllowed("100.101.102.103", bound)).toBe(true);
    for (const peer of ["192.168.1.50", "10.0.0.2", "203.0.113.9", "127.0.0.1", "fd00::1", undefined]) expect(tailnetPeerAllowed(peer, bound)).toBe(false);
  });

  it("matches the Host header exactly, ignoring case only", () => {
    const allowed = new Set([`${NAME}:8799`, "100.101.102.103:8799"]);
    expect(hostAllowed(`MacMini.tail1234.ts.net:8799`, allowed)).toBe(true);
    for (const host of [NAME, `${NAME}:8800`, `evil.${NAME}:8799`, "127.0.0.1:8799", "localhost:8799", undefined, ""]) expect(hostAllowed(host, allowed)).toBe(false);
  });
});

function ask(port: number, host: string, path = "/"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    call.on("error", reject);
    call.end();
  });
}

describe("the listeners", () => {
  let share: ReturnType<typeof createTailnetShare> | null = null;
  afterEach(async () => { await share?.close(); share = null; });

  it("waits for the main listener, then hands only requests naming the share to the server's handler", async () => {
    const port = await freePortBlock([0]);
    const attached: Server[] = [];
    share = createTailnetShare({ port: port, handle: async (_req, res) => { res.end("handled"); }, attach: (server) => attached.push(server) });
    await share.apply({ name: NAME, addresses: ["127.0.0.1"] });
    expect(share.origin()).toBeNull();
    await share.start();
    expect(attached).toHaveLength(1);
    expect(share.origin()).toBe(`http://${NAME}:${port}`);
    expect(share.state()).toEqual({ origin: `http://${NAME}:${port}`, listening: ["127.0.0.1"], error: null });
    expect(await ask(port, `${NAME}:${port}`)).toEqual({ status: 200, body: "handled" });
    expect((await ask(port, `127.0.0.1:${port}`)).status).toBe(200);
    const refused = await ask(port, `evil.example.com:${port}`);
    expect(refused.status).toBe(421);
    expect(refused.body).not.toContain("handled");

    await share.apply(null);
    expect(share.origin()).toBeNull();
    await expect(ask(port, `${NAME}:${port}`)).rejects.toThrow();
  });

  it("says why nothing listens, and links to the served HTTPS origin without binding", async () => {
    const port = await freePortBlock([0]);
    share = createTailnetShare({ port: port, handle: async () => {}, attach: () => {}, interfaces: () => ({ en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "", mac: "", cidr: null }] }) });
    await share.start();
    await share.apply({ name: NAME, addresses: "interface" });
    expect(share.state()).toEqual({ origin: null, listening: [], error: "Tailscale's interface has no address on this computer" });
    await share.apply({ name: NAME, served: `https://${NAME}` });
    expect(share.state()).toEqual({ origin: `https://${NAME}`, listening: [], error: null });
  });

  it("answers the desktop app's message with the state it applied, and ignores other messages", async () => {
    const port = await freePortBlock([0]);
    share = createTailnetShare({ port: port, handle: async () => {}, attach: () => {} });
    await share.start();
    const answers: object[] = [];
    expect(share.receive({ type: "openmausbot:other" }, (answer) => answers.push(answer))).toBe(false);
    const replied = new Promise<object>((resolve) => share!.receive({ type: "openmausbot:tailnet-share", share: { name: NAME, served: `https://${NAME}` } }, resolve));
    expect(await replied).toEqual({ type: "openmausbot:tailnet-share-state", origin: `https://${NAME}`, listening: [], error: null });
    expect(answers).toEqual([]);
  });
});
