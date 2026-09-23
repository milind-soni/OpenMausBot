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

test("hosted workspace input accepts addresses and keeps valid codes only in the fragment", () => {
  for (const address of ["bots.company.com", " https://bots.company.com/ ", "https://bots.company.com:8443"]) {
    const parsed = env.parseHostedWorkspaceLink(address);
    assert.ok(parsed);
    assert.equal(parsed.code, null);
    assert.equal(parsed.url, parsed.origin);
  }
  const parsed = env.parseHostedWorkspaceLink("https://bots.company.com/pair#code=ABCD%2DEFGH%2DJKLM");
  assert.equal(parsed.code, "ABCD-EFGH-JKLM");
  assert.ok(parsed.url.includes("#code="));
  assert.ok(!parsed.origin.includes("ABCD"));
  assert.ok(env.parseHostedWorkspaceLink("http://127.0.0.1:19999"));
  for (const bad of ["", null, "ABCD-EFGH-JKLM", "https:example.com", "http://cloud.example.com", "https://a.example/other", "https://a.example/?code=SECRET", "https://a.example/pair#code=%", "https://a.example/pair#code=", "https://a.example/pair#code=%20", "https://user:password@a.example", "https://a.example\\@b.example", "javascript:alert(1)"]) {
    assert.equal(env.parseHostedWorkspaceLink(bad), null, String(bad));
  }
  assert.equal(env.parsePairingLink("https://a.example/pair#code=%"), null);
});

test("workspace shell exposes only current identity and rejects subframes and unrelated windows", () => {
  const state = { environments: [{ id: "cloud", name: "Acme", origin: "https://acme.example" }], activeId: "cloud" };
  assert.deepEqual(env.workspaceSummary(state), { local: false, name: "Acme", origin: "https://acme.example" });
  assert.deepEqual(env.workspaceSummary({ ...state, activeId: "local" }), { local: true, name: "This computer" });
  const local = "http://127.0.0.1:18799";
  const contents = { mainFrame: { url: "https://acme.example/" } };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal(env.workspaceSenderAllowed(event, contents, state, local), true);
  assert.equal(env.workspaceSenderAllowed({ ...event, sender: {} }, contents, state, local), false);
  assert.equal(env.workspaceSenderAllowed({ ...event, senderFrame: { url: "https://acme.example/frame" } }, contents, state, local), false);
  contents.mainFrame.url = "https://untrusted.example";
  assert.equal(env.workspaceSenderAllowed(event, contents, state, local), false);
  contents.mainFrame.url = local;
  assert.equal(env.workspaceSenderAllowed(event, contents, state, local), false);
  assert.equal(env.workspaceSenderAllowed(event, contents, { ...state, activeId: "local" }, local), true);
});

test("renderer links and redirects cannot switch onto the local or another saved workspace", () => {
  const local = "http://127.0.0.1:18799";
  const state = { environments: [
    { id: "cloud", name: "Acme", origin: "https://acme.example" },
    { id: "other", name: "Other", origin: "https://other.example" },
  ], activeId: "cloud" };
  assert.equal(env.workspaceNavigationAllowed("https://acme.example/pair#code=ABCD-EFGH-JKLM", state, local), true);
  for (const url of [local, "https://other.example", "https://unknown.example", "javascript:void(0)"]) {
    assert.equal(env.workspaceNavigationAllowed(url, state, local), false);
  }
  const switched = env.withActive(state, "local");
  assert.equal(env.workspaceNavigationAllowed(`${local}/?desktop-settings=workspaces`, switched, local), true);
  assert.equal(env.workspaceNavigationAllowed("https://acme.example", switched, local), false);
});

test("native workspace choices use saved IDs and connect opens settings without changing state", () => {
  const state = { environments: [{ id: "cloud", name: "Acme", origin: "https://acme.example" }], activeId: "cloud" };
  const calls = [];
  const items = env.workspaceMenuTemplate(state, { onSwitch: (id) => calls.push(["switch", id]), onConnect: () => calls.push(["settings"]), onForget: (id) => calls.push(["forget", id]) });
  assert.equal(items.find((item) => item.id === "workspace-cloud").checked, true);
  items.find((item) => item.id === "workspace-local").click();
  items.find((item) => item.id === "workspace-connect").click();
  items.find((item) => item.id === "workspace-forget").click();
  assert.deepEqual(calls, [["switch", "local"], ["settings"], ["forget", "cloud"]]);
  assert.equal(state.activeId, "cloud");
});

test("native window identity distinguishes hosted HTML, companion data, and the local workspace", () => {
  const state = { environments: [{ id: "old", name: "Old team", origin: "https://old.example" }], activeId: "old" };
  assert.equal(env.workspaceWindowTitle(state), "OpenMausBot — Hosted: Old team (old.example)");
  assert.equal(env.workspaceWindowTitle(state, { serverName: "Office", endpoint: "https://c-office.openmausbot.com" }), "OpenMausBot — Connected to: Office (c-office.openmausbot.com)");
  assert.equal(env.workspaceWindowTitle(env.withActive(state, "local")), "OpenMausBot");
});
