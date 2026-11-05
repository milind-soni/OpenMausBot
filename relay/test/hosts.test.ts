import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import type { WebSocket } from "ws";
import { HostBudgets, Hosts } from "../src/hosts.ts";
import { HeavyMeter } from "../src/splice.ts";
import { sha256 } from "../src/wire.ts";

describe("Hosts", () => {
  test("admits only hashes in the set of a host with a control socket", () => {
    const hosts = new Hosts(32);
    const hid = randomBytes(16);
    const entry = hosts.entry(hid, hid.toString("base64url"));
    const adm = sha256(randomBytes(32));
    entry.admission = [sha256(randomBytes(32)), adm];
    assert.equal(hosts.admitted(entry, adm), false, "no control socket");
    entry.control = {} as WebSocket;
    assert.equal(hosts.admitted(entry, adm), true);
    assert.equal(hosts.admitted(entry, sha256(randomBytes(32))), false);
    assert.equal(hosts.admitted(undefined, adm), false);
    entry.admission = [];
    assert.equal(hosts.admitted(entry, adm), false);
    assert.equal(hosts.admitted(entry, Buffer.alloc(32)), false, "an empty slot never matches");
  });

  test("forgets a host once it has neither control socket nor session", () => {
    const hosts = new Hosts(32);
    const hid = randomBytes(16);
    const entry = hosts.entry(hid, hid.toString("base64url"));
    entry.control = {} as WebSocket;
    hosts.release(entry);
    assert.equal(hosts.size, 1);
    entry.control = undefined;
    hosts.release(entry);
    assert.equal(hosts.size, 0);
    assert.notEqual(hosts.entry(hid, hid.toString("base64url")), entry);
  });
});

describe("HostBudgets", () => {
  test("says once when a host crosses its daily bytes, and starts over the next UTC day", () => {
    let now = 86_400 * 20_000 + 100;
    const budgets = new HostBudgets(1000, () => now);
    assert.equal(budgets.add("h", 999), false);
    assert.equal(budgets.over("h"), false);
    assert.equal(budgets.add("h", 2), true);
    assert.equal(budgets.over("h"), true);
    assert.equal(budgets.add("h", 2), false);
    now += 86_400;
    assert.equal(budgets.over("h"), false);
    assert.equal(budgets.add("h", 1000), false);
    budgets.sweep();
    assert.equal(budgets.over("h"), false);
  });
});

describe("HeavyMeter", () => {
  const window = 30 * 60_000;
  const perMs = 50e6 / 8 / 1000;

  test("flags a session above the heavy rate only once it is a window old", () => {
    const meter = new HeavyMeter(window, 50e6, 0);
    let heavy = false;
    for (let t = 0; t <= window + 30_000; t += 1000) heavy = meter.add(perMs * 1000 * 1.1, t);
    assert.equal(heavy, true);
    const young = new HeavyMeter(window, 50e6, 0);
    assert.equal(young.add(1e12, window - 1), false);
  });

  test("does not flag a session at or under the heavy rate", () => {
    const meter = new HeavyMeter(window, 50e6, 0);
    let heavy = false;
    for (let t = 1000; t <= window + 60_000; t += 1000) heavy = meter.add(perMs * 1000 * 0.95, t);
    assert.equal(heavy, false);
  });

  test("forgets bytes older than the window", () => {
    const meter = new HeavyMeter(window, 50e6, 0);
    meter.add(1e12, 0);
    assert.equal(meter.add(1, window + window / 30), false, "the burst at t=0 slid out of the window");
    assert.equal(meter.add(1, 10 * window), false);
  });
});
