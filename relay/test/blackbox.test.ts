import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { performance } from "node:perf_hooks";
import {
  Client,
  fakeHost,
  freshIp,
  keysJson,
  mintToken,
  phoneHello,
  spawnRelay,
  splicedPair,
  testKey,
  type SpawnedRelay,
} from "./helpers.ts";

const V9 = JSON.parse(readFileSync(new URL("./vectors/e2e-v1.json", import.meta.url), "utf8")).V9;
const METRICS_TOKEN = randomBytes(24).toString("base64url");
const key = testKey();
/** Every secret and identifier a test hands the relay, so the log check can look for each one. */
const secrets = new Set<string>();
let relay: SpawnedRelay;

const remember = (...values: string[]) => values.forEach((value) => secrets.add(value));

before(async () => {
  relay = await spawnRelay({ RELAY_NODE: "relay1", RELAY_TOKEN_KEYS: keysJson(key), RELAY_METRICS_TOKEN: METRICS_TOKEN });
  remember(METRICS_TOKEN);
});

after(async () => {
  await relay.stop();
});

describe("a session end to end", () => {
  test("host and phone splice, binary passes both ways untouched, and the host's 4001 reaches the phone", async () => {
    const { host, phone, data, adm } = await splicedPair(relay.url, key);
    remember(host.token, host.hidText, adm.toString("base64url"));
    assert.deepEqual(host.hello, V9.relay[0]);
    const up = Buffer.concat([Buffer.from("PAYLOAD-MARKER-UP"), randomBytes(5000)]);
    phone.sendBinary(up);
    const atHost = await data.next();
    assert.equal(atHost.binary, true);
    assert.deepEqual(atHost.data, up);
    const down = Buffer.concat([Buffer.from("PAYLOAD-MARKER-DOWN"), randomBytes(65_535 - 19)]);
    data.sendBinary(down);
    assert.deepEqual((await phone.next()).data, down);
    data.ws.close(4001);
    assert.equal(await phone.closeCode(), 4001);
    host.control.ws.close();
  });

  test("the phone's 1000 reaches the host, and an empty binary message passes", async () => {
    const { phone, data, host } = await splicedPair(relay.url, key);
    phone.sendBinary(Buffer.alloc(0));
    assert.equal((await data.next()).data.length, 0);
    phone.ws.close(1000);
    assert.equal(await data.closeCode(), 1000);
    host.control.ws.close();
  });

  test("a code the ends do not use with each other reaches the other side as 1001", async () => {
    const { phone, data, host } = await splicedPair(relay.url, key);
    data.ws.close(4404);
    assert.equal(await phone.closeCode(), 1001);
    phone.ws.terminate();
    host.control.ws.close();
  });
});

describe("Node's built-in WebSocket client", () => {
  /** The desktop dials the relay with Node's own WebSocket, which sends no Origin and cannot add headers. */
  function builtIn(path: string): Promise<{ socket: globalThis.WebSocket; messages: Array<string | ArrayBuffer>; next: () => Promise<string | ArrayBuffer> }> {
    const socket = new globalThis.WebSocket(`${relay.url}${path}`, ["omb-relay.v1"]);
    socket.binaryType = "arraybuffer";
    const messages: Array<string | ArrayBuffer> = [];
    const waiting: Array<(message: string | ArrayBuffer) => void> = [];
    socket.addEventListener("message", (event) => {
      const waiter = waiting.shift();
      if (waiter) waiter(event.data);
      else messages.push(event.data);
    });
    const next = () => (messages.length > 0 ? Promise.resolve(messages.shift()!) : new Promise<string | ArrayBuffer>((resolve) => waiting.push(resolve)));
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve({ socket, messages, next }));
      socket.addEventListener("error", () => reject(new Error("could not connect")));
    });
  }

  test("works as the host: control socket, admission, data socket and binary both ways", async () => {
    const adm = randomBytes(32);
    const hid = randomBytes(16).toString("base64url");
    const token = mintToken(key, { hid });
    const control = await builtIn("/v1/host");
    control.socket.send(JSON.stringify({ t: "auth", v: 1, token }));
    assert.deepEqual(JSON.parse(String(await control.next())), V9.relay[0]);
    control.socket.send(JSON.stringify({ t: "admit", set: [createHash("sha256").update(adm).digest("base64url")] }));
    const phone = await phoneHello(relay.url, hid, adm);
    const { sid } = JSON.parse(String(await control.next()));
    const data = await builtIn("/v1/host/data");
    data.socket.send(JSON.stringify({ t: "data", v: 1, sid, token }));
    assert.equal((await phone.json()).t, "ready");
    phone.sendBinary(Buffer.from("msg1"));
    assert.equal(Buffer.from((await data.next()) as ArrayBuffer).toString(), "msg1");
    data.socket.send(new TextEncoder().encode("msg2"));
    assert.equal((await phone.next()).data.toString(), "msg2");
    data.socket.close(4001);
    assert.equal(await phone.closeCode(), 4001);
    control.socket.close();
  });
});

describe("routing answers", () => {
  test("4404 for a host that is not here and for a phone it does not admit, with nothing to tell them apart", async () => {
    const adm = randomBytes(32);
    const absent = await phoneHello(relay.url, randomBytes(16).toString("base64url"), adm);
    const host = await fakeHost(relay.url, key, [randomBytes(32)]);
    const unadmitted = await phoneHello(relay.url, host.hidText, adm);
    const [a, b] = await Promise.all([absent.closedWithin(), unadmitted.closedWithin()]);
    assert.deepEqual(a, { code: 4404, reason: "" });
    assert.deepEqual(b, a);
    host.control.ws.close();
  });

  test("4409: a newer control socket wins, spliced sessions carry on, and a set without the phone closes it 4404", async () => {
    const { host, phone, data } = await splicedPair(relay.url, key);
    const newer = await Client.open(relay.url, "/v1/host");
    newer.send({ t: "auth", v: 1, token: host.token });
    assert.equal((await newer.json()).t, "hello");
    assert.equal(await host.control.closeCode(), 4409);
    phone.sendBinary(Buffer.from("still here"));
    assert.equal((await data.next()).data.toString(), "still here");
    newer.send({ t: "admit", set: [] });
    assert.equal(await phone.closeCode(), 4404);
    assert.equal(await data.closeCode(), 4404);
    newer.ws.close();
  });

  test("a refresh with the same host is answered with hello; one for another host closes 4401", async () => {
    const host = await fakeHost(relay.url, key);
    host.control.send({ t: "auth", v: 1, token: mintToken(key, { hid: host.hidText }) });
    assert.equal((await host.control.json()).t, "hello");
    host.control.send({ t: "auth", v: 1, token: mintToken(key) });
    assert.equal(await host.control.closeCode(), 4401);
  });

  test("a data socket for an unknown sid gets 4404, and an unadmitted phone does not get an open", async () => {
    const { host, phone } = await splicedPair(relay.url, key);
    const unknown = await Client.open(relay.url, "/v1/host/data");
    unknown.send({ t: "data", v: 1, sid: randomBytes(16).toString("base64url"), token: host.token });
    assert.equal(await unknown.closeCode(), 4404);
    const other = await phoneHello(relay.url, host.hidText, randomBytes(32));
    assert.equal(await other.closeCode(), 4404);
    phone.ws.close();
    host.control.ws.close();
  });

  test("a data socket whose token names another host cannot take a phone, and a sid is single use", async () => {
    const adm = randomBytes(32);
    const host = await fakeHost(relay.url, key, [adm]);
    const phone = await phoneHello(relay.url, host.hidText, adm);
    const open = await host.control.json();
    const thief = await Client.open(relay.url, "/v1/host/data");
    thief.send({ t: "data", v: 1, sid: open.sid, token: mintToken(key) });
    assert.equal(await thief.closeCode(), 4404);
    const data = await Client.open(relay.url, "/v1/host/data");
    data.send({ t: "data", v: 1, sid: open.sid, token: host.token });
    assert.deepEqual(await phone.json(), V9.relay[2]);
    const again = await Client.open(relay.url, "/v1/host/data");
    again.send({ t: "data", v: 1, sid: open.sid, token: host.token });
    assert.equal(await again.closeCode(), 4404);
    phone.ws.close();
    host.control.ws.close();
  });
});

describe("4401 token answers", () => {
  test("bad signature, unknown kid, expired, not a token, and a data socket with a bad token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const good = mintToken(key);
    const tokens = [
      `${good.split(".")[0]}.${randomBytes(64).toString("base64url")}`,
      mintToken(testKey("k7")),
      mintToken(key, { iat: now - 12 * 3600, exp: now - 1 }),
      "not-a-token",
    ];
    for (const token of tokens) {
      const control = await Client.open(relay.url, "/v1/host");
      control.send({ t: "auth", v: 1, token });
      assert.equal(await control.closeCode(), 4401, token);
    }
    const data = await Client.open(relay.url, "/v1/host/data");
    data.send({ t: "data", v: 1, sid: randomBytes(16).toString("base64url"), token: tokens[0] });
    assert.equal(await data.closeCode(), 4401);
  });
});

describe("4400 malformed or out of order", () => {
  for (const path of ["/v1/host", "/v1/host/data", "/v1/phone"]) {
    test(`${path}: binary first, not JSON, a JSON array, over 4 KiB, and the wrong message`, async () => {
      const sends: Array<(client: Client) => void> = [
        (c) => c.sendBinary(Buffer.from("{}")),
        (c) => c.send("hello"),
        (c) => c.send("[]"),
        (c) => c.send(JSON.stringify({ t: "phone", v: 1, pad: "x".repeat(4097) })),
        (c) => c.send({ t: path === "/v1/phone" ? "auth" : "phone", v: 1 }),
      ];
      for (const send of sends) {
        const client = await Client.open(relay.url, path);
        send(client);
        assert.equal(await client.closeCode(), 4400);
      }
    });
  }

  test("a phone that sends before ready, a second control message that is not auth or admit, and an oversized set", async () => {
    const adm = randomBytes(32);
    const host = await fakeHost(relay.url, key, [adm]);
    const eager = await phoneHello(relay.url, host.hidText, adm);
    eager.sendBinary(Buffer.from("too soon"));
    assert.equal(await eager.closeCode(), 4400);
    host.control.send({ t: "admit", set: Array.from({ length: 33 }, () => randomBytes(32).toString("base64url")) });
    assert.equal(await host.control.closeCode(), 4400);
    const other = await fakeHost(relay.url, key);
    other.control.send({ t: "open", sid: "x" });
    assert.equal(await other.control.closeCode(), 4400);
  });

  test("text after the splice closes both sides 4400", async () => {
    const { phone, data, host } = await splicedPair(relay.url, key);
    data.send("text is not allowed now");
    assert.equal(await phone.closeCode(), 4400);
    assert.equal(await data.closeCode(), 4400);
    host.control.ws.close();
  });
});

describe("deadlines", { concurrency: true }, () => {
  test("no first message in 5 s closes 4400", async () => {
    const client = await Client.open(relay.url, "/v1/phone");
    const started = performance.now();
    assert.equal(await client.closeCode(8_000), 4400);
    assert.ok(performance.now() - started > 4_500);
  });

  test("no admission set in 5 s after hello closes 4400", async () => {
    const control = await Client.open(relay.url, "/v1/host");
    control.send({ t: "auth", v: 1, token: mintToken(key) });
    assert.equal((await control.json()).t, "hello");
    assert.equal(await control.closeCode(8_000), 4400);
  });

  test("a host that never opens the data socket: the phone gets 4408 after 10 s, and the sid is gone", async () => {
    const adm = randomBytes(32);
    const host = await fakeHost(relay.url, key, [adm]);
    const phone = await phoneHello(relay.url, host.hidText, adm);
    const open = await host.control.json();
    const started = performance.now();
    assert.equal(await phone.closeCode(13_000), 4408);
    assert.ok(performance.now() - started > 9_000);
    const late = await Client.open(relay.url, "/v1/host/data");
    late.send({ t: "data", v: 1, sid: open.sid, token: host.token });
    assert.equal(await late.closeCode(), 4404);
    host.control.ws.close();
  });
});

describe("size and rate limits", () => {
  test("1009 for a frame over 70,000 bytes, before auth and after the splice; 70,000 passes", async () => {
    const early = await Client.open(relay.url, "/v1/phone");
    early.sendBinary(Buffer.alloc(70_001));
    assert.equal(await early.closeCode(), 1009);
    const { phone, data, host } = await splicedPair(relay.url, key);
    phone.sendBinary(Buffer.alloc(70_000, 1));
    assert.equal((await data.next()).data.length, 70_000);
    phone.sendBinary(Buffer.alloc(70_001));
    assert.equal(await phone.closeCode(), 1009);
    assert.equal(await data.closeCode(), 1001);
    host.control.ws.close();
  });

  test("4429 for the 61st new socket in a minute from one address", async () => {
    const ip = freshIp();
    const clients: Client[] = [];
    for (let i = 0; i < 60; i++) clients.push(await Client.open(relay.url, "/v1/phone", { ip }));
    const extra = await Client.open(relay.url, "/v1/phone", { ip });
    assert.equal(await extra.closeCode(), 4429);
    for (const client of clients) client.ws.terminate();
  });

  test("4429 for a host's 17th phone session", async () => {
    const adm = randomBytes(32);
    const host = await fakeHost(relay.url, key, [adm]);
    const phones: Client[] = [];
    for (let i = 0; i < 16; i++) {
      phones.push(await phoneHello(relay.url, host.hidText, adm));
      assert.equal((await host.control.json()).t, "open");
    }
    const seventeenth = await phoneHello(relay.url, host.hidText, adm);
    assert.equal(await seventeenth.closeCode(), 4429);
    for (const phone of phones) phone.ws.terminate();
    host.control.ws.close();
  });
});

describe("HTTP", () => {
  test("upgrades: a wrong path is 404, an Origin header 403, a missing subprotocol 400", async () => {
    assert.equal(await Client.refusal(relay.url, "/v1/nope"), 404);
    assert.equal(await Client.refusal(relay.url, "/v1/phone?x=1"), 404);
    assert.equal(await Client.refusal(relay.url, "/v1/phone", { headers: { origin: "https://example.com" } }), 403);
    assert.equal(await Client.refusal(relay.url, "/v1/phone", { protocols: ["other"] }), 400);
    assert.equal(await Client.refusal(relay.url, "/v1/phone", { protocols: [] }), 400);
    assert.equal(await Client.refusal(relay.url, "/v1/phone", { ip: "not-an-ip" }), 400);
  });

  test("/healthz answers; /metrics needs the bearer", async () => {
    const health = await fetch(`${relay.httpUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, node: "relay1" });
    assert.equal((await fetch(`${relay.httpUrl}/metrics`)).status, 401);
    assert.equal((await fetch(`${relay.httpUrl}/metrics`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    const metrics = await fetch(`${relay.httpUrl}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
    assert.equal(metrics.status, 200);
    const text = await metrics.text();
    for (const name of ["relay_hosts_connected", "relay_sessions_total", "relay_closes_total{code=\"4404\"}", "relay_event_loop_lag_p99_seconds", "process_resident_memory_bytes"]) {
      assert.ok(text.includes(name), name);
    }
    assert.equal((await fetch(`${relay.httpUrl}/`)).status, 404);
  });
});

describe("logs", () => {
  test("are JSON lines of metadata only: no token, admission value, hostId, address or payload", async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const lines = relay.stdout().trim().split("\n");
    const allowed = new Set(["ts", "node", "ev", "port", "hid8", "dur_s", "up", "down", "close", "hosts", "sessions"]);
    for (const line of lines) {
      const record = JSON.parse(line);
      for (const field of Object.keys(record)) assert.ok(allowed.has(field), `${field} in ${line}`);
    }
    const all = relay.stdout() + relay.stderr();
    for (const secret of secrets) assert.equal(all.includes(secret), false, "a secret or identifier reached the log");
    for (const marker of ["PAYLOAD-MARKER", "198.18.", "198.19.", "127.0.0.1"]) assert.equal(all.includes(marker), false, marker);
    assert.ok(lines.some((line) => JSON.parse(line).ev === "session"));
  });
});

describe("SIGTERM", () => {
  test("hosts hear restarting, phones and data sockets get 4503 with retryInMs, and the process is gone within 5 s", async () => {
    const own = await spawnRelay({ RELAY_NODE: "relay2", RELAY_TOKEN_KEYS: keysJson(key) });
    try {
      const { host, phone, data } = await splicedPair(own.url, key);
      const idle = await Client.open(own.url, "/v1/phone");
      const started = performance.now();
      own.proc.kill("SIGTERM");
      assert.deepEqual(await host.control.json(), V9.relay[3]);
      assert.equal(await host.control.closeCode(), 1001);
      const phoneClose = await phone.closedWithin();
      assert.deepEqual({ code: phoneClose.code, reason: JSON.parse(phoneClose.reason) }, { code: 4503, reason: { retryInMs: 1000 } });
      assert.equal(await data.closeCode(), 4503);
      assert.equal(await idle.closeCode(), 4503);
      assert.equal(await own.exited, 0);
      assert.ok(performance.now() - started < 5_000);
      assert.ok(own.stdout().includes('"ev":"drain"'));
    } finally {
      await own.stop();
    }
  });
});
