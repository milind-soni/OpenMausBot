import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bearerMatches, Metrics } from "../src/metrics.ts";
import { sleep, splicedPair, startTestRelay } from "./helpers.ts";

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

  test("daily peaks keep the day's highest value, today's and the day before's, by UTC day", () => {
    let now = Date.parse("2026-11-06T23:59:00Z") / 1000;
    const metrics = new Metrics(() => now);
    try {
      metrics.peak("hosts_connected", 3);
      metrics.peak("hosts_connected", 7);
      metrics.peak("hosts_connected", 5);
      let text = metrics.render([]);
      assert.equal(value(text, 'relay_hosts_connected_peak{day="2026-11-06"}'), 7);
      assert.equal(value(text, 'relay_sessions_spliced_peak{day="2026-11-06"}'), 0);
      now += 120;
      metrics.peak("hosts_connected", 2);
      text = metrics.render([]);
      assert.equal(value(text, 'relay_hosts_connected_peak{day="2026-11-06"}'), 7);
      assert.equal(value(text, 'relay_hosts_connected_peak{day="2026-11-07"}'), 2);
      // What a scrape sees is held now: a day with no rise still starts from it.
      now += 86_400;
      text = metrics.render([{ name: "relay_hosts_connected", help: "h", value: 4 }]);
      assert.equal(value(text, 'relay_hosts_connected_peak{day="2026-11-08"}'), 4);
      assert.equal(value(text, 'relay_hosts_connected_peak{day="2026-11-07"}'), 2);
      assert.ok(!text.includes('day="2026-11-06"'));
      // A gap of more than a day leaves no stale "day before".
      now += 3 * 86_400;
      text = metrics.render([]);
      assert.ok(!text.includes('day="2026-11-08"'));
      assert.equal(value(text, 'relay_hosts_connected_peak{day="2026-11-11"}'), 0);
    } finally {
      metrics.close();
    }
  });

  test("a running relay's peaks follow hosts, sessions and sockets, and the spliced gauge returns to 0", async () => {
    const t = await startTestRelay();
    try {
      const { host, phone, data } = await splicedPair(t.url, t.key);
      const day = new Date().toISOString().slice(0, 10);
      const scrape = async () => {
        const response = await fetch(`http://127.0.0.1:${t.relay.port}/metrics`, { headers: { authorization: `Bearer ${"m".repeat(40)}` } });
        return response.text();
      };
      let text = await scrape();
      assert.equal(value(text, "relay_sessions_spliced"), 1);
      assert.equal(value(text, `relay_hosts_connected_peak{day="${day}"}`), 1);
      assert.equal(value(text, `relay_sessions_spliced_peak{day="${day}"}`), 1);
      assert.ok(value(text, `relay_sockets_open_peak{day="${day}"}`) >= 3);
      phone.ws.close(1000);
      await data.closeCode();
      host.control.ws.close();
      const until = performance.now() + 2_000;
      while (t.relay.ctx.hosts.connected > 0 && performance.now() < until) await sleep(20);
      text = await scrape();
      assert.equal(value(text, "relay_sessions_spliced"), 0);
      assert.equal(value(text, "relay_hosts_connected"), 0);
      assert.equal(value(text, `relay_sessions_spliced_peak{day="${day}"}`), 1);
    } finally {
      await t.stop();
    }
  });
});
