import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addressKey, clientKey, IpLimiter, TokenBucket } from "../src/limits.ts";

describe("clientKey", () => {
  test("trusts X-Forwarded-For only from 127.0.0.1, and only its last entry", () => {
    assert.equal(clientKey("203.0.113.9", "198.51.100.1"), "203.0.113.9");
    assert.equal(clientKey("::1", "198.51.100.1"), "0000:0000:0000:0000::/64");
    assert.equal(clientKey("127.0.0.1", "198.51.100.1"), "198.51.100.1");
    assert.equal(clientKey("::ffff:127.0.0.1", "198.51.100.1"), "198.51.100.1");
    assert.equal(clientKey("127.0.0.1", "10.0.0.1, 198.51.100.1"), "198.51.100.1");
    assert.equal(clientKey("127.0.0.1", ["10.0.0.1", "198.51.100.2"]), "198.51.100.2");
    assert.equal(clientKey("127.0.0.1", undefined), "127.0.0.1");
    assert.equal(clientKey("127.0.0.1", "not-an-address"), undefined);
    assert.equal(clientKey("127.0.0.1", "198.51.100.1, "), undefined);
    assert.equal(clientKey(undefined, "198.51.100.1"), undefined);
  });

  test("groups IPv6 by /64 and unwraps IPv4-mapped addresses", () => {
    const key = addressKey("2001:db8:1:2:3:4:5:6");
    assert.equal(key, "2001:0db8:0001:0002::/64");
    assert.equal(addressKey("2001:db8:1:2::9"), key);
    assert.equal(addressKey("2001:DB8:1:2:ffff::1%eth0"), key);
    assert.notEqual(addressKey("2001:db8:1:3::1"), key);
    assert.equal(addressKey("::"), "0000:0000:0000:0000::/64");
    assert.equal(addressKey("::ffff:192.0.2.7"), "192.0.2.7");
    assert.equal(addressKey("64:ff9b::192.0.2.7"), "0064:ff9b:0000:0000::/64");
    assert.equal(clientKey("127.0.0.1", "2001:db8:1:2::77"), key);
  });
});

describe("TokenBucket", () => {
  test("starts full, refuses when empty, refills with time and caps at capacity", () => {
    let now = 0;
    const bucket = new TokenBucket(3, 1 / 1000, () => now);
    assert.ok(bucket.take() && bucket.take() && bucket.take());
    assert.equal(bucket.take(), false);
    now += 1000;
    assert.ok(bucket.take());
    assert.equal(bucket.take(), false);
    now += 60_000;
    assert.ok(bucket.full);
  });

  test("spend goes into debt and says how long the debt lasts", () => {
    let now = 0;
    const bucket = new TokenBucket(100, 10 / 1000, () => now);
    assert.equal(bucket.spend(100), 0);
    assert.equal(bucket.spend(50), 5000);
    now += 5000;
    assert.equal(bucket.spend(0), 0);
  });
});

describe("IpLimiter", () => {
  test("allows 60 new sockets a minute per key, then refills one a second", () => {
    let now = 0;
    const limiter = new IpLimiter(60, 1000, () => now);
    for (let i = 0; i < 60; i++) assert.equal(limiter.admit("a"), "ok");
    assert.equal(limiter.admit("a"), "rate");
    assert.equal(limiter.admit("b"), "ok", "another key has its own bucket");
    now += 1000;
    assert.equal(limiter.admit("a"), "ok");
    assert.equal(limiter.admit("a"), "rate");
  });

  test("caps open sockets per key and frees a slot on release", () => {
    const limiter = new IpLimiter(1000, 2, () => 0);
    assert.equal(limiter.admit("a"), "ok");
    assert.equal(limiter.admit("a"), "ok");
    assert.equal(limiter.admit("a"), "open");
    limiter.release("a");
    assert.equal(limiter.admit("a"), "ok");
  });

  test("sweeps only keys with nothing open and a full bucket", () => {
    let now = 0;
    const limiter = new IpLimiter(60, 10, () => now);
    limiter.admit("open");
    limiter.admit("closed");
    limiter.release("closed");
    limiter.sweep();
    assert.equal(limiter.size, 2, "closed's bucket is not full yet");
    now += 60_000;
    limiter.sweep();
    assert.equal(limiter.size, 1);
  });
});
