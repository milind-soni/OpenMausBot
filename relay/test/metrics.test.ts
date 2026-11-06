import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bearerMatches, Metrics } from "../src/metrics.ts";
import { sleep } from "./helpers.ts";

const value = (text: string, name: string) => Number(new RegExp(`^${name.replace(/[{}"]/g, "\\$&")} (\\S+)$`, "m").exec(text)?.[1]);

describe("metrics", () => {
  test("the bearer must match in full", () => {
    const token = "t".repeat(40);
    assert.equal(bearerMatches(`Bearer ${token}`, token), true);
    assert.equal(bearerMatches(`Bearer ${token}x`, token), false);
    assert.equal(bearerMatches(`Bearer ${token.slice(1)}`, token), false);
    assert.equal(bearerMatches(token, token), false);
    assert.equal(bearerMatches("Bearer ", token), false);
    assert.equal(bearerMatches(undefined, token), false);
  });

  test("counters render with their labels, and unlabelled ones start at 0", () => {
    const metrics = new Metrics();
    try {
      metrics.inc("relay_closes_total", 4404);
      metrics.inc("relay_closes_total", 4404);
      metrics.inc("relay_bytes_total", "up", 1_000);
      const text = metrics.render([{ name: "relay_hosts_connected", help: "h", value: 3 }]);
      assert.equal(value(text, 'relay_closes_total{code="4404"}'), 2);
      assert.equal(value(text, 'relay_bytes_total{dir="up"}'), 1_000);
      assert.equal(value(text, "relay_sessions_total"), 0);
      assert.equal(value(text, "relay_hosts_connected"), 3);
      assert.match(text, /^# TYPE relay_closes_total counter$/m);
    } finally {
      metrics.close();
    }
  });

  test("a blocked event loop shows as lag in the next scrape, and only there", async () => {
    const metrics = new Metrics();
    try {
      await sleep(250);
      metrics.render([]);
      const until = performance.now() + 300;
      while (performance.now() < until) {}
      await sleep(250);
      const blocked = metrics.render([]);
      assert.ok(value(blocked, "relay_event_loop_lag_max_seconds") >= 0.2, blocked);
      await sleep(250);
      assert.ok(value(metrics.render([]), "relay_event_loop_lag_max_seconds") < 0.1);
    } finally {
      metrics.close();
    }
  });
});
