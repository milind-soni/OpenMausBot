import test from "node:test";
import assert from "node:assert/strict";
import { createOmiContext } from "./island-omi.mjs";

const KEY = "omi_dev_synthetic";
function fixture(fetch) {
  let key = KEY, clock = 0;
  const timers = new Map(); let id = 0;
  const omi = createOmiContext({ fetch, readKey: async () => key, writeKey: async value => { key = value; },
    now: () => clock, setTimer: (fn, delay) => { timers.set(++id, { fn, delay }); return id; }, clearTimer: value => timers.delete(value) });
  return { omi, timers, key: () => key, tick: value => { clock = value; } };
}
const response = data => new Response(JSON.stringify(data));

test("fetches bounded context from official endpoints and never exposes the key", async () => {
  const calls = [];
  const { omi, timers } = fixture(async (url, options) => {
    calls.push({ url, options });
    return response(url.includes("memories") ? Array.from({ length: 20 }, () => ({ content: "memória ".repeat(500) }))
      : [{ structured: { title: "Reunião", overview: "Revisar o protótipo" } }]);
  });
  await omi.refresh();
  assert.equal(omi.snapshot().status, "ready");
  assert.equal(omi.context().length, 8000);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.url.startsWith("https://api.omi.me/v1/dev/user/"));
    assert.equal(call.options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(call.options.redirect, "error");
  }
  assert.ok(!JSON.stringify(omi.snapshot()).includes(KEY));
  assert.equal([...timers.values()][0].delay, 120000);
  omi.dispose(); assert.equal(timers.size, 0);
});

test("coalesces refreshes and ignores late results after disconnect", async () => {
  const pending = [];
  const { omi, key, timers } = fixture(() => new Promise(resolve => pending.push(resolve)));
  const first = omi.refresh(), second = omi.refresh();
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  await omi.disconnect();
  pending.forEach(resolve => resolve(response([{ content: "must disappear" }])));
  await first;
  assert.equal(omi.context(), "");
  assert.equal(omi.snapshot().status, "disconnected");
  assert.equal(key(), null);
  assert.equal(timers.size, 0);
});

test("respects Retry-After even when refresh is manually requested", async () => {
  let calls = 0;
  const { omi, timers, tick } = fixture(async () => {
    calls++;
    return new Response("", { status: 429, headers: { "Retry-After": "1800" } });
  });
  await omi.refresh();
  assert.equal(omi.snapshot().status, "error");
  assert.equal([...timers.values()][0].delay, 1800000);
  await omi.refresh(); assert.equal(calls, 2);
  tick(1800001); await omi.refresh(); assert.equal(calls, 4);
  omi.dispose();
});

test("keeps available conversations when memory access is denied and redacts provider errors", async () => {
  const { omi } = fixture(async url => url.includes("memories")
    ? new Response(KEY, { status: 403 }) : response([{ created_at: "2026-11-13", structured: { title: "Plano", overview: "Construir ilha" } }]));
  await omi.refresh();
  assert.equal(omi.snapshot().status, "error");
  assert.match(omi.context(), /Construir ilha/);
  assert.ok(!JSON.stringify(omi.snapshot()).includes(KEY));
  omi.dispose();
});

test("configuration validates key kind and persists before requesting data", async () => {
  let calls = 0;
  const { omi, key } = fixture(async () => { calls++; return response([]); });
  await assert.rejects(omi.configure("omi_mcp_wrong"), /omi_dev_/);
  assert.equal(calls, 0);
  await omi.configure("omi_dev_new");
  assert.equal(key(), "omi_dev_new");
  assert.equal(omi.snapshot().configured, true);
  assert.equal(calls, 2);
  omi.dispose();
});

test("dispose prevents deferred reads from fetching or repopulating context", async () => {
  let resolveKey, calls = 0;
  const omi = createOmiContext({ fetch: async () => { calls++; return response([]); },
    readKey: () => new Promise(resolve => { resolveKey = resolve; }), writeKey: async () => {} });
  const pending = omi.refresh();
  await new Promise(resolve => setImmediate(resolve));
  omi.dispose(); resolveKey(KEY); await pending;
  assert.equal(calls, 0); assert.equal(omi.context(), "");
});

test("strips control characters including DEL, skips blank items, and flags X-Omi-List-Truncated", async () => {
  const { omi } = fixture(async url => new Response(
    JSON.stringify(url.includes("memories")
      ? [{ created_at: "2026-11-13", content: "ok\u0000\u0007\nlinha\t2\u001b\u007f" }, { created_at: "2026-11-13", content: "\u0000 \t\n" }]
      : [{ created_at: "2026-11-13", structured: { title: "\u0007  ", overview: "\u007f\n" } }]),
    { headers: url.includes("memories") ? { "X-Omi-List-Truncated": "true" } : {} },
  ));
  await omi.refresh();
  assert.equal(omi.snapshot().status, "ready");
  assert.equal(omi.snapshot().message, "Contexto parcial do Omi atualizado.");
  assert.match(omi.context(), /ok\nlinha\t2$/);
  assert.doesNotMatch(omi.context(), /Conversa/);
  omi.dispose();
});

test("aborts in-flight fetch after 15s deadline and schedules 120s retry", async () => {
  const signals = [];
  const { omi, timers } = fixture((_url, options) => {
    signals.push(options.signal);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  });
  const pending = omi.refresh();
  await new Promise(resolve => setImmediate(resolve));
  const deadline = [...timers.values()].find(entry => entry.delay === 15_000);
  assert.ok(deadline);
  deadline.fn();
  await pending;
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(omi.snapshot().status, "error");
  assert.equal([...timers.values()].at(-1).delay, 120_000);
  omi.dispose();
});

test("disconnect wins race against pending configure persistence", async () => {
  let stored = null, releaseWrite, calls = 0;
  const omi = createOmiContext({
    fetch: async () => { calls++; return response([]); },
    readKey: async () => stored,
    writeKey: value => new Promise(resolve => {
      if (value === "omi_dev_race") { releaseWrite = () => { stored = value; resolve(); }; return; }
      stored = value; resolve();
    }),
  });
  const configuring = omi.configure("omi_dev_race");
  await new Promise(resolve => setImmediate(resolve));
  const disconnecting = omi.disconnect();
  releaseWrite();
  await Promise.all([configuring, disconnecting]);
  assert.equal(stored, null);
  assert.equal(calls, 0);
  assert.equal(omi.snapshot().status, "disconnected");
  assert.equal(omi.context(), "");
  omi.dispose();
});

test("clamps oversized Retry-After, ignores blank Retry-After, and honors 503 Retry-After", async () => {
  const { omi, timers } = fixture(async () => new Response("", { status: 429, headers: { "Retry-After": "999999999" } }));
  await omi.refresh();
  assert.equal([...timers.values()][0].delay, 2_147_483_647);
  omi.dispose();

  const dateFixture = fixture(async () => new Response("", { status: 429, headers: { "Retry-After": "Thu, 01 Jan 1970 00:05:00 GMT" } }));
  await dateFixture.omi.refresh();
  assert.equal([...dateFixture.timers.values()][0].delay, 300_000);
  dateFixture.omi.dispose();

  const blankFixture = fixture(async () => new Response("", { status: 429, headers: { "Retry-After": "   " } }));
  await blankFixture.omi.refresh();
  assert.equal([...blankFixture.timers.values()][0].delay, 120_000);
  blankFixture.omi.dispose();

  const unavailableFixture = fixture(async () => new Response("", { status: 503, headers: { "Retry-After": "240" } }));
  await unavailableFixture.omi.refresh();
  assert.equal([...unavailableFixture.timers.values()][0].delay, 240_000);
  unavailableFixture.omi.dispose();
});

test("configure aborts prior refresh and coalesces a refresh triggered while persisting", async () => {
  let stored = KEY, releaseWrite, fetchBatch = 0;
  const pendingFirst = [];
  const omi = createOmiContext({
    fetch: (_url, options) => {
      fetchBatch++;
      if (fetchBatch <= 2) {
        return new Promise((_resolve, reject) => {
          pendingFirst.push(options.signal);
          options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return Promise.resolve(response([{ created_at: "2026-11-14", content: "coalesced" }]));
    },
    readKey: async () => stored,
    writeKey: value => new Promise(resolve => {
      releaseWrite = () => { stored = value; resolve(); };
    }),
  });
  const firstRefresh = omi.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pendingFirst.length, 2);

  const configuring = omi.configure("omi_dev_coalesced");
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(pendingFirst.every(signal => signal.aborted));
  await firstRefresh;

  const overlappingRefresh = omi.refresh();
  releaseWrite();
  await Promise.all([configuring, overlappingRefresh]);
  assert.equal(fetchBatch, 4);
  assert.equal(omi.snapshot().status, "ready");
  assert.match(omi.context(), /coalesced/);
  omi.dispose();
});
