import assert from "node:assert/strict";
import test from "node:test";

import { allowedServerOrigin, isPrivateHost, pairingPageUrl, parseServerInput, readPairingCode, serverTransport } from "./server-address.mjs";

const CODE = "ABCD-EFGH-JKLM";

test("http is accepted on private networks and refused on the open internet", () => {
  for (const host of ["192.168.1.20:8799", "10.0.0.5", "172.16.4.2:3000", "172.31.255.1", "100.101.102.103:8799", "100.64.0.1", "box.tail1234.ts.net",
    "kitchen.local", "nas.home.arpa", "hetzner-1:8799", "localhost:8799", "127.0.0.1:8799", "[::1]:8799", "169.254.10.2", "[fd12:3456::1]:8799", "[fe80::1]"]) {
    const parsed = parseServerInput(`http://${host}/pair#code=${CODE}`);
    assert.equal(parsed.ok, true, host);
    assert.deepEqual(parsed.candidates, [`http://${host}`], host);
    assert.equal(parsed.code, CODE, host);
  }
  for (const host of ["203.0.113.9:8799", "maus.example.com", "100.128.0.1", "172.32.0.1", "11.0.0.1", "8.8.8.8", "[2001:db8::1]", "box.ts.net.evil.com"]) {
    assert.deepEqual(parseServerInput(`http://${host}`), { ok: false, problem: "publicHttp", host: new URL(`http://${host}`).host }, host);
  }
});

test("isPrivateHost draws the line at the private ranges", () => {
  assert.equal(isPrivateHost("100.63.255.255"), false);
  assert.equal(isPrivateHost("100.127.255.255"), true);
  assert.equal(isPrivateHost("192.169.0.1"), false);
  assert.equal(isPrivateHost("example"), true);
  assert.equal(isPrivateHost("example.com"), false);
  assert.equal(isPrivateHost(""), false);
  assert.equal(allowedServerOrigin("http://192.168.1.20:8799"), true);
  assert.equal(allowedServerOrigin("http://maus.example.com"), false);
  assert.equal(allowedServerOrigin("https://maus.example.com"), true);
  assert.equal(allowedServerOrigin("https://user:pw@maus.example.com"), false);
});

test("a bare address tries https first, then http only when the host is private", () => {
  assert.deepEqual(parseServerInput("192.168.1.20:8799"), { ok: true, candidates: ["https://192.168.1.20:8799", "http://192.168.1.20:8799"], code: null, credential: null });
  assert.deepEqual(parseServerInput("maus.example.com").candidates, ["https://maus.example.com"]);
  assert.deepEqual(parseServerInput(" https://maus.example.com/ ").candidates, ["https://maus.example.com"]);
  assert.deepEqual(parseServerInput("hetzner-1:8799").candidates, ["https://hetzner-1:8799", "http://hetzner-1:8799"]);
  // A tailnet name alone also tries the port a computer sharing itself on the tailnet listens on.
  assert.deepEqual(parseServerInput("macmini.tail1234.ts.net").candidates, ["https://macmini.tail1234.ts.net", "http://macmini.tail1234.ts.net", "http://macmini.tail1234.ts.net:8799"]);
  assert.deepEqual(parseServerInput("macmini.tail1234.ts.net:18799").candidates, ["https://macmini.tail1234.ts.net:18799", "http://macmini.tail1234.ts.net:18799"]);
});

test("an address and a code typed apart make one pairing", () => {
  const parsed = parseServerInput("192.168.1.20:8799", " abcd efgh jklm ");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.code, CODE);
  assert.equal(pairingPageUrl("http://192.168.1.20:8799", parsed.code), `http://192.168.1.20:8799/pair#code=${CODE}`);
  assert.equal(pairingPageUrl("https://maus.example.com", null), "https://maus.example.com");
  assert.equal(parseServerInput(`https://maus.example.com/pair#code=${CODE}`, "").code, CODE);
  assert.equal(parseServerInput("https://maus.example.com/pair#code=ABCD%2DEFGH%2DJKLM").code, CODE);
  assert.equal(parseServerInput(`https://maus.example.com/pair?code=${CODE}`).code, CODE);
});

test("a code alone is moved, not refused without a word", () => {
  assert.deepEqual(parseServerInput(CODE), { ok: false, problem: "codeOnly", code: CODE });
  assert.deepEqual(parseServerInput("abcdefghjklm"), { ok: false, problem: "codeOnly", code: CODE });
});

test("the wrong kind of code says what it is, in either field", () => {
  assert.equal(parseServerInput("1234 5678").problem, "emailCode");
  assert.equal(parseServerInput("123456").problem, "oldCode");
  assert.equal(parseServerInput("omb_sess_abc").problem, "scriptKey");
  assert.equal(parseServerInput("maus.example.com", "12345678").problem, "emailCode");
  assert.equal(parseServerInput("maus.example.com", "654321").problem, "oldCode");
  assert.equal(parseServerInput("maus.example.com", "nope").problem, "notACode");
  assert.equal(parseServerInput("https://maus.example.com/pair#code=").problem, "notACode");
  assert.equal(parseServerInput("https://maus.example.com/pair#code=%").problem, "notACode");
  assert.deepEqual(readPairingCode(`omb_pair_${"a".repeat(43)}`), { kind: "credential", credential: `omb_pair_${"a".repeat(43)}` });
});

test("app links naming a server are read; a phone's link to a computer is named", () => {
  const parsed = parseServerInput(`openmausbot://pair?address=${encodeURIComponent("https://maus.example.com")}&code=${CODE}`);
  assert.deepEqual(parsed, { ok: true, candidates: ["https://maus.example.com"], code: CODE, credential: null });
  const token = `omb_pair_${"b".repeat(43)}`;
  assert.equal(parseServerInput(`openmausbot://pair?address=${encodeURIComponent("http://192.168.1.20:8799")}&token=${token}`).credential, token);
  assert.equal(parseServerInput("openmausbot://pair?address=192.168.1.20&port=8810&token=x").problem, "phoneLink");
});

test("anything that is not a server address is refused", () => {
  for (const bad of ["https:example.com", "https://a.example/other", "https://user:password@a.example", "https://a.example\\@b.example", "javascript:alert(1)", "ftp://a.example", "two words"]) {
    assert.equal(parseServerInput(bad).ok, false, bad);
  }
  assert.equal(parseServerInput("").problem, "empty");
});

test("each transport is named for the line under a saved server", () => {
  assert.equal(serverTransport("https://maus.example.com"), "https");
  assert.equal(serverTransport("https://box.tail1234.ts.net"), "tailscale");
  // Inside WireGuard: encrypted although the scheme is http.
  assert.equal(serverTransport("http://box.tail1234.ts.net:8799"), "tailscale");
  // A bare 100.64/10 address may be carrier NAT or another VPN.
  assert.equal(serverTransport("http://100.101.102.103:8799"), "private-http");
  assert.equal(serverTransport("http://192.168.1.20:8799"), "private-http");
  assert.equal(serverTransport("http://127.0.0.1:8799"), "loopback");
});
