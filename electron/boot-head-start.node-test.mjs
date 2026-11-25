import assert from "node:assert/strict";
import test from "node:test";
import { createBootHeadStart } from "./boot-head-start.mjs";

test("work begins at start and its one result is handed to the first taker", async () => {
  let runs = 0;
  const head = createBootHeadStart({ keys: async () => ({ run: (runs += 1) }) });
  head.start();
  head.start();
  assert.equal(runs, 1);
  assert.deepEqual(await head.take("keys"), { run: 1 });
  assert.equal(runs, 1);
});

test("a second take, and a take with no start, run the work afresh", async () => {
  let runs = 0;
  const head = createBootHeadStart({ proxy: async () => (runs += 1) });
  assert.equal(await head.take("proxy"), 1);
  head.start();
  assert.equal(await head.take("proxy"), 2);
  assert.equal(await head.take("proxy"), 3);
});

test("a failure waits for its taker, whether the work throws or rejects", async () => {
  const unhandled = [];
  const listen = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listen);
  try {
    const head = createBootHeadStart({ rejects: async () => { throw new Error("store busy"); }, throws: () => { throw new Error("no file"); } });
    head.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    await assert.rejects(head.take("rejects"), /store busy/);
    await assert.rejects(head.take("throws"), /no file/);
  } finally {
    process.off("unhandledRejection", listen);
  }
});
