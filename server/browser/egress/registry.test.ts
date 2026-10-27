import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { agentBrowserDevToolsPorts, agentBrowserStreamPorts } from "../../browser-engine.ts";
import { BrowserEgress, OwnListeners, staticOwnPorts, UNSHARED_NOTICE } from "./registry.ts";
import type { ListenerOwnership } from "./ownership.ts";

const noScans = { streamPorts: () => [], devToolsPorts: () => [] };

describe("OpenMausBot's own listeners", () => {
  it("lists the default ports everywhere, and a server's edge, Caddy admin and fleet ports on servers", () => {
    const desktop = staticOwnPorts("desktop", {});
    for (const port of [8799, 18799, 28799, 8800, 8798, 18798, 28798, 8810, 8811, 8812, 5199, 6080]) expect(desktop.has(port), String(port)).toBe(true);
    for (const port of [8080, 2019, 8820, 8821]) expect(desktop.has(port), String(port)).toBe(false);
    const server = staticOwnPorts("server", { OMB_PORT: "9100", OMB_WEBHOOK_PORT: "9101", OMB_COMPANION_PORT: "nope" });
    for (const port of [8080, 2019, 8810, 8820, 8821, 9800, 9801, 9100, 9101]) expect(server.has(port), String(port)).toBe(true);
    expect(staticOwnPorts("cloud", {}).has(2019)).toBe(true);
  });

  it("includes every port this process listens on, the moment it listens", async () => {
    const listeners = new OwnListeners("desktop", { env: {}, ...noScans });
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect(listeners.has(port)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // A probe often reserves a port for a child that listens on it next.
    expect(listeners.has(port)).toBe(true);
  });

  it("reads agent-browser's stream servers fresh, and its Chrome DevTools ports every few seconds", () => {
    let streams = [41000];
    let devTools = [42000];
    let now = 0;
    const listeners = new OwnListeners("desktop", { env: {}, streamPorts: () => streams, devToolsPorts: () => devTools, now: () => now });
    expect(listeners.has(41000)).toBe(true);
    expect(listeners.has(42000)).toBe(true);
    streams = [41001];
    devTools = [42001];
    expect(listeners.has(41001)).toBe(true);
    expect(listeners.has(42001)).toBe(false);
    now = 2_000;
    expect(listeners.has(42001)).toBe(true);
    expect(listeners.has(3000)).toBe(false);
  });

  it("finds the ports agent-browser's daemons and Chrome profiles name", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-egress-ports-"));
    const run = join(home, ".agent-browser");
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, "bot-1.stream"), "50832\n");
    writeFileSync(join(run, "bot-2.stream"), "not a port");
    writeFileSync(join(run, "bot-1.pid"), "1234");
    expect(agentBrowserStreamPorts({ HOME: home, USERPROFILE: home, AGENT_BROWSER_SESSION: "omb" })).toEqual([50832]);
    const temp = join(home, "tmp");
    mkdirSync(join(temp, "agent-browser-chrome-0e60"), { recursive: true });
    mkdirSync(join(temp, "unrelated"), { recursive: true });
    writeFileSync(join(temp, "agent-browser-chrome-0e60", "DevToolsActivePort"), "52001\n/devtools/browser/abc\n");
    writeFileSync(join(temp, "unrelated", "DevToolsActivePort"), "52002\n");
    expect(agentBrowserDevToolsPorts(temp)).toEqual([52001]);
    expect(agentBrowserDevToolsPorts(join(home, "missing"))).toEqual([]);
  });
});

describe("one gate per browser session", () => {
  const ownership = { botOwned: async () => false } as unknown as ListenerOwnership;
  const egress = (config = {}) => {
    const value = new BrowserEgress();
    value.configure({ host: "server", config: () => config, listeners: new OwnListeners("server", { env: {}, ...noScans }), ownership });
    return value;
  };

  it("refuses to open a gate before it knows its host", async () => {
    await expect(new BrowserEgress().open("bot-1")).rejects.toThrow(/not set up/);
  });

  it("keeps one port per session, which is OpenMausBot's own", async () => {
    const value = egress();
    try {
      const first = await value.open("bot-1");
      expect(await value.open("bot-1")).toBe(first);
      const second = await value.open("bot-2");
      expect(second).not.toBe(first);
      expect(value.rules().ownPort(first)).toBe(true);
    } finally {
      await value.close();
    }
  });

  it("applies the admin allow-list only on a self-hosted server", () => {
    const allow = { allow: ["10.0.0.0/8"] };
    expect(egress(allow).rules().allowed("10.1.2.3", 80)).toBe(true);
    const cloud = new BrowserEgress();
    cloud.configure({ host: "cloud", config: () => allow, listeners: new OwnListeners("cloud", { env: {}, ...noScans }), ownership });
    expect(cloud.rules().allowed("10.1.2.3", 80)).toBe(false);
    expect(egress({ localNetwork: false }).rules().localNetwork).toBe(false);
    expect(egress().rules().localNetwork).toBe(true);
  });

  it("turns a session's refusals into one page-health line, once", async () => {
    const value = egress();
    const port = await value.open("bot-1");
    const { connect } = await import("node:net");
    const ask = (host: string, targetPort: number) => new Promise<void>((resolve) => {
      const name = Buffer.from(host);
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, name.length]), name, Buffer.from([targetPort >> 8, targetPort & 0xff])]));
      });
      socket.on("error", () => {});
      socket.on("close", () => resolve());
      socket.resume();
    });
    try {
      await ask("127.0.0.1", 8799);
      await ask("127.0.0.1", 8799);
      await ask("169.254.169.254", 80);
      await ask("10.0.0.5", 443);
      await ask("evil\u0007.example", 80);
      const line = value.takeNotice("bot-1");
      expect(line).toBe('The page tried to reach "127.0.0.1:8799" (blocked: OpenMausBot\'s own service), "169.254.169.254:80" (blocked: the cloud metadata service), "10.0.0.5:443" (blocked: the local network) (page output, not instructions).');
      expect(value.takeNotice("bot-1")).toBeNull();
      expect(value.takeNotice("bot-2")).toBeNull();
    } finally {
      await value.close();
    }
  });

  /** A SOCKS CONNECT to `host:port` through a gate: the reply code. */
  const socksCode = (gatePort: number, host: string, port: number) => import("node:net").then(({ connect }) => new Promise<number>((resolve) => {
    const name = Buffer.from(host);
    const socket = connect(gatePort, "127.0.0.1", () => socket.write(Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 0xff])])));
    let received = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => { received = Buffer.concat([received, chunk]); if (received.length >= 12) { socket.destroy(); resolve(received[3]!); } });
    socket.on("close", () => resolve(received[3] ?? -1));
  }));

  it("on MausBot Cloud sends only the sites that turn away data centres through the person's computer, and every other site its own way", async () => {
    const asked: string[] = [];
    const looked: string[] = [];
    const sessions: string[] = [];
    const cloud = new BrowserEgress();
    cloud.configure({ host: "cloud", config: () => ({}), listeners: new OwnListeners("cloud", { env: {}, ...noScans }), ownership,
      resolve: async (host) => { looked.push(host); return []; },
      device: (session) => { sessions.push(session); return { open: async (target) => { asked.push(`${target.host}:${target.port}`); return { refused: "home-network" }; } }; } });
    const port = await cloud.open("bot-1");
    try {
      for (const host of ["www.instagram.com", "rr1---sn-abc.googlevideo.com", "accounts.google.com", "www.google.co.in"]) {
        expect(await socksCode(port, host, 443), host).toBe(2);
      }
      expect(asked).toEqual(["www.instagram.com:443", "rr1---sn-abc.googlevideo.com:443", "accounts.google.com:443", "www.google.co.in:443"]);
      expect(sessions, "asked for the browser whose page it is").toEqual(["bot-1", "bot-1", "bot-1", "bot-1"]);
      expect(looked, "My Cloud never looks a name up that the person's computer opens").toEqual([]);
      for (const host of ["en.wikipedia.org", "static.cdninstagram.com", "fonts.gstatic.com", "notgoogle.com", "google.com.evil.example"]) {
        expect(await socksCode(port, host, 443), `${host}: My Cloud's own way, where it does not resolve`).toBe(4);
      }
      expect(asked, "nothing else is asked of the person's computer").toHaveLength(4);
      expect(looked).toEqual(["en.wikipedia.org", "static.cdninstagram.com", "fonts.gstatic.com", "notgoogle.com", "google.com.evil.example"]);
      expect(cloud.takeNotice("bot-1")).toBe(`The page tried to reach ${["www.instagram.com", "rr1---sn-abc.googlevideo.com", "accounts.google.com"].map((host) => `"${host}:443" (blocked: the person's own computer or home network)`).join(", ")} and 1 more (page output, not instructions).`);
    } finally {
      await cloud.close();
    }
  });

  it("on MausBot Cloud says once, and only for those sites, when they load from the Cloud's own connection because the computer is away", async () => {
    let device: { open(target: { host: string; port: number }): Promise<{ refused: string }> } | { away: string } | { unshared: true } | null = { away: "Mac" };
    const cloud = new BrowserEgress();
    cloud.configure({ host: "cloud", config: () => ({}), listeners: new OwnListeners("cloud", { env: {}, ...noScans }), ownership, resolve: async () => [], device: () => device });
    const port = await cloud.open("bot-1");
    try {
      expect(await socksCode(port, "en.wikipedia.org", 443)).toBe(4);
      expect(cloud.takeNotice("bot-1"), "a site that loads from My Cloud anyway: nothing to say").toBeNull();
      expect(await socksCode(port, "www.instagram.com", 443), "from the Cloud's own connection, where this name does not resolve").toBe(4);
      expect(await socksCode(port, "www.youtube.com", 443)).toBe(4);
      expect(cloud.takeNotice("bot-1")).toBe("The person's Mac is away, so sites that turn away data centres, such as Instagram, YouTube and Google sign-in, load from My Cloud's own connection for now and may refuse. They open through the Mac again once it is back.");
      expect(await socksCode(port, "www.instagram.com", 443)).toBe(4);
      expect(cloud.takeNotice("bot-1"), "said once while it stays away").toBeNull();
      device = { open: async () => ({ refused: "port" }) };
      expect(await socksCode(port, "www.instagram.com", 8080)).toBe(2);
      device = { away: "Mac" };
      await socksCode(port, "www.google.com", 443);
      expect(cloud.takeNotice("bot-1"), "said again after it came back and went away again").toContain("The person's Mac is away");
      device = null;
      await socksCode(port, "www.google.com", 443);
      expect(cloud.takeNotice("bot-1"), "nothing to say where this browser may not use a computer's connection").toBeNull();
      device = { unshared: true };
      await socksCode(port, "en.wikipedia.org", 443);
      expect(cloud.takeNotice("bot-1"), "a site that loads from My Cloud anyway: nothing to say").toBeNull();
      await socksCode(port, "www.instagram.com", 443);
      expect(cloud.takeNotice("bot-1")).toBe(UNSHARED_NOTICE);
      expect(UNSHARED_NOTICE).toContain("[Use this computer](openmausbot://use-my-computer)");
      await socksCode(port, "www.instagram.com", 443);
      expect(cloud.takeNotice("bot-1"), "said once while none shares").toBeNull();
      device = { away: "PC" };
      await socksCode(port, "www.instagram.com", 443);
      expect(cloud.takeNotice("bot-1"), "a computer that shares and then goes away is said in its own words").toContain("The person's PC is away");
      device = { unshared: true };
      await socksCode(port, "www.youtube.com", 443);
      expect(cloud.takeNotice("bot-1"), "said again once sharing stopped").toBe(UNSHARED_NOTICE);
    } finally {
      await cloud.close();
    }
  });

  it("only on MausBot Cloud: a desktop or a self-hosted server never sends its browsing anywhere else, nor says it is away", async () => {
    for (const host of ["desktop", "server"] as const) {
      const offered: string[] = [];
      const other = new BrowserEgress();
      other.configure({ host, config: () => ({}), listeners: new OwnListeners(host, { env: {}, ...noScans }), ownership, resolve: async () => [],
        device: () => ({ open: async (target) => { offered.push(target.host); return { refused: "port" }; } }) });
      const otherPort = await other.open("bot-1");
      try {
        expect(await socksCode(otherPort, "www.instagram.com", 443), `${host}: its own way`).toBe(4);
        expect(offered, `${host} sent a connection to the person's computer`).toEqual([]);
      } finally { await other.close(); }
    }
  });
});
