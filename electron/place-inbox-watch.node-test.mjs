import assert from "node:assert/strict";
import test from "node:test";

import { createPlaceInboxWatch, INBOX_WATCH_MS } from "./place-inbox-watch.mjs";

const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });

function setup(over = {}) {
  const asked = [], counts = { local: 0, "https://a.test": 0, "https://b.test": 0 };
  let changes = 0, tick = null;
  const watch = createPlaceInboxWatch({
    places: () => [{ id: "local", local: true }, { id: "a", origin: "https://a.test" }, { id: "b", origin: "https://b.test" }],
    activeId: () => "local",
    local: async (route) => { asked.push(["local", route]); return answer(200, { count: counts.local }); },
    cloudFetch: async (url, init) => { asked.push([url, init.headers["x-omb-background"]]); const origin = new URL(url).origin; return counts[origin] === null ? answer(404, {}) : answer(200, { count: counts[origin] }); },
    asleep: () => false, shown: () => true, changed: () => { changes += 1; },
    setTimer: (run, ms) => { tick = { run, ms }; return {}; },
    ...over,
  });
  return { watch, asked, counts, changes: () => changes, tick: () => tick };
}

test("a place with something waiting fires, and only once the window shows another", async () => {
  const f = setup();
  f.counts["https://a.test"] = 2;
  f.counts.local = 3;
  f.watch.waiting("a");
  await f.watch.look();
  assert.equal(f.watch.waiting("a"), true);
  assert.equal(f.watch.waiting("b"), false);
  assert.equal(f.watch.waiting("local"), false, "the place on screen has its own row");
  assert.equal(f.changes(), 1);
  await f.watch.look();
  assert.equal(f.changes(), 1, "the rail is told only when a number moved");
  f.counts["https://a.test"] = 0;
  await f.watch.look();
  assert.equal(f.watch.waiting("a"), false);
  assert.equal(f.changes(), 2);
});

test("asks each Cloud as background work, so asking never counts as the person using it", async () => {
  const f = setup();
  await f.watch.look();
  assert.deepEqual(f.asked.find(([url]) => url === "https://a.test/api/inbox/count"), ["https://a.test/api/inbox/count", "1"]);
  assert.deepEqual(f.asked.find(([url]) => url === "local"), ["local", "/api/inbox/count"]);
});

test("never asks a sleeping Cloud, which any request would wake; it keeps the last number", async () => {
  let asleep = false;
  const f = setup({ asleep: (origin) => asleep && origin === "https://a.test" });
  f.counts["https://a.test"] = 1;
  f.watch.waiting("a");
  await f.watch.look();
  assert.equal(f.watch.waiting("a"), true);
  asleep = true;
  f.asked.length = 0;
  f.counts["https://a.test"] = 0;
  await f.watch.look();
  assert.equal(f.asked.some(([url]) => String(url).startsWith("https://a.test")), false);
  assert.equal(f.watch.waiting("a"), true);
});

test("an older place with no inbox has nothing waiting, and one that can't be reached keeps its number", async () => {
  const failing = new Set();
  const f = setup({ cloudFetch: async (url) => { if (failing.has(url)) throw new Error("offline"); return String(url).startsWith("https://a.test") ? answer(404, {}) : answer(200, { count: 4 }); } });
  f.watch.waiting("a");
  await f.watch.look();
  assert.equal(f.watch.waiting("a"), false);
  assert.equal(f.watch.waiting("b"), true);
  failing.add("https://b.test/api/inbox/count");
  await f.watch.look();
  assert.equal(f.watch.waiting("b"), true);
});

test("a page's nonsense is no count", async () => {
  const f = setup({ cloudFetch: async () => answer(200, { count: "many" }) });
  f.watch.waiting("a");
  await f.watch.look();
  assert.equal(f.watch.waiting("a"), false);
});

test("asks nothing while the window can't be seen, and starts its clock once on the first read of the list", async () => {
  const f = setup({ shown: () => false });
  f.watch.waiting("a");
  f.watch.waiting("b");
  await f.watch.look();
  assert.deepEqual(f.asked, []);
  assert.equal(f.tick().ms, INBOX_WATCH_MS);
});
