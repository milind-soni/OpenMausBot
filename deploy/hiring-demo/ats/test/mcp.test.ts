import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createDesk } from "../src/desk.ts";
import { mcpHandler } from "../src/mcp.ts";
import { TOOL_SCHEMAS } from "../src/schemas.ts";
import { makeStore } from "./helpers.ts";
import { createSim } from "../src/sim.ts";

const store = makeStore();
const desk = createDesk(store);
const app = express();
app.use(express.json({ limit: "2mb" }));
app.all("/mcp", mcpHandler(desk));
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);

const client = new Client({ name: "test", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(url));

after(async () => {
  await client.close();
  server.close();
});

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: String(err) }] };
  }
}

test("lists exactly the tool table", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 27);
  assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(TOOL_SCHEMAS).sort());
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 20, `${t.name} needs a description`);
    if ("actor" in (t.inputSchema.properties ?? {})) assert.match(t.description!, /Pass actor = your exact bot name\.$/);
  }
});

test("create_requirement over MCP returns REQ-1042", async () => {
  const email = desk.receiveEmail(store.state.script.heroClientEmail);
  const res = await call("create_requirement", {
    actor: "Desk Manager", source_email_id: email.id, title: "Senior Java Developer", client: "Contoso Health",
    client_contact: "dana.whitfield@contosohealth.example.com", location: "Dallas, TX", work_mode: "hybrid", rate: 68,
    employment_type: "C2C", skills: ["Spring Boot", "AWS", "Kafka"], min_years: 8, jd: "Spring Boot, AWS, Kafka. 8+ years.",
  });
  assert.equal(res.isError, undefined);
  assert.deepEqual(JSON.parse(res.content[0]!.text), { req_id: "REQ-1042" });
});

test("DeskError comes back as isError with the message", async () => {
  const res = await call("get_candidate", { candidate_id: "CAN-9999" });
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /CAN-9999/);
});

test("schema rejects a missing actor and state is unchanged", async () => {
  const before = JSON.stringify(store.state);
  const res = await call("post_job", { req_id: "REQ-1042", boards: ["dice"] });
  assert.equal(res.isError, true);
  assert.equal(JSON.stringify(store.state), before);
});

test("read tools return JSON", async () => {
  const res = await call("search_candidates", { query: '"spring boot" AND kafka', req_id: "REQ-1042", limit: 5 });
  const body = JSON.parse(res.content[0]!.text);
  assert.equal(body.results.length, 5);
  assert.equal(typeof body.results[0].keywordScore, "number");
});

test("demo controls are offered when the server passes them, and drive the simulator", async () => {
  const demoStore = makeStore();
  const demoDesk = createDesk(demoStore);
  const demoSim = createSim(demoStore, demoDesk);
  const demoApp = express();
  demoApp.use(express.json({ limit: "2mb" }));
  demoApp.all("/mcp", mcpHandler(demoDesk, { sim: demoSim, store: demoStore }));
  const srv = demoApp.listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const c = new Client({ name: "demo", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`)));
  try {
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.equal(names.length, 30);
    for (const n of ["demo_new_requirement", "demo_next_morning", "demo_reset"]) assert.ok(names.includes(n), n);
    const run = async (name: string) => (await c.callTool({ name, arguments: { actor: "Desk Manager" } })) as ToolResult;
    const first = await run("demo_new_requirement");
    assert.equal(first.isError, undefined);
    assert.match(JSON.parse(first.content[0]!.text).email_id, /^EM-\d{4}$/);
    const again = await run("demo_new_requirement");
    assert.equal(again.isError, true);
    assert.match(again.content[0]!.text, /reset the demo/);
    assert.equal((await run("demo_next_morning")).isError, undefined);
    assert.equal((await run("demo_reset")).isError, undefined);
    assert.equal(demoStore.state.emails.length, 0);
    assert.equal((await run("demo_new_requirement")).isError, undefined);
  } finally {
    await c.close();
    demoSim.stop();
    srv.close();
  }
});
