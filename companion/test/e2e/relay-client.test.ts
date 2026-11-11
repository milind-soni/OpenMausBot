import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

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

function client(relays: Record<string, FakeRelay>, overrides: Partial<RelayClientOptions> = {}) {
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
    await waitFor(() => statuses.filter((status) => status.startsWith("connected")).length === 2, 5_000);
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
});
