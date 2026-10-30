import assert from "node:assert/strict";
import test from "node:test";

import { adoptComposioId, collectConnections, ConnectionMoveError, parseConnections, releaseConnections, sendConnections } from "./cloud-connections.mjs";

const COMPUTER = { environmentId: "env-desktop-1", label: "Milind's MacBook" };
const INSTALLATION = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";
const D1 = "1".repeat(64), D2 = "2".repeat(64), D3 = "3".repeat(64);
const linearSignIn = (refresh) => ({ url: "https://mcp.linear.app/sse", state: "signed-in", tokens: { access: `a-${refresh}`, refresh } });

/** This computer's server: its list, and the private port's answers, each ask recorded. */
function computer({ connections, answers = {}, release = () => ({ released: true }), connected = {} }) {
  const asked = [];
  return {
    asked,
    json: async (route) => (route === "/api/cloud-connections" ? { computer: COMPUTER, connections, engines: [], commands: [] } : { services: connected }),
    handoff: async (what) => {
      asked.push(what);
      if (what.kind === "connection-release") return { ok: true, release: release(what) };
      if (what.kind === "composio-share") return { ok: true, share: { code: "c".repeat(64) } };
      const answer = typeof answers[what.id] === "function" ? answers[what.id]() : answers[what.id];
      if (!answer) throw new Error("This connection could not be read on this computer.");
      return { ok: true, ...answer };
    },
  };
}

/** My Cloud's own routes over the owner session, each call recorded; `reply` answers anything not set up here. */
function cloud({ connections = [], engines = [], commands = ["npx", "node"], reply = () => ({ status: 200, body: {} }), readyAfter = 0 } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    call: async (method, route, body) => {
      calls.push([method, route, body]);
      if (method === "GET" && route === "/api/cloud-connections") {
        reads++;
        return { ok: true, status: 200, body: { computer: { environmentId: "env-cloud", label: "omb-u-1" }, connections, engines: reads > readyAfter ? engines : [], commands } };
      }
      const answer = reply(method, route, body) ?? { status: 200, body: {} };
      return { ok: answer.status >= 200 && answer.status < 300, ...answer };
    },
  };
}

const writes = (target) => target.calls.filter(([method]) => method !== "GET").map(([method, route]) => `${method} ${route}`);

test("moves keys first, then MCP servers with their secrets, HighLevel and connected apps, each over My Cloud's own routes", async () => {
  const local = computer({
    connections: [
      { id: "mcp:dodo", kind: "mcp", label: "dodo", launcher: "npx" },
      { id: "composio", kind: "composio", label: "Connected apps", mode: "managed", account: "managed:aaa" },
      { id: "highlevel", kind: "highlevel", label: "HighLevel" },
      { id: "key:openrouter", kind: "key", label: "OpenRouter", for: ["openrouter"] },
    ],
    answers: {
      "mcp:dodo": { connection: { mcp: { name: "dodo", server: { command: "npx", args: ["-y", "dodo"], env: { KEY: "k" }, enabled: true } } } },
      highlevel: { connection: { highlevel: { kind: "token", accessToken: "pit-1", locationId: "loc" } } },
      "key:openrouter": { connection: { config: { openrouter: { key: "sk-or" } } } },
    },
    connected: { gmail: { connected: true }, slack: { connected: false } },
  });
  const target = cloud({ connections: [{ id: "composio", kind: "composio", label: "Connected apps", mode: "managed", account: "managed:bbb", installationId: INSTALLATION }],
    engines: ["openrouter"], reply: (method, route) => (route === "/api/cloud-connections/connected-apps" ? { status: 200, body: { shared: true } } : undefined) });
  const progress = [];
  const result = await sendConnections(await collectConnections(local), target, { local, onProgress: (step) => progress.push(step) });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(writes(target), ["PUT /api/cloud-connections/held-keys", "PATCH /api/config", "POST /api/mcp/servers", "PATCH /api/mcp/servers/dodo", "PUT /api/cloud-connections/highlevel", "POST /api/cloud-connections/connected-apps"]);
  assert.deepEqual(result.held, [], "a Cloud with no trial credit to keep runs the key at once");
  assert.deepEqual(target.calls.find(([, route]) => route === "/api/mcp/servers")[2], { name: "dodo", command: "npx", args: ["-y", "dodo"], env: { KEY: "k" } });
  assert.deepEqual(target.calls.find(([, route]) => route === "/api/cloud-connections/connected-apps")[2], { share: "c".repeat(64), apps: ["gmail"] });
  assert.deepEqual(local.asked.find((what) => what.kind === "composio-share"), { kind: "composio-share", for: INSTALLATION });
  assert.deepEqual(result.moved.map((item) => item.id), ["key:openrouter", "mcp:dodo", "highlevel", "composio"]);
  assert.deepEqual(progress.map((step) => `${step.done}/${step.total} ${step.label}`), ["1/4 OpenRouter", "2/4 dodo", "3/4 HighLevel", "4/4 Connected apps"]);
});

test("a trial's Cloud keeps a moved key saved but unused while its Claude credit lasts, asked before the key is saved, and the move goes on without waiting for it", async () => {
  const local = computer({
    connections: [{ id: "key:openrouter", kind: "key", label: "OpenRouter", for: ["openrouter"] }, { id: "mcp:dodo", kind: "mcp", label: "dodo", launcher: "npx" }],
    answers: {
      "key:openrouter": { connection: { config: { openrouter: { key: "sk-or" } } } },
      "mcp:dodo": { connection: { mcp: { name: "dodo", server: { command: "npx", args: ["-y", "dodo"], env: {}, enabled: true } } } },
    },
  });
  const target = cloud({ engines: [], reply: (method, route) => (route === "/api/cloud-connections/held-keys" ? { status: 200, body: { held: true } } : undefined) });
  const started = Date.now();
  const result = await sendConnections(await collectConnections(local), target, { local, waitMs: 5_000 });
  assert.ok(Date.now() - started < 2_000, "an engine kept unused is never waited for");
  assert.deepEqual(writes(target).slice(0, 2), ["PUT /api/cloud-connections/held-keys", "PATCH /api/config"]);
  assert.deepEqual(target.calls.find(([, route]) => route === "/api/cloud-connections/held-keys")[2], { for: ["openrouter"] });
  assert.deepEqual(result.held, [{ id: "key:openrouter", label: "OpenRouter" }]);
  assert.deepEqual(result.moved.map((item) => item.id), ["key:openrouter", "mcp:dodo"]);
});

test("a server that needs this computer goes marked as running on it, and a server already on My Cloud is replaced", async () => {
  const server = (name, extra = {}) => ({ connection: { mcp: { name, server: { type: "http", url: `https://${name}.example/mcp`, headers: {}, enabled: true, ...extra } } } });
  const local = computer({
    connections: [
      { id: "mcp:notes", kind: "mcp", label: "notes", runsHere: true },
      { id: "mcp:fetch", kind: "mcp", label: "fetch", launcher: "uvx" },
      { id: "mcp:lent", kind: "mcp", label: "lent" },
      { id: "mcp:docs", kind: "mcp", label: "docs" },
    ],
    answers: {
      "mcp:notes": server("notes"),
      "mcp:fetch": { connection: { mcp: { name: "fetch", server: { command: "uvx", args: ["mcp-server-fetch"], env: {}, enabled: false } } } },
      "mcp:lent": server("lent", { runsOn: { environmentId: "env-other", label: "Studio iMac" } }),
      "mcp:docs": server("docs"),
    },
  });
  const target = cloud({ connections: [{ id: "mcp:docs", kind: "mcp", label: "docs" }] });
  const result = await sendConnections(await collectConnections(local), target, { local });
  const body = (route) => target.calls.find(([, at]) => at === route)?.[2];
  const added = target.calls.filter(([method, route]) => method === "POST" && route === "/api/mcp/servers").map(([, , sent]) => [sent.name, sent.runsOn ?? null]);
  assert.deepEqual(added, [["notes", COMPUTER], ["fetch", COMPUTER], ["lent", { environmentId: "env-other", label: "Studio iMac" }]]);
  assert.deepEqual(body("/api/mcp/servers/docs"), { type: "http", url: "https://docs.example/mcp", headers: {}, enabled: true, runsOn: null });
  assert.equal(target.calls.some(([method, route]) => method === "PATCH" && route === "/api/mcp/servers/fetch"), false, "a server switched off here stays off there");
  assert.deepEqual(result.runsHere, [{ id: "mcp:notes", label: "notes" }, { id: "mcp:fetch", label: "fetch", needs: "uvx" }, { id: "mcp:lent", label: "lent" }]);
  assert.deepEqual(result.moved.map((item) => item.id), ["mcp:docs"]);
});

test("a sign-in moves and this computer lets go of it; one that refreshed meanwhile goes again first", async () => {
  let refresh = "r1";
  const local = computer({
    connections: [{ id: "mcp:linear", kind: "mcp", label: "linear", signIn: true }],
    answers: { "mcp:linear": () => ({ connection: { mcp: { name: "linear", server: { type: "http", url: "https://mcp.linear.app/sse", headers: {}, enabled: true }, signIn: linearSignIn(refresh) } },
      digest: refresh === "r1" ? D1 : D2 }) },
    release: (what) => (what.digest === (refresh === "r1" ? D1 : D2) ? { released: true } : { changed: true }),
  });
  const target = cloud({ reply: (method, route) => (route.startsWith("/api/cloud-connections/mcp/linear/sign-in") ? { status: 200, body: { adopted: true } } : undefined) });
  // It refreshed here between being read and being let go of.
  const read = local.handoff;
  local.handoff = async (what) => { const answer = await read(what); if (what.kind === "connection" && refresh === "r1") refresh = "r2"; return answer; };
  const result = await sendConnections(await collectConnections(local), target, { local });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(writes(target), ["POST /api/mcp/servers", "PATCH /api/mcp/servers/linear", "PUT /api/cloud-connections/mcp/linear/sign-in",
    `PUT /api/cloud-connections/mcp/linear/sign-in?replaces=${D1}`]);
  assert.equal(target.calls.at(-1)[2].tokens.refresh, "r2");
  assert.deepEqual(local.asked.filter((what) => what.kind === "connection-release"), [
    { kind: "connection-release", id: "mcp:linear", digest: D1 }, { kind: "connection-release", id: "mcp:linear", digest: D2 }]);
  assert.deepEqual(result.release, []);
});

test("My Cloud keeps a sign-in of its own; with release off the result lists what this computer still holds, for later", async () => {
  const connections = [{ id: "mcp:linear", kind: "mcp", label: "linear", signIn: true }, { id: "highlevel", kind: "highlevel", label: "HighLevel", signIn: true }];
  const answers = {
    "mcp:linear": { connection: { mcp: { name: "linear", server: { type: "http", url: "https://mcp.linear.app/sse", headers: {}, enabled: true }, signIn: linearSignIn("r1") } }, digest: D1 },
    highlevel: { connection: { highlevel: { kind: "oauth", accessToken: "a", refreshToken: "r", locationId: "loc" } }, digest: D3 },
  };
  const keeps = computer({ connections, answers });
  const own = cloud({ connections: [{ id: "mcp:linear", kind: "mcp", label: "linear" }], reply: (method, route) => (route.includes("sign-in") || route.endsWith("/highlevel") ? { status: 200, body: { kept: true } } : undefined) });
  const kept = await sendConnections(await collectConnections(keeps), own, { local: keeps });
  assert.deepEqual(kept.kept.map((item) => item.id), ["mcp:linear", "highlevel"]);
  assert.deepEqual(kept.moved.map((item) => item.id), ["mcp:linear"], "its definition went; its sign-in there is its own");
  assert.equal(keeps.asked.some((what) => what.kind === "connection-release"), false);

  const holds = computer({ connections, answers });
  const takes = cloud({ reply: (method, route) => (route.includes("sign-in") || route.endsWith("/highlevel") ? { status: 200, body: { adopted: true } } : undefined) });
  const held = await sendConnections(await collectConnections(holds), takes, { local: holds, release: false });
  assert.deepEqual(held.release, [{ id: "mcp:linear", label: "linear", digest: D1 }, { id: "highlevel", label: "HighLevel", digest: D3 }]);
  assert.equal(holds.asked.some((what) => what.kind === "connection-release"), false);
  assert.deepEqual(await releaseConnections(held.release, { local: holds, target: takes }), []);
  assert.deepEqual(holds.asked.filter((what) => what.kind === "connection-release").map((what) => what.id), ["mcp:linear", "highlevel"]);
});

test("one connection failing never stops the others; a refusal trying again can't fix is final", async () => {
  const local = computer({
    connections: [{ id: "key:openai", kind: "key", label: "OpenAI", for: ["openai"] }, { id: "key:groq", kind: "key", label: "Groq", for: ["groq"] },
      { id: "mcp:gone", kind: "mcp", label: "gone" }, { id: "mcp:docs", kind: "mcp", label: "docs" }],
    answers: { "key:openai": { connection: { config: { openai: { key: "k" } } } }, "key:groq": { connection: { config: { groq: { key: "g" } } } },
      "mcp:docs": { connection: { mcp: { name: "docs", server: { type: "http", url: "https://docs.example/mcp", headers: {}, enabled: true } } } } },
  });
  let config = 0;
  const target = cloud({ reply: (method, route) => {
    if (route === "/api/config") return ++config === 1 ? { status: 403, body: { error: "This workspace's AI is managed by its organization." } } : { status: 503, body: {} };
    return undefined;
  } });
  const result = await sendConnections(await collectConnections(local), target, { local, waitMs: 0 });
  assert.deepEqual(result.failed, [
    { id: "key:openai", label: "OpenAI", message: "My Cloud said: This workspace's AI is managed by its organization.", final: true },
    { id: "key:groq", label: "Groq", message: "My Cloud did not take the Groq key.", final: false },
    { id: "mcp:gone", label: "gone", message: "gone could not be read on this computer.", final: false },
  ]);
  assert.deepEqual(result.moved.map((item) => item.id), ["mcp:docs"]);
});

test("waits for My Cloud to run the engines whose keys went, before anything that follows them", async () => {
  const local = computer({ connections: [{ id: "key:openrouter", kind: "key", label: "OpenRouter", for: ["openrouter"] }, { id: "mcp:docs", kind: "mcp", label: "docs" }],
    answers: { "key:openrouter": { connection: { config: { openrouter: { key: "k" } } } },
      "mcp:docs": { connection: { mcp: { name: "docs", server: { type: "http", url: "https://docs.example/mcp", headers: {}, enabled: false } } } } } });
  const target = cloud({ engines: ["openrouter"], readyAfter: 2 });
  await sendConnections(await collectConnections(local), target, { local, waitMs: 5_000 });
  const order = target.calls.map(([method, route]) => `${method} ${route}`);
  const ready = order.lastIndexOf("GET /api/cloud-connections");
  assert.ok(ready > order.indexOf("PATCH /api/config") && ready < order.indexOf("POST /api/mcp/servers"), order.join(", "));
  assert.equal(order.filter((call) => call === "GET /api/cloud-connections").length, 3);
});

test("connected apps: the same account already, the person's own project, a Cloud not ready, and one that keeps its own", async () => {
  const here = { id: "composio", kind: "composio", label: "Connected apps", mode: "managed", account: "managed:aaa" };
  const local = computer({ connections: [], answers: { composio: { connection: { composio: { apiKey: "ck", userId: "u1" } } } }, connected: { gmail: { connected: true } } });
  const quiet = cloud();
  assert.deepEqual(await adoptComposioId(quiet, { local, here, there: { ...here, installationId: INSTALLATION } }), { shared: true });
  assert.deepEqual(quiet.calls, []);
  await assert.rejects(adoptComposioId(quiet, { local, here, there: null }), (error) => error instanceof ConnectionMoveError && error.code === "not_ready" && !error.final);

  const keeps = cloud({ reply: () => ({ status: 200, body: { kept: true, missing: ["gmail", "BAD SLUG"] } }) });
  assert.deepEqual(await adoptComposioId(keeps, { local, here: { ...here, mode: "own", account: "own:x" }, there: null }), { kept: true, missing: ["gmail"] });
  assert.deepEqual(keeps.calls[0], ["POST", "/api/cloud-connections/connected-apps", { apiKey: "ck", userId: "u1", apps: ["gmail"] }]);
});

test("a Cloud too old for connections says so; one that does not answer, too; this computer must list its own", async () => {
  const local = computer({ connections: [] });
  const old = { call: async () => ({ ok: false, status: 404, body: {} }) };
  await assert.rejects(sendConnections({ computer: COMPUTER, connections: [] }, old, { local }), (error) => error.code === "outdated");
  const down = { call: async () => { throw new Error("offline"); } };
  await assert.rejects(sendConnections({ computer: COMPUTER, connections: [] }, down, { local }), (error) => error.code === "unreachable");
  await assert.rejects(collectConnections({ json: async () => ({ nope: true }) }), (error) => error.code === "local");
});

test("a server's list keeps only connections of the known shape", () => {
  const parsed = parseConnections({ computer: COMPUTER, engines: ["openrouter", "bad engine!"], commands: ["npx", "rm -rf"], connections: [
    { id: "mcp:dodo", kind: "mcp", label: "dodo", launcher: "npx", runsHere: true, extra: "x" },
    { id: "mcp:dodo", kind: "key", label: "mismatched kind" },
    { id: "../etc", kind: "mcp", label: "bad id" },
    { id: "composio", kind: "composio", label: "Connected apps", mode: "managed", account: "managed:a", installationId: "not-a-uuid" },
  ] });
  assert.deepEqual(parsed, { computer: COMPUTER, engines: ["openrouter"], commands: ["npx"], connections: [
    { id: "mcp:dodo", kind: "mcp", label: "dodo", runsHere: true, launcher: "npx" },
    { id: "composio", kind: "composio", label: "Connected apps", mode: "managed", account: "managed:a" },
  ] });
  assert.equal(parseConnections({ computer: { environmentId: "../x", label: "Mac" }, connections: [] }), null);
});
