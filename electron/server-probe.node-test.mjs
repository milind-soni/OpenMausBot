import assert from "node:assert/strict";
import test from "node:test";

import { createServerConnect, probeServer } from "./server-probe.mjs";

const descriptor = (environmentId, label = "hetzner-1") => new Response(JSON.stringify({ environmentId, label, version: "0.1.147" }), { headers: { "content-type": "application/json" } });
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });

function fakeFetch(answers) {
  const asked = [];
  const fetch = async (url) => {
    asked.push(new URL(url).origin);
    const answer = answers[new URL(url).origin];
    if (!answer) throw refused();
    if (answer instanceof Error) throw answer;
    return answer();
  };
  return { fetch, asked };
}

test("a private address over http is found after https fails, and names the server", async () => {
  const { fetch, asked } = fakeFetch({ "http://192.168.1.20:8799": () => descriptor("env-a") });
  const found = await probeServer({ address: "192.168.1.20:8799", code: "abcd-efgh-jklm", fetch });
  assert.deepEqual(asked, ["https://192.168.1.20:8799", "http://192.168.1.20:8799"]);
  assert.deepEqual(found, { outcome: "found", origin: "http://192.168.1.20:8799", label: "hetzner-1", version: "0.1.147", transport: "private-http", code: "ABCD-EFGH-JKLM", credential: null });
});

test("failures are sorted into what the person can fix", async () => {
  assert.deepEqual(await probeServer({ address: "http://192.168.1.50:8799", fetch: fakeFetch({}).fetch }), { outcome: "problem", problem: "unreachable", host: "192.168.1.50:8799", reason: "refused" });
  const dns = Object.assign(new Error("net::ERR_NAME_NOT_RESOLVED"));
  assert.equal((await probeServer({ address: "maus.example.com", fetch: fakeFetch({ "https://maus.example.com": dns }).fetch })).problem, "dns");
  const cert = new Error("net::ERR_CERT_AUTHORITY_INVALID");
  assert.equal((await probeServer({ address: "maus.example.com", fetch: fakeFetch({ "https://maus.example.com": cert }).fetch })).problem, "certificate");
  const other = () => new Response("<html>", { status: 200 });
  assert.equal((await probeServer({ address: "maus.example.com", fetch: fakeFetch({ "https://maus.example.com": other }).fetch })).problem, "notMausBot");
  assert.deepEqual(await probeServer({ address: "http://203.0.113.9", fetch: fakeFetch({}).fetch }), { outcome: "problem", problem: "publicHttp", host: "203.0.113.9" });
  assert.deepEqual(await probeServer({ address: "ABCD-EFGH-JKLM", fetch: fakeFetch({}).fetch }), { outcome: "problem", problem: "codeOnly", code: "ABCD-EFGH-JKLM" });
});

test("a link to this computer is caught: nothing there, or this app's own workspace", async () => {
  assert.deepEqual(await probeServer({ address: "http://127.0.0.1:8799/pair#code=ABCD-EFGH-JKLM", fetch: fakeFetch({}).fetch }), { outcome: "problem", problem: "loopback", host: "127.0.0.1:8799" });
  const own = fakeFetch({ "http://127.0.0.1:18799": () => descriptor("mine") });
  assert.equal((await probeServer({ address: "http://127.0.0.1:18799", fetch: own.fetch, ownEnvironmentId: async () => "mine" })).problem, "loopback");
  const other = fakeFetch({ "http://127.0.0.1:8799": () => descriptor("a-server-here") });
  assert.equal((await probeServer({ address: "http://127.0.0.1:8799", fetch: other.fetch, ownEnvironmentId: async () => "mine" })).outcome, "found");
});

test("connecting opens only the server it found; a pasted link asks first and throws the problem's sentence", async () => {
  const opened = [];
  const asked = [];
  const make = (answer) => createServerConnect({ fetch: fakeFetch({ "http://192.168.1.20:8799": () => descriptor("env-a") }).fetch, ownEnvironmentId: async () => null,
    ask: async (found) => { asked.push(found.label); return answer; }, open: (found, name) => opened.push([found.origin, found.code, name]), t: (key, params) => `${key} ${params.host}` });
  assert.deepEqual(await make(true).connect("http://192.168.1.20:8799", "abcd-efgh-jklm"), { outcome: "connected", label: "hetzner-1" });
  assert.deepEqual(opened.pop(), ["http://192.168.1.20:8799", "ABCD-EFGH-JKLM", undefined]);
  assert.equal((await make(true).connect("http://192.168.1.50:8799")).problem, "unreachable");
  assert.equal(await make(false).connectAsking("http://192.168.1.20:8799/pair#code=ABCD-EFGH-JKLM"), false);
  assert.deepEqual([asked, opened], [["hetzner-1"], []]);
  assert.equal(await make(true).connectAsking("http://192.168.1.20:8799/pair#code=ABCD-EFGH-JKLM", "Kitchen"), true);
  assert.deepEqual(opened.pop(), ["http://192.168.1.20:8799", "ABCD-EFGH-JKLM", "Kitchen"]);
  await assert.rejects(make(true).connectAsking("http://203.0.113.9"), /native\.connect\.publicHttp 203\.0\.113\.9/);
});
