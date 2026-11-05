import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { describe, test } from "node:test";
import { WebSocket } from "ws";
import { Close, sha256, SUBPROTOCOL } from "../src/wire.ts";
import { Client, fakeHost, freshIp, mintToken, phoneHello, sleep, splicedPair, startTestRelay } from "./helpers.ts";

const MiB = 1024 * 1024;

describe("limits that need a short clock", () => {
  test("a session above the heavy rate for the window is held to the throttle rate", async () => {
    const throttleBps = 4e6;
    const t = await startTestRelay({ heavyWindowMs: 1_500, heavyBitsPerSecond: 8e6, throttleBitsPerSecond: throttleBps });
    try {
      const { phone, data, host } = await splicedPair(t.url, t.key);
      let bytes = 0;
      data.ws.on("message", (chunk: Buffer) => (bytes += chunk.length));
      const pump = setInterval(() => {
        if (phone.ws.bufferedAmount < 4 * MiB) for (let i = 0; i < 16; i++) phone.sendBinary(randomBytes(60_000));
      }, 5);
      let rate: number;
      try {
        const stopAt = performance.now() + 6_000;
        while (t.relay.ctx.metrics.count("relay_throttled_sessions_total") === 0 && performance.now() < stopAt) await sleep(20);
        assert.equal(t.relay.ctx.metrics.count("relay_throttled_sessions_total"), 1);
        await sleep(300);
        const before = bytes;
        await sleep(2_000);
        rate = ((bytes - before) * 8) / 2;
      } finally {
        clearInterval(pump);
      }
      assert.ok(rate < throttleBps * 1.5, `${Math.round(rate / 1e6)} Mbit/s after the throttle`);
      assert.ok(rate > throttleBps * 0.3, `${Math.round(rate / 1e6)} Mbit/s: the session must keep moving`);
      assert.ok(t.logs.some((event) => event.ev === "throttle"));
      for (const client of [phone, data, host.control]) client.ws.terminate();
    } finally {
      await t.stop();
    }
  });

  test("a host over its daily bytes loses its sessions with 4429 and gets no new ones today", async () => {
    const t = await startTestRelay({ hostBytesPerDay: 2 * MiB });
    try {
      const { phone, data, host, adm } = await splicedPair(t.url, t.key);
      for (let i = 0; i < 40; i++) phone.sendBinary(randomBytes(60_000));
      assert.equal(await phone.closeCode(), Close.Limited);
      assert.equal(await data.closeCode(), Close.Limited);
      const next = await phoneHello(t.url, host.hidText, adm);
      assert.equal(await next.closeCode(), Close.Limited);
      assert.equal(t.relay.ctx.metrics.count("relay_host_budget_exceeded_total"), 1);
      assert.ok(t.logs.some((event) => event.ev === "budget"));
      host.control.ws.close();
    } finally {
      await t.stop();
    }
  });

  test("a full node answers 4503 with retryInMs", async () => {
    const t = await startTestRelay({ socketsMax: 2 });
    try {
      const held = [await Client.open(t.url, "/v1/phone"), await Client.open(t.url, "/v1/phone")];
      const extra = await Client.open(t.url, "/v1/host");
      const closed = await extra.closedWithin();
      assert.deepEqual({ code: closed.code, reason: JSON.parse(closed.reason) }, { code: Close.Unavailable, reason: { retryInMs: 5_000 } });
      for (const client of held) client.ws.close();
    } finally {
      await t.stop();
    }
  });

  test("an address with its open sockets used up gets 4429, and a slot frees when one closes", async () => {
    const t = await startTestRelay({ ipOpenMax: 2 });
    try {
      const ip = freshIp();
      const held = [await Client.open(t.url, "/v1/phone", { ip }), await Client.open(t.url, "/v1/phone", { ip })];
      const third = await Client.open(t.url, "/v1/phone", { ip });
      assert.equal(await third.closeCode(), Close.Limited);
      held[0]!.ws.close();
      await held[0]!.closed;
      await sleep(50);
      const fourth = await Client.open(t.url, "/v1/phone", { ip });
      fourth.send({ t: "phone", v: 1, hid: randomBytes(16).toString("base64url"), adm: randomBytes(32).toString("base64url") });
      assert.equal(await fourth.closeCode(), Close.NotFound);
      held[1]!.ws.close();
    } finally {
      await t.stop();
    }
  });

  test("a control socket whose token expires is closed 4401, and its spliced session carries on", async () => {
    let now = Math.floor(Date.now() / 1000);
    const t = await startTestRelay({}, { wallSeconds: () => now });
    try {
      const adm = randomBytes(32);
      const hid = randomBytes(16);
      const hidText = hid.toString("base64url");
      const control = await Client.open(t.url, "/v1/host");
      const token = mintToken(t.key, { hid: hidText, iat: now, exp: now + 2 }, now);
      control.send({ t: "auth", v: 1, token });
      assert.equal((await control.json()).t, "hello");
      control.send({ t: "admit", set: [sha256(adm).toString("base64url")] });
      const phone = await phoneHello(t.url, hidText, adm);
      const open = await control.json();
      const data = await Client.open(t.url, "/v1/host/data");
      data.send({ t: "data", v: 1, sid: open.sid, token });
      assert.equal((await phone.json()).t, "ready");
      now += 2;
      assert.equal(await control.closeCode(4_000), Close.TokenInvalid);
      phone.sendBinary(Buffer.from("after expiry"));
      assert.equal((await data.next()).data.toString(), "after expiry");
      for (const client of [phone, data]) client.ws.close();
    } finally {
      await t.stop();
    }
  });

  test("the relay cuts a socket that answers no ping, and keeps one that does", async () => {
    const t = await startTestRelay({ pingIntervalMs: 500, pongTimeoutMs: 300 });
    try {
      const host = await fakeHost(t.url, t.key);
      const mute = new WebSocket(`${t.url}/v1/host`, [SUBPROTOCOL], { autoPong: false, headers: { "x-forwarded-for": freshIp() } });
      await new Promise((resolve) => mute.once("open", resolve));
      mute.send(JSON.stringify({ t: "auth", v: 1, token: mintToken(t.key) }));
      const closed = new Promise<number>((resolve) => mute.once("close", (code) => resolve(code)));
      mute.on("message", () => {});
      assert.equal(await closed, 1006);
      assert.ok(t.relay.ctx.metrics.count("relay_pong_timeouts_total") >= 1);
      await sleep(1_200);
      assert.equal(host.control.ws.readyState, WebSocket.OPEN);
      host.control.ws.close();
    } finally {
      await t.stop();
    }
  });

  test("a new set that still holds a phone leaves its session alone; only the set that drops it closes it", async () => {
    const t = await startTestRelay();
    try {
      const { phone, data, host, adm } = await splicedPair(t.url, t.key);
      const others = Array.from({ length: 31 }, () => randomBytes(32));
      host.admit([...others, adm]);
      host.admit([adm, ...others]);
      phone.sendBinary(Buffer.from("kept"));
      assert.equal((await data.next()).data.toString(), "kept");
      host.admit(others);
      assert.equal(await phone.closeCode(), Close.NotFound);
      assert.equal(await data.closeCode(), Close.NotFound);
      host.control.ws.close();
    } finally {
      await t.stop();
    }
  });

  test("a full set of 32 admits the phone in its last slot", async () => {
    const t = await startTestRelay();
    try {
      const adm = randomBytes(32);
      const host = await fakeHost(t.url, t.key, [...Array.from({ length: 31 }, () => randomBytes(32)), adm]);
      const phone = await phoneHello(t.url, host.hidText, adm);
      assert.equal((await host.control.json()).t, "open");
      phone.ws.close();
      host.control.ws.close();
    } finally {
      await t.stop();
    }
  });

  test("an admit set that drops a phone closes its pending session too", async () => {
    const t = await startTestRelay();
    try {
      const adm = randomBytes(32);
      const host = await fakeHost(t.url, t.key, [adm]);
      const phone = await phoneHello(t.url, host.hidText, adm);
      assert.equal((await host.control.json()).t, "open");
      host.admit([]);
      assert.equal(await phone.closeCode(), Close.NotFound);
      host.control.ws.close();
    } finally {
      await t.stop();
    }
  });

  test("a session's log line carries its bytes and close code and nothing else", async () => {
    const t = await startTestRelay();
    try {
      const { phone, data, host } = await splicedPair(t.url, t.key);
      phone.sendBinary(Buffer.alloc(1_000));
      await data.next();
      data.sendBinary(Buffer.alloc(3_000));
      await phone.next();
      data.ws.close(4000);
      await phone.closed;
      await sleep(50);
      const line = t.logs.find((event) => event.ev === "session");
      assert.deepEqual({ ...line, dur_s: 0 }, { ev: "session", hid8: line && "hid8" in line ? line.hid8 : "", dur_s: 0, up: 1_000, down: 3_000, close: 4000 });
      assert.match((line as { hid8: string }).hid8, /^[0-9a-f]{8}$/);
      host.control.ws.close();
    } finally {
      await t.stop();
    }
  });
});
