import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { describe, test } from "node:test";
import type { WebSocket } from "ws";
import { Close } from "../src/wire.ts";
import { sleep, splicedPair, startTestRelay, type TestRelay } from "./helpers.ts";

const CHUNK = 60_000;
const MiB = 1024 * 1024;

/** The relay's own socket for a route: the side of the splice the test clients cannot see. */
function relaySide(t: TestRelay, route: "data" | "phone"): WebSocket {
  const found = [...t.relay.sockets()].find(([, r]) => r === route);
  assert.ok(found, `no ${route} socket`);
  return found[0];
}

async function until(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const stop = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe("backpressure", () => {
  test("a phone that stops reading pauses the host's socket, the relay holds little, and every byte arrives in order", async () => {
    const t = await startTestRelay();
    try {
      const { phone, data, host } = await splicedPair(t.url, t.key);
      phone.ws.pause();
      const total = 24 * MiB;
      const sent = createHash("sha256");
      for (let offset = 0; offset < total; offset += CHUNK) {
        const chunk = randomBytes(Math.min(CHUNK, total - offset));
        sent.update(chunk);
        data.sendBinary(chunk);
      }
      const relayData = relaySide(t, "data");
      const relayPhone = relaySide(t, "phone");
      await until(() => relayData.isPaused, 5_000, "the relay to pause the host's socket");
      await sleep(500);
      assert.ok(relayData.isPaused);
      assert.ok(t.relay.ctx.metrics.count("relay_backpressure_pauses_total") >= 1);
      assert.ok(relayPhone.bufferedAmount <= MiB + 2 * 70_000, `relay holds ${relayPhone.bufferedAmount} bytes for the phone`);
      assert.ok(data.ws.bufferedAmount > 8 * MiB, `the host still holds ${data.ws.bufferedAmount} bytes it could not send`);

      const received = createHash("sha256");
      let bytes = 0;
      phone.ws.on("message", (chunk: Buffer) => {
        received.update(chunk);
        bytes += chunk.length;
      });
      phone.ws.resume();
      await until(() => bytes >= total, 20_000, "every byte at the phone");
      assert.equal(bytes, total);
      assert.equal(received.digest("hex"), sent.digest("hex"));
      await until(() => !relayData.isPaused, 2_000, "the relay to resume the host's socket");
      for (const client of [phone, data, host.control]) client.ws.close();
    } finally {
      await t.stop();
    }
  });

  test("a host that stops reading pauses the phone's socket the same way", async () => {
    const t = await startTestRelay();
    try {
      const { phone, data, host } = await splicedPair(t.url, t.key);
      data.ws.pause();
      for (let offset = 0; offset < 16 * MiB; offset += CHUNK) phone.sendBinary(randomBytes(CHUNK));
      await until(() => relaySide(t, "phone").isPaused, 5_000, "the relay to pause the phone's socket");
      let bytes = 0;
      data.ws.on("message", (chunk: Buffer) => (bytes += chunk.length));
      data.ws.resume();
      await until(() => bytes >= Math.ceil((16 * MiB) / CHUNK) * CHUNK, 20_000, "every byte at the host");
      for (const client of [phone, data, host.control]) client.ws.close();
    } finally {
      await t.stop();
    }
  });

  test("a destination that takes nothing for the wedge time closes the session 4429", async () => {
    const t = await startTestRelay({ wedgeMs: 1_500 });
    try {
      const { phone, data, host } = await splicedPair(t.url, t.key);
      phone.ws.pause();
      for (let offset = 0; offset < 16 * MiB; offset += CHUNK) data.sendBinary(randomBytes(CHUNK));
      const started = performance.now();
      assert.equal(await data.closeCode(10_000), Close.Limited);
      const waited = performance.now() - started;
      assert.ok(waited > 1_000 && waited < 5_000, `closed after ${waited} ms`);
      await until(() => t.relay.sockets().size === 1, 5_000, "only the control socket to be left");
      assert.ok(t.relay.ctx.metrics.count("relay_closes_total", Close.Limited) >= 1);
      host.control.ws.close();
    } finally {
      await t.stop();
    }
  });

  test("a destination that is slow but moving is never cut by the wedge timer", async () => {
    const t = await startTestRelay({ wedgeMs: 1_000 });
    try {
      const { phone, data, host } = await splicedPair(t.url, t.key);
      for (let offset = 0; offset < 12 * MiB; offset += CHUNK) data.sendBinary(randomBytes(CHUNK));
      let bytes = 0;
      phone.ws.on("message", (chunk: Buffer) => (bytes += chunk.length));
      phone.ws.pause();
      const stop = performance.now() + 3_000;
      while (performance.now() < stop) {
        phone.ws.resume();
        await sleep(10);
        phone.ws.pause();
        await sleep(150);
      }
      phone.ws.resume();
      await until(() => bytes >= 12 * MiB, 20_000, "every byte at the phone");
      assert.equal(t.relay.ctx.metrics.count("relay_closes_total", Close.Limited), 0);
      for (const client of [phone, data, host.control]) client.ws.close();
    } finally {
      await t.stop();
    }
  });
});
