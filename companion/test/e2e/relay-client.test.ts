import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { b64u, ed25519RawPublicKey, mintRelayToken } from "../../src/e2e/credentials.ts";
import { RelayClient, type RelayClientOptions } from "../../src/e2e/relay-client.ts";
import { startFakeRelay, type FakeRelay } from "./fake-relay.ts";

const signingKey = generateKeyPairSync("ed25519").privateKey;
const keys = new Map([["k1", ed25519RawPublicKey(signingKey)]]);
const hid = b64u(randomBytes(16));
const token = (exp = 3600, kid = "k1") => {
  const iat = Math.floor(Date.now() / 1000);
  return mintRelayToken({ v: 1, kid, hid, iid: "install", iat, exp: iat + exp }, signingKey);
};

const waitFor = async (check: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function relayAt(port?: number): Promise<FakeRelay> {
  const relay = await startFakeRelay({ keys, port });
  cleanup.push(() => relay.close());
  return relay;
}

/** A relay that answers each control socket's auth with `script`: how many sockets it saw is the dial count. */
async function scriptedRelay(script: (socket: WebSocket) => void): Promise<{ url: string; dials: () => number }> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1", handleProtocols: () => "omb-relay.v1" });
  await new Promise((resolve) => server.once("listening", resolve));
  let dials = 0;
  server.on("connection", (socket) => {
    dials += 1;
    socket.once("message", () => script(socket));
  });
  cleanup.push(() => new Promise((resolve) => {
    for (const socket of server.clients) socket.terminate();
    server.close(resolve);
  }));
  const { port } = server.address() as { port: number };
  return { url: `ws://127.0.0.1:${port}`, dials: () => dials };
}

/** For waits on something that must happen: a runner several times slower than a laptop only stretches them. */
const SLOW = 15_000;
const hello = JSON.stringify({ t: "hello", v: 1, node: "relay1", sessionsMax: 16 });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function client(relays: Record<string, Pick<FakeRelay, "url">>, overrides: Partial<RelayClientOptions> = {}) {
  const statuses: string[] = [];
  const rejected: number[] = [];
  const instance = new RelayClient({
    nodes: Object.keys(relays),
    token: token(),
    admissionSet: () => ["a", "b"],
    accept: () => null,
    tokenRejected: () => rejected.push(Date.now()),
    statusChanged: (status, node) => statuses.push(`${status}${node ? `@${node}` : ""}`),
    baseUrl: (node) => relays[node].url,
    random: () => 0.5,
    ...overrides,
  });
  cleanup.push(() => instance.stop());
  return { instance, statuses, rejected };
}

describe("the relay client", () => {
  it("authenticates, then sends the admission set, and again only when it changes", async () => {
    const relay = await relayAt();
    let set = ["a", "b"];
    const { instance } = client({ "relay1.openmausbot.com": relay }, { admissionSet: () => set });
    instance.start();
    await waitFor(() => instance.status === "connected");
    await waitFor(() => relay.admitted(hid).size === 2);
    set = ["a", "b", "c"];
    instance.refreshAdmission();
    await waitFor(() => relay.admitted(hid).has("c"));
    expect(instance.node).toBe("relay1.openmausbot.com");
  });

  it("refreshes the token on the same socket", async () => {
    const relay = await relayAt();
    const { instance } = client({ "relay1.openmausbot.com": relay });
    instance.start();
    await waitFor(() => instance.status === "connected");
    const socket = relay.hosts.get(hid)!.control;
    instance.setToken(token(7200));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(relay.refreshes).toBe(1);
    expect(relay.hosts.get(hid)?.control).toBe(socket);
    expect(relay.closes).toEqual([]);
  });

  it("asks for a new token on 4401 and reconnects once it has one", async () => {
    const relay = await relayAt();
    const { instance, rejected } = client({ "relay1.openmausbot.com": relay }, { token: token(3600, "k9") });
    instance.start();
    await waitFor(() => rejected.length === 1);
    expect(instance.status).toBe("connecting");
    instance.setToken(token());
    await waitFor(() => instance.status === "connected");
  });

  it("stops when a newer control socket for the same computer takes over (4409)", async () => {
    const relay = await relayAt();
    const first = client({ "relay1.openmausbot.com": relay });
    first.instance.start();
    await waitFor(() => first.instance.status === "connected");
    const second = client({ "relay1.openmausbot.com": relay });
    second.instance.start();
    await waitFor(() => second.instance.status === "connected");
    await waitFor(() => first.instance.status === "off");
  });

  it("reconnects after the relay announces a restart", async () => {
    const relay = await relayAt();
    const { instance, statuses } = client({ "relay1.openmausbot.com": relay });
    instance.start();
    await waitFor(() => instance.status === "connected");
    relay.restart();
    await waitFor(() => instance.problem === "busy", SLOW);
    expect(instance.status).toBe("connecting");
    await waitFor(() => statuses.filter((status) => status.startsWith("connected")).length === 2, SLOW);
    expect(statuses.map((status) => status.split("@")[0])).toEqual(["connecting", "connected", "connecting", "connected"]);
  });

  it("fails over to the next node, then moves back to the first when it returns", async () => {
    const second = await relayAt();
    const firstPort = (await relayAt()).port;
    await cleanup.pop()!();
    const nodes: Record<string, FakeRelay> = {
      "relay1.openmausbot.com": { url: `ws://127.0.0.1:${firstPort}` } as FakeRelay,
      "relay2.openmausbot.com": second,
    };
    const { instance } = client(nodes, { timing: { firstNodeRetryMs: 300 } });
    instance.start();
    await waitFor(() => instance.node === "relay2.openmausbot.com", 5_000);
    const first = await relayAt(firstPort);
    await waitFor(() => instance.node === "relay1.openmausbot.com", 5_000);
    await waitFor(() => first.admitted(hid).size === 2);
    await waitFor(() => !second.hosts.has(hid));
  });

  it("redials at once when the wall clock jumps past the monotonic one (sleep)", async () => {
    const relay = await relayAt();
    const { instance, statuses } = client({ "relay1.openmausbot.com": relay }, { timing: { sleepCheckMs: 50 } });
    instance.start();
    await waitFor(() => instance.status === "connected");
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 60_000);
    await waitFor(() => statuses.filter((status) => status.startsWith("connected")).length === 2);
  });

  it("opens a data socket for each phone and hands it to the session", async () => {
    const relay = await relayAt();
    const accepted: number[] = [];
    const adm = Buffer.from("admission value");
    const { instance } = client({ "relay1.openmausbot.com": relay }, {
      admissionSet: () => [b64u(createHash("sha256").update(adm).digest())],
      accept: (transport) => {
        accepted.push(Date.now());
        return { receive: (data) => transport.send(data), transportClosed: () => {} };
      },
    });
    instance.start();
    await waitFor(() => relay.admitted(hid).size === 1);
    const phone = new WebSocket(`${relay.url}/v1/phone`, ["omb-relay.v1"]);
    await new Promise((resolve) => phone.once("open", resolve));
    phone.send(JSON.stringify({ t: "phone", v: 1, hid, adm: b64u(adm) }));
    const ready = await new Promise<string>((resolve) => phone.once("message", (data) => resolve(String(data))));
    expect(JSON.parse(ready)).toEqual({ t: "ready" });
    phone.send(Buffer.from("sealed bytes"));
    const echoed = await new Promise<Buffer>((resolve) => phone.once("message", (data) => resolve(data as Buffer)));
    expect(echoed.toString()).toBe("sealed bytes");
    expect(accepted).toHaveLength(1);
    phone.close();
  });

  it("does not redial in a loop a relay that accepts and drops the socket at once", async () => {
    const relay = await scriptedRelay((socket) => {
      socket.send(hello);
      socket.close(1011);
    });
    // Immediate, then a minute: a count that reset on every hello would redial at once, over and over.
    const { instance } = client({ "relay1.openmausbot.com": relay }, { timing: { backoffMs: [0, 60_000] } });
    instance.start();
    await waitFor(() => relay.dials() === 2, SLOW);
    await waitFor(() => instance.problem === "unreachable", SLOW);
    await pause(500);
    expect(relay.dials()).toBe(2);
  });

  it("resets the backoff once a socket has stayed connected long enough", async () => {
    const relay = await scriptedRelay((socket) => {
      socket.send(hello);
      setTimeout(() => socket.close(1011), 1_000);
    });
    // Without the reset, the second drop would wait a minute.
    const { instance } = client({ "relay1.openmausbot.com": relay }, { timing: { stableAfterMs: 50, backoffMs: [0, 60_000] } });
    instance.start();
    await waitFor(() => relay.dials() >= 4, SLOW);
  });

  it("drops a socket that never says hello and dials the next node", async () => {
    const silent = await relayAt();
    silent.silent = true;
    const second = await relayAt();
    const { instance } = client({ "relay1.openmausbot.com": silent, "relay2.openmausbot.com": second }, { timing: { helloTimeoutMs: 1_000 } });
    instance.start();
    await waitFor(() => instance.node === "relay2.openmausbot.com", SLOW);
    expect(instance.problem).toBeNull();
    await waitFor(() => second.admitted(hid).size === 2, SLOW);
  });

  it("keeps a connected socket that answers its liveness check", async () => {
    const relay = await relayAt();
    const { instance } = client({ "relay1.openmausbot.com": relay }, { timing: { livenessTimeoutMs: 5_000 } });
    instance.start();
    await waitFor(() => instance.status === "connected", SLOW);
    const socket = relay.hosts.get(hid)!.control;
    instance.checkAlive();
    await waitFor(() => relay.refreshes === 1, SLOW);
    expect(instance.status).toBe("connected");
    expect(relay.hosts.get(hid)?.control).toBe(socket);
    expect(relay.closes).toEqual([]);
  });

  it("dials again, once and with backoff, when a connected socket stops answering", async () => {
    const relay = await relayAt();
    const { instance, statuses } = client({ "relay1.openmausbot.com": relay }, { timing: { livenessTimeoutMs: 200, redialSpreadMs: 600 } });
    instance.start();
    await waitFor(() => instance.status === "connected", SLOW);
    relay.silent = true;
    instance.checkAlive();
    await waitFor(() => instance.problem === "no_answer", SLOW);
    const droppedAt = Date.now();
    relay.silent = false;
    await waitFor(() => statuses.filter((status) => status.startsWith("connected")).length === 2, SLOW);
    // Not at once, though the backoff count is at its first step: a random part of the spread (here half of 600 ms).
    // A lower bound only: a slow runner makes it longer, never shorter.
    expect(Date.now() - droppedAt).toBeGreaterThanOrEqual(250);
    expect(instance.problem).toBeNull();
  });

  it("waits for a new token when the relay answers a liveness check with 4401", async () => {
    const relay = await relayAt();
    const { instance, rejected } = client({ "relay1.openmausbot.com": relay });
    instance.start();
    await waitFor(() => instance.status === "connected", SLOW);
    relay.refuseRefresh = true;
    instance.checkAlive();
    await waitFor(() => rejected.length === 1, SLOW);
    expect(instance.status).toBe("connecting");
    expect(instance.problem).toBe("token_refused");
    instance.checkAlive();
    await pause(200);
    expect(rejected).toHaveLength(1);
  });

  it("checks liveness on its own while connected", async () => {
    const relay = await relayAt();
    const { instance } = client({ "relay1.openmausbot.com": relay }, { timing: { livenessEveryMs: 100 } });
    instance.start();
    await waitFor(() => relay.refreshes >= 2, SLOW);
    expect(instance.status).toBe("connected");
  });

  it("waits at least 30 s after the relay's rate limit (4429)", async () => {
    const relay = await scriptedRelay((socket) => socket.close(4429));
    const { instance } = client({ "relay1.openmausbot.com": relay });
    instance.start();
    await waitFor(() => instance.problem === "busy", SLOW);
    await pause(500);
    expect(relay.dials()).toBe(1);
  });

  it("on a network change after a failed dial, dials now instead of waiting out its backoff", async () => {
    const relay = await scriptedRelay((socket) => socket.close(1011));
    // The backoff after the first failure is 30 s, so a second dial within the wait below can only be the shortcut.
    const { instance } = client({ "relay1.openmausbot.com": relay }, { timing: { backoffMs: [30_000] } });
    instance.start();
    await waitFor(() => instance.problem === "unreachable", SLOW);
    expect(relay.dials()).toBe(1);
    instance.checkAlive();
    await waitFor(() => relay.dials() === 2, SLOW);
  });

  it("on a network change keeps a wait the relay asked for (4429)", async () => {
    const relay = await scriptedRelay((socket) => socket.close(4429));
    const { instance } = client({ "relay1.openmausbot.com": relay });
    instance.start();
    await waitFor(() => instance.problem === "busy", SLOW);
    instance.checkAlive();
    await pause(500);
    expect(relay.dials()).toBe(1);
  });
});
