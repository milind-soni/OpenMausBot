import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const env = require("./environments.cjs");

test("origins are bare http(s) origins, nothing else", () => {
  assert.equal(env.normalizeOrigin("https://mini.tail1234.ts.net/pair#code=x"), "https://mini.tail1234.ts.net");
  assert.equal(env.normalizeOrigin("http://192.168.1.20:8799"), "http://192.168.1.20:8799");
  assert.equal(env.normalizeOrigin("HTTPS://Mini.Example:443/"), "https://mini.example");
  for (const bad of ["ftp://x", "mini.example", "https://user:pw@host", "", 42, null]) assert.equal(env.normalizeOrigin(bad), null, String(bad));
});

test("a pairing link keeps its code in the hash; a code anywhere else is refused", () => {
  assert.deepEqual(env.parsePairingLink("https://mini.example/pair#code=ABCD-EFGH-JKLM"), {
    origin: "https://mini.example",
    code: "ABCD-EFGH-JKLM",
    url: "https://mini.example/pair#code=ABCD-EFGH-JKLM",
  });
  assert.deepEqual(env.parsePairingLink("  https://mini.example  "), { origin: "https://mini.example", code: null, url: "https://mini.example" });
  assert.equal(env.parsePairingLink("https://mini.example/?code=ABCD"), null);
  assert.equal(env.parsePairingLink("not a link"), null);
});

test("self-hosted pairing supports custom HTTPS and Cloudflare names without Tailscale", () => {
  for (const origin of ["https://bots.example.com", "https://example.trycloudflare.com", "https://c-example.openmausbot.com"]) {
    const link = `${origin}/pair#code=ABCD-EFGH-JKLM`;
    assert.deepEqual(env.parsePairingLink(link), {
      origin, code: "ABCD-EFGH-JKLM", url: link,
    });
    const saved = env.withEnvironment({ environments: [], activeId: "local" }, { origin, name: "My server" }, () => "fixture");
    assert.equal(saved.environments[0].origin, origin);
    assert.ok(!env.serializeEnvironments(saved).includes("ABCD"), "pairing codes must not enter saved server records");
  }
});

test("persisted state parses defensively and never resurrects Local as a remote", () => {
  const parsed = env.parseEnvironments(
    JSON.stringify({
      environments: [
        { id: "a1", name: "  Cab   mini ", origin: "https://mini.example/" },
        { id: "local", name: "sneaky", origin: "https://evil.example" },
        { id: "dup", name: "again", origin: "https://mini.example" },
        { id: "b2", origin: "http://10.0.0.5:8799" },
        { id: "bad id!", origin: "https://x.example" },
        { id: "c3", origin: "ftp://nope" },
      ],
      activeId: "b2",
    }),
  );
  assert.deepEqual(parsed, {
    environments: [
      { id: "a1", name: "Cab mini", origin: "https://mini.example" },
      { id: "b2", name: "10.0.0.5:8799", origin: "http://10.0.0.5:8799" },
    ],
    activeId: "b2",
  });
  assert.deepEqual(env.parseEnvironments("{not json"), { environments: [], activeId: "local" });
  assert.deepEqual(env.parseEnvironments({ environments: [], activeId: "ghost" }), { environments: [], activeId: "local" });
  assert.deepEqual(env.parseEnvironments(env.serializeEnvironments(parsed)), parsed);
});

test("adding the same server twice updates the name instead of duplicating; forgetting the active one falls back to Local", () => {
  let ids = 0;
  const makeId = () => `id${++ids}`;
  let state = { environments: [], activeId: "local" };
  state = env.withEnvironment(state, { origin: "https://mini.example/pair#code=X", name: "" }, makeId);
  state = env.withEnvironment(state, { origin: "https://mini.example", name: "Cab mini" }, makeId);
  state = env.withEnvironment(state, { origin: "nonsense" }, makeId);
  assert.deepEqual(state.environments, [{ id: "id1", name: "Cab mini", origin: "https://mini.example" }]);
  state = env.withActive(state, "id1");
  assert.equal(env.activeEnvironment(state)?.origin, "https://mini.example");
  assert.equal(env.withActive(state, "nope"), state);
  assert.deepEqual([...env.allowedOrigins(state, "http://127.0.0.1:8799")], ["http://127.0.0.1:8799", "https://mini.example"]);
  state = env.withoutEnvironment(state, "id1");
  assert.deepEqual(state, { environments: [], activeId: "local" });
  assert.equal(env.activeEnvironment(state), null);
});
