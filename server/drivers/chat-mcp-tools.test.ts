import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { augmentedPath } from "../env-path.ts";
import { ChatToolSessionError, mountChatTools, type ChatToolSession } from "./chat-mcp-tools.ts";
import type { ToolScope } from "../../shared/tool-scope.ts";
import { startFakeHttpMcp } from "../testing/fake-http-mcp-server.ts";
import { whopLikeCatalog } from "../testing/whop-like-catalog.ts";

const dirs: string[] = [];
const sessions: ChatToolSession[] = [];
const controllers: AbortController[] = [];
const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };

function fixture(body = "", toolSchema: Record<string, unknown> = schema) {
  const dir = mkdtempSync(join(tmpdir(), "omb-chat-mcp-"));
  dirs.push(dir);
  const script = join(dir, "fake-mcp.mjs");
  const receipt = join(dir, "receipt.json");
  writeFileSync(script, `#!/usr/bin/env node
    import { writeFileSync } from "node:fs";
    import { spawn } from "node:child_process";
    const receipt = process.env.RECEIPT;
    const schema = ${JSON.stringify(toolSchema)};
    const calls = [];
    const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
    const reply = (message, result) => send({jsonrpc:"2.0",id:message.id,result});
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line);
        calls.push(message);
        writeFileSync(receipt, JSON.stringify({pid:process.pid,path:process.env.PATH,omb:Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("OMB_"))),calls}));
        ${body}
        if (message.method === "initialize") reply(message, {protocolVersion:"2024-11-05",capabilities:{tools:{}}});
        else if (message.method === "tools/list") reply(message, {tools:[{name:"write",description:"Fixture write",inputSchema:schema}]});
        else if (message.method === "tools/call") reply(message, {content:[{type:"text",text:"recorded:" + message.params.arguments.value}]});
      }
    });
  `);
  chmodSync(script, 0o755);
  const controller = new AbortController();
  controllers.push(controller);
  const server: { command: string; args: string[]; env: Record<string, string> } = { command: script, args: [], env: { RECEIPT: receipt } };
  return {
    dir, receipt, controller, server,
    read: () => JSON.parse(readFileSync(receipt, "utf8")) as { pid: number; path: string; omb: Record<string, string>; calls: Array<{ method: string; params?: { name?: string; arguments?: unknown } }> },
    async mount(computerUse = false, localComputer = false, toolScope?: ToolScope) {
      const session = await mountChatTools(localComputer ? { localComputer: server } : { custom: { audit: server } }, controller.signal, computerUse, toolScope);
      sessions.push(session);
      return session;
    },
  };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("Chat MCP session", () => {
  it("starts no server when the owner selected no MCP tools", async () => {
    const f = fixture();
    const session = await f.mount(false, false, { allow: ["native:ask_user"] });
    expect(session.definitions).toEqual([]);
    expect(existsSync(f.receipt)).toBe(false);
  });

  it.each([undefined, { allow: ["mcp:data:write"] }])("mounts Data without computer access and preserves selected tool arguments (%j)", async (scope) => {
    const f = fixture();
    const session = await mountChatTools({ data: f.server }, f.controller.signal, false, scope);
    sessions.push(session);
    expect(session.definitions).toEqual([{ type: "function", function: { name: "data_write", description: "Fixture write", parameters: schema } }]);
    await expect(session.execute("data_write", { value: "query receipt" }, f.controller.signal)).resolves.toEqual({ text: "recorded:query receipt", ok: true });
    expect(f.read().calls.at(-1)).toMatchObject({ method: "tools/call", params: { name: "write", arguments: { value: "query receipt" } } });
  });

  it("does not start Data when the owner's tool selection excludes it", async () => {
    const f = fixture();
    const session = await mountChatTools({ data: f.server }, f.controller.signal, false, { allow: ["native:ask_user"] });
    sessions.push(session);
    expect(session.definitions).toEqual([]);
    expect(existsSync(f.receipt)).toBe(false);
  });

  it("filters original identities before catalog limits, alias conversion and schema compilation", async () => {
    const f = fixture(`if (message.method === "tools/list") {
      reply(message, {tools:[
        {name:"read-notes",inputSchema:schema},
        {name:"read_notes",inputSchema:{$ref:"https://example.invalid/private"}},
        ...Array.from({length:129}, (_,i) => ({name:"excluded"+i,inputSchema:{type:"object"},description:"withheld-description"}))
      ]}); return;
    }`);
    const session = await f.mount(false, false, { allow: ["mcp:audit:read-notes"] });
    expect(session.definitions).toEqual([{ type: "function", function: { name: "audit_read_notes", description: "Configured MCP tool", parameters: schema } }]);
    await expect(session.execute("audit_read_notes_2", { value: "blocked" }, f.controller.signal)).rejects.toThrow("not advertised");
    expect(f.read().calls.filter((call) => call.method === "tools/call")).toEqual([]);
    await session.execute("audit_read_notes", { value: "allowed" }, f.controller.signal);
    expect(f.read().calls.filter((call) => call.method === "tools/call").map((call) => call.params)).toEqual([{ name: "read-notes", arguments: { value: "allowed" } }]);
  });

  it.each(["http", "sse"] as const)("executes only selected tools through a custom %s server", async (transport) => {
    const remote = await startFakeHttpMcp({ transport, requireHeader: { name: "authorization", value: "Bearer synthetic" }, tools: [
      { name: "read", inputSchema: schema }, { name: "write", inputSchema: schema },
    ] });
    const controller = new AbortController(); controllers.push(controller);
    let session: ChatToolSession | undefined;
    try {
      session = await mountChatTools({ custom: { mail: { type: transport, url: remote.url, headers: { authorization: "Bearer synthetic" } } } }, controller.signal, false, { allow: ["mcp:mail:read"] });
      expect(session.definitions.map((tool) => tool.function.name)).toEqual(["mail_read"]);
      await expect(session.execute("mail_write", { value: "blocked" }, controller.signal)).rejects.toThrow("not advertised");
      expect(remote.calls).toEqual([]);
      await expect(session.execute("mail_read", { value: "selected" }, controller.signal)).resolves.toMatchObject({ ok: true, text: "remote execution recorded" });
      expect(remote.calls).toEqual([{ name: "read", arguments: { value: "selected" } }]);
    } finally { await session?.close(); await remote.close(); }
  });

  it("rejects corrupt selection before starting any MCP process", async () => {
    const f = fixture();
    await expect(f.mount(false, false, { allow: null } as never)).rejects.toThrow(/tool selection/i);
    expect(existsSync(f.receipt)).toBe(false);
  });

  it("discovers without executing, preserves schemas and validates before forwarding original arguments", async () => {
    const f = fixture();
    const session = await f.mount();
    expect(session.definitions).toEqual([{ type: "function", function: { name: "audit_write", description: "Fixture write", parameters: schema } }]);
    expect(f.read().calls.map((call) => call.method)).not.toContain("tools/call");
    expect(() => session.validate("audit_write", { value: 42 })).toThrow("input schema");
    await expect(session.execute("not_registered", {}, f.controller.signal)).rejects.toThrow("not advertised");
    expect(f.read().calls.map((call) => call.method)).not.toContain("tools/call");
    await expect(session.execute("audit_write", { value: "receipt" }, f.controller.signal)).resolves.toEqual({ text: "recorded:receipt", ok: true });
    expect(f.read().calls.at(-1)).toMatchObject({ method: "tools/call", params: { name: "write", arguments: { value: "receipt" } } });
    const pid = f.read().pid;
    await session.close();
    expect(alive(pid)).toBe(false);
    await expect(session.execute("audit_write", { value: "again" }, f.controller.signal)).rejects.toThrow("closed");
  });

  it.each([
    ["browser", true],
    ["custom", false],
  ] as const)("drops a blank url for agent_browser_read only on the built-in browser (%s)", async (mountAs, dropped) => {
    const readSchema = { type: "object", properties: { url: { type: "string" } }, additionalProperties: false };
    const f = fixture(`if (message.method === "tools/list") { reply(message, {tools:[{name:"agent_browser_read",description:"Omit url to read the active tab.",inputSchema:schema}]}); continue; }`, readSchema);
    const session = await mountChatTools(mountAs === "browser" ? { browser: f.server } : { custom: { browser: f.server } }, f.controller.signal, true);
    sessions.push(session);
    const name = session.definitions[0]!.function.name;
    await session.execute(name, { url: " " }, f.controller.signal);
    await session.execute(name, { url: "https://example.com" }, f.controller.signal);
    const calls = f.read().calls.filter((call) => call.method === "tools/call").map((call) => call.params?.arguments);
    expect(calls).toEqual([dropped ? {} : { url: " " }, { url: "https://example.com" }]);
  });

  it("starts servers with the widened PATH rather than the bare one the desktop shell inherits", async () => {
    // Launched from Finder, the harness sees only the system directories;
    // the widened PATH is what the Claude and Codex drivers already hand out.
    const widened = augmentedPath();
    vi.stubEnv("PATH", "/usr/bin:/bin");
    const f = fixture();
    await f.mount();
    expect(f.read().path).toBe(widened);
  });

  it("lets a PATH set on the server descriptor win over the widened one", async () => {
    const f = fixture();
    const own = `${augmentedPath()}:/opt/own-tools`;
    f.server.env = { ...f.server.env, PATH: own };
    await f.mount();
    expect(f.read().path).toBe(own);
  });

  it("keeps the operator's control-plane secrets from a chat bot's tool servers, but not what the descriptor grants", async () => {
    const secrets = ["OMB_CLOUD_READY_TOKEN", "OMB_CLOUD_BOOTSTRAP", "OMB_LICENSE_KEY", "OMB_INSTALLATION_CREDENTIAL"];
    for (const name of secrets) vi.stubEnv(name, "should-not-leak");
    vi.stubEnv("OMB_CLOUDFLARED_PATH", "/usr/local/bin/cloudflared");
    const f = fixture();
    f.server.env = { ...f.server.env, OMB_COMMS_TOKEN: "turn-capability" };
    await f.mount();
    const seen = f.read().omb;
    expect(seen).toMatchObject({ OMB_CLOUDFLARED_PATH: "/usr/local/bin/cloudflared", OMB_COMMS_TOKEN: "turn-capability" });
    for (const name of secrets) expect(seen).not.toHaveProperty(name);
  });

  it("mounts only supported descriptors and preserves conversations with no tools", async () => {
    const controller = new AbortController();
    controllers.push(controller);
    const session = await mountChatTools({ phone: { command: "must-not-launch", args: [], env: {} } }, controller.signal);
    sessions.push(session);
    expect(session.definitions).toEqual([]);
    await session.close();
  });

  it("paginates deterministically and keeps colliding names within 64 characters", async () => {
    const long = "x".repeat(100);
    const f = fixture(`
      if (message.method === "tools/list") {
        reply(message, message.params.cursor
          ? {tools:[{name:${JSON.stringify(long + "-second")},inputSchema:schema}]}
          : {tools:[{name:${JSON.stringify(long)},inputSchema:schema}],nextCursor:"second"});
        continue;
      }
    `);
    const session = await f.mount();
    const names = session.definitions.map((tool) => tool.function.name);
    expect(new Set(names).size).toBe(2);
    expect(names.every((name) => name.length <= 64)).toBe(true);
    expect(names[1]).toMatch(/_2$/);
    expect(f.read().calls.filter((call) => call.method === "tools/list")).toHaveLength(2);
  });

  it.each([
    ["repeated cursor", `reply(message, {tools:[],nextCursor:"same"});`],
    ["too many tools", `reply(message, {tools:Array.from({length:129},(_,i)=>({name:"tool"+i,inputSchema:schema}))});`],
    ["duplicate tool", `reply(message, {tools:[{name:"same",inputSchema:schema},{name:"same",inputSchema:schema}]});`],
    ["invalid RPC", `process.stdout.write('{"result":1}\\n');`],
    ["oversized incomplete frame", `process.stdout.write("x".repeat(2*1024*1024+1));`],
    ["oversized complete frame", `process.stdout.write("x".repeat(2*1024*1024+1) + "\\n");`],
    ["too many response frames", `process.stdout.write("\\n".repeat(10001));`],
    ["oversized tool catalog", `reply(message, {tools:[{name:"write",inputSchema:schema,description:"x".repeat(1024*1024)}]});`],
  ])("fails startup and awaits child cleanup for %s", async (_label, response) => {
    const f = fixture(`if (message.method === "tools/list") { ${response} continue; }`);
    await expect(f.mount()).rejects.toThrow(/MCP/);
    expect(alive(f.read().pid)).toBe(false);
  });

  it("rejects untrusted transport error text without leaking it", async () => {
    const f = fixture(`if (message.method === "tools/call") { send({jsonrpc:"2.0",id:message.id,error:{code:-1,message:"secret-fixture-key"}}); continue; }`);
    const session = await f.mount();
    const result = await session.execute("audit_write", { value: "test" }, f.controller.signal).catch((error: Error) => error);
    expect(result).toBeInstanceOf(ChatToolSessionError);
    expect(String(result)).toContain("MCP request failed");
    expect(String(result)).not.toContain("secret-fixture-key");
    expect(alive(f.read().pid)).toBe(false);
  });

  it("rejects malformed tool content instead of accepting an empty successful result", async () => {
    const f = fixture(`if (message.method === "tools/call") { reply(message,{content:[{type:"text",text:42}]}); continue; }`);
    const session = await f.mount();
    const pending = session.execute("audit_write", {value:"test"}, f.controller.signal);
    await expect(pending).rejects.toBeInstanceOf(ChatToolSessionError);
    await expect(pending).rejects.toThrow("invalid content");
    expect(alive(f.read().pid)).toBe(false);
    expect(() => session.validate("audit_write", {value:"test"})).toThrow(ChatToolSessionError);
  });

  it("keeps schema errors recoverable without dispatching or closing the transport", async () => {
    const f = fixture();
    const session = await f.mount();
    const result = await session.execute("audit_write", {value:42}, f.controller.signal).catch((error: Error) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(ChatToolSessionError);
    expect(f.read().calls.some((call) => call.method === "tools/call")).toBe(false);
    await expect(session.execute("audit_write", {value:"valid"}, f.controller.signal)).resolves.toMatchObject({ok:true});
  });

  it("returns ordinary MCP tool errors while keeping the session available", async () => {
    const f = fixture(`if(message.method === "tools/call" && message.params.arguments.value === "fail") { reply(message,{isError:true,content:[{type:"text",text:"fixture operation refused"}]}); continue; }`);
    const session = await f.mount();
    await expect(session.execute("audit_write", {value:"fail"}, f.controller.signal)).resolves.toEqual({ok:false,text:"fixture operation refused"});
    await expect(session.execute("audit_write", {value:"valid"}, f.controller.signal)).resolves.toMatchObject({ok:true});
  });

  it.each([false, true])("does not claim success for an unsupported result (has text: %s)", async (hasText) => {
    const f = fixture(`if(message.method === "tools/call") { reply(message,{content:[${hasText ? '{type:"text",text:"partial result"},' : ''}{type:"image",data:"fixture",mimeType:"image/png"}]}); continue; }`);
    const session = await f.mount();
    const result = await session.execute("audit_write", {value:"valid"}, f.controller.signal);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("unsupported MCP content");
    expect(result.text).toContain("inspect its state before retrying");
    if (hasText) expect(result.text).toContain("partial result");
  });

  it("closes already mounted peers when another server fails startup", async () => {
    const ready = fixture();
    const failed = fixture(`if(message.method === "tools/list") { reply(message,{tools:"invalid"}); continue; }`);
    await expect(mountChatTools({custom:{ready:ready.server,failed:failed.server}},ready.controller.signal)).rejects.toThrow("invalid result");
    expect(alive(ready.read().pid)).toBe(false);
    expect(alive(failed.read().pid)).toBe(false);
  });

  it("returns declared tool errors and bounds aggregate text without splitting UTF-8", async () => {
    const f = fixture(`if (message.method === "tools/call") { reply(message,{isError:true,content:[{type:"text",text:"á".repeat(30000)},{type:"image",data:"ignored",mimeType:"image/png"}],structuredContent:{status:"failed"}}); continue; }`);
    const session = await f.mount();
    const result = await session.execute("audit_write", { value: "test" }, f.controller.signal);
    expect(result.ok).toBe(false);
    expect(Buffer.byteLength(result.text)).toBeLessThan(52_000);
    expect(result.text).toContain("truncated");
    expect(result.text).not.toContain("�");
  });

  it.each(["initialize", "tools/list", "tools/call"])("cancels %s and awaits its owned process tree", async (method) => {
    const f = fixture(`if (message.method === ${JSON.stringify(method)}) {
      const helper = spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
      helper.on("spawn",()=>writeFileSync(receipt,JSON.stringify({pid:process.pid,helper:helper.pid,calls})));
      continue;
    }`);
    const pending = method === "tools/call"
      ? f.mount().then((session) => session.execute("audit_write", { value: "test" }, f.controller.signal))
      : f.mount();
    const rejected = expect(pending).rejects.toThrow(/cancelled|closed/);
    let receipt!: { pid: number; helper: number };
    await vi.waitFor(() => {
      receipt = JSON.parse(readFileSync(f.receipt, "utf8"));
      expect(receipt.helper).toBeGreaterThan(0);
    }, { timeout: 10_000 });
    f.controller.abort();
    await rejected;
    expect(alive(receipt.pid)).toBe(false);
    expect(alive(receipt.helper)).toBe(false);
  });
});

/** "Always allow this session" names the tool on its server as launched. */
const grantFor = (server: string, tool: string) => expect.stringMatching(new RegExp(`^\\["${server}","[0-9a-f]{64}","${tool}"\\]$`));

describe("Chat MCP approvals by server", () => {
  it("asks nothing for OpenMausBot's agents server, and grants no session-wide allow on the person's computer", async () => {
    const agents = fixture(); const audit = fixture(); const computer = fixture();
    const session = await mountChatTools({
      agents: agents.server, custom: { audit: audit.server },
      localComputer: { ...computer.server, scope: "local-computer" },
    }, agents.controller.signal, true);
    sessions.push(session);
    expect(session.definitions.map((tool) => tool.function.name).sort()).toEqual(["agents_write", "audit_write", "computer_write"]);
    expect(session.view("agents_write", { value: "x" })).toEqual({ title: "agents_write", input: { value: "x" }, ask: false });
    expect(session.view("audit_write", { value: "x" })).toEqual({ title: "audit_write", input: { value: "x" }, ask: true, grant: grantFor("audit", "write") });
    expect(session.view("computer_write", { value: "x" })).toEqual({ title: "computer_write", input: { value: "x" }, ask: true });
  });

  it("ties an allow to the server as launched: the same server keeps it, a changed one under the same name does not", async () => {
    const audit = fixture(); const other = fixture();
    const grant = async (server: typeof audit.server) => {
      const session = await mountChatTools({ custom: { audit: server } }, audit.controller.signal);
      sessions.push(session);
      return session.view("audit_write", { value: "x" }).grant;
    };
    const first = await grant(audit.server);
    expect(first).toEqual(grantFor("audit", "write"));
    // a later turn mounts the same server again
    expect(await grant({ ...audit.server, env: { ...audit.server.env } })).toBe(first);
    // the person pointed "audit" at another command, or changed its credential
    expect(await grant(other.server)).not.toBe(first);
    expect(await grant({ ...audit.server, env: { ...audit.server.env, AUDIT_TOKEN: "rotated" } })).not.toBe(first);
    // and the hash keeps no credential
    expect(first).not.toContain("rotated");
  });

  it("knows the harness's mounts by what the harness passed, not by a server's name", async () => {
    const lookalike = fixture(); const vm = fixture();
    const session = await mountChatTools({ custom: { agents: lookalike.server }, localComputer: vm.server }, lookalike.controller.signal, true);
    sessions.push(session);
    expect(session.view("agents_write", { value: "x" })).toMatchObject({ ask: true, grant: grantFor("agents", "write") });
    // an isolated VM is not the person's own computer
    expect(session.view("computer_write", { value: "x" })).toMatchObject({ ask: true, grant: grantFor("computer", "write") });
  });
});

describe("Chat MCP tool directory", () => {
  const catalog = whopLikeCatalog(300);
  async function mountWhop(toolScope?: ToolScope) {
    const remote = await startFakeHttpMcp({ tools: catalog });
    const controller = new AbortController(); controllers.push(controller);
    try {
      const session = await mountChatTools({ custom: { whop: { type: "http", url: remote.url, headers: {} } } }, controller.signal, false, toolScope);
      sessions.push(session);
      return { remote, controller, session };
    } catch (error) { await remote.close(); throw error; }
  }

  it("searches a 300-tool URL server instead of refusing it at the 128-tool limit", async () => {
    const { remote, controller, session } = await mountWhop();
    try {
      expect(session.definitions.map((tool) => tool.function.name)).toEqual(["whop_search_tools", "whop_describe_tool", "whop_call_tool"]);
      const search = await session.execute("whop_search_tools", { query: "list payments" }, controller.signal);
      expect(JSON.parse(search.text).matches[0].name).toBe("payments_list");
      // searching runs no tool of the server, so no card; call_tool shows its target
      expect(session.view("whop_search_tools", { query: "list payments" })).toEqual({ title: "whop_search_tools", input: { query: "list payments" }, ask: false });
      const args = { name: "payments_list", arguments: { company_id: "biz_1" } };
      // "Always allow this session" covers the tool call_tool runs, not call_tool
      expect(session.view("whop_call_tool", args)).toEqual({ title: "whop_payments_list", input: { company_id: "biz_1" }, ask: true, grant: grantFor("whop", "payments_list") });
      await expect(session.execute("whop_call_tool", args, controller.signal)).resolves.toMatchObject({ ok: true, text: "remote execution recorded" });
      expect(remote.calls).toEqual([{ name: "payments_list", arguments: { company_id: "biz_1" } }]);
      // a mistake the directory answers with guidance runs nothing and fails nothing
      const nameless = await session.execute("whop_call_tool", { arguments: {} }, controller.signal);
      expect(nameless).toMatchObject({ ok: true, text: expect.stringContaining("search_tools") });
      expect(session.view("whop_call_tool", { arguments: {} }).ask).toBe(false);
      const misfit = await session.execute("whop_call_tool", { name: "payments_list", arguments: { first: "ten" } }, controller.signal);
      expect(misfit.ok).toBe(true);
      expect(JSON.parse(misfit.text).problems).toContain("must have required property 'company_id'");
      const unknown = await session.execute("whop_describe_tool", { name: "payments_teleport" }, controller.signal);
      expect(unknown).toMatchObject({ ok: true, text: expect.stringContaining("search_tools") });
      expect(remote.calls).toHaveLength(1);
    } finally { await remote.close(); }
  });

  it("neither finds nor runs a tool outside the bot's selection", async () => {
    // more than forty selected tools stay a searched catalog
    const selected = [...catalog.filter((tool) => tool.name.endsWith("_list")).map((tool) => tool.name), "payments_get", "stats_get"];
    const { remote, controller, session } = await mountWhop({ allow: selected.map((name) => `mcp:whop:${name}`) });
    try {
      expect(session.definitions.map((tool) => tool.function.name)).toEqual(["whop_search_tools", "whop_describe_tool", "whop_call_tool"]);
      const found = JSON.parse((await session.execute("whop_search_tools", { query: "create payments", limit: 20 }, controller.signal)).text).matches;
      expect(found.map((match: { name: string }) => match.name).every((name: string) => selected.includes(name))).toBe(true);
      expect(() => session.validate("whop_call_tool", { name: "payments_create", arguments: {} })).toThrow("Tool selection excludes this tool");
      await expect(session.execute("whop_call_tool", { name: "payments_create", arguments: {} }, controller.signal)).rejects.toThrow("Tool selection excludes this tool");
      expect(remote.calls).toEqual([]);
      await expect(session.execute("whop_call_tool", { name: "payments_list", arguments: { company_id: "biz_1" } }, controller.signal)).resolves.toMatchObject({ ok: true });
      expect(remote.calls).toEqual([{ name: "payments_list", arguments: { company_id: "biz_1" } }]);
    } finally { await remote.close(); }
  });

  it("mounts a small URL server's own tools, unchanged", async () => {
    const remote = await startFakeHttpMcp({ tools: whopLikeCatalog(5) });
    const controller = new AbortController(); controllers.push(controller);
    try {
      const session = await mountChatTools({ custom: { whop: { type: "http", url: remote.url, headers: {} } } }, controller.signal);
      sessions.push(session);
      expect(session.definitions.map((tool) => tool.function.name)).toEqual(whopLikeCatalog(5).map((tool) => `whop_${tool.name.replace("-", "_")}`));
      expect(session.view("whop_payments_list", { company_id: "biz_1" })).toEqual({ title: "whop_payments_list", input: { company_id: "biz_1" }, ask: true, grant: grantFor("whop", "payments_list") });
    } finally { await remote.close(); }
  });
});

describe("Chat MCP startup budgets", () => {
  /** Runs fake time forward in small steps until `condition` holds, so
   * real I/O and the faked clock both make progress. */
  /** Lets real I/O run, the faked clock standing still, until `condition`. */
  async function untilReal(condition: () => boolean): Promise<void> {
    const started = Date.now();
    while (!condition() && Date.now() - started < 15_000) await new Promise((resolve) => setImmediate(resolve));
    expect(condition()).toBe(true);
  }
  /** Once a deadline has passed: steps the faked clock too, for cleanup
   * that polls on a timer, but by at most `budgetMs` in all, pausing in
   * real time between ticks so a stopping process can exit. */
  async function settleWithin(budgetMs: number, condition: () => boolean): Promise<void> {
    for (let spent = 0; !condition() && spent < budgetMs; spent += 25) {
      const until = Date.now() + 20;
      while (Date.now() < until) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(25);
    }
    expect(condition()).toBe(true);
  }
  function watch<T>(pending: Promise<T>) {
    const state: { done: boolean; value?: T; error?: unknown } = { done: false };
    void pending.then((value) => { state.done = true; state.value = value; }, (error: unknown) => { state.done = true; state.error = error; });
    return state;
  }

  it("gives a searched URL server 30 seconds to list its tools", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const remote = await startFakeHttpMcp({ tools: whopLikeCatalog(300), toolsDelayMs: 20_000 });
    const controller = new AbortController(); controllers.push(controller);
    try {
      const mounting = watch(mountChatTools({ custom: { whop: { type: "http", url: remote.url, headers: {} } } }, controller.signal));
      await untilReal(() => remote.delayedToolsLists === 1);
      // well past the 8 seconds a command server gets
      await vi.advanceTimersByTimeAsync(20_000);
      await untilReal(() => mounting.done);
      expect(mounting.error).toBeUndefined();
      sessions.push(mounting.value!);
      expect(mounting.value!.definitions).toHaveLength(3);
    } finally {
      vi.useRealTimers();
      await remote.close();
    }
  });

  it("still gives a command server 8 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const f = fixture(`if (message.method === "tools/list") return;`);
      const mounting = watch(f.mount());
      const listed = () => { try { return f.read().calls.some((call) => call.method === "tools/list"); } catch { return false; } };
      await untilReal(listed);
      await vi.advanceTimersByTimeAsync(7_900);
      expect(mounting.done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      // stopped at 8 seconds: well short of the 30 a URL server gets
      await settleWithin(1_000, () => mounting.done);
      expect(String(mounting.error)).toMatch(/timed out/);
    } finally { vi.useRealTimers(); }
  });
});

describe("Chat MCP schema validation", () => {
  it("retains native unsigned/composition constraints while exposing an object schema", async () => {
    const f = fixture("", { type: "object", properties: { value: { type: "integer", format: "uint32" } },
      anyOf: [{ required: ["value"] }], additionalProperties: false });
    const session = await f.mount(true);
    expect(session.definitions[0].function.parameters).not.toHaveProperty("anyOf");
    expect(session.definitions[0].function.description).toContain('"anyOf"');
    expect(() => session.validate("audit_write", {})).toThrow("input schema");
    expect(() => session.validate("audit_write", { value: -1 })).toThrow("input schema");
    expect(() => session.validate("audit_write", { value: 2 ** 32 })).toThrow("input schema");
    expect(() => session.validate("audit_write", { value: 42 })).not.toThrow();
  });

  it.each([false, true])("carries large images from custom and built-in servers (built-in: %s)", async local => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBv0AAAAASUVORK5CYII=", "base64");
    const chunk = Buffer.alloc(2 * 1024 * 1024 + 12);
    chunk.writeUInt32BE(chunk.length - 12, 0); chunk.write("tEXt", 4); chunk.write("fixture\0", 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    const data = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]).toString("base64");
    const f = fixture('if(message.method === "tools/call") { reply(message,{content:[{type:"image",mimeType:"image/png",data:process.env.IMAGE}]}); continue; }');
    f.server.env.IMAGE_FILE = join(f.dir, "image.txt");
    writeFileSync(f.server.env.IMAGE_FILE, data);
    writeFileSync(join(f.dir, "fake-mcp.mjs"), readFileSync(join(f.dir, "fake-mcp.mjs"), "utf8").replace('import { writeFileSync }', 'import { writeFileSync, readFileSync }').replace('process.env.IMAGE', 'readFileSync(process.env.IMAGE_FILE,"utf8")'));
    const session = await f.mount(true, local);
    const result = await session.execute(local ? "computer_write" : "audit_write", { value: "screenshot" }, f.controller.signal);
    expect(result).toEqual({ ok: true, text: "Screenshot captured.", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }] });
  });

  it("keeps a bounded frame limit for image-enabled custom servers", async () => {
    const f = fixture('if(message.method === "tools/call") { process.stdout.write("x".repeat(32*1024*1024+1)); continue; }');
    const session = await f.mount(true);
    await expect(session.execute("audit_write", { value: "large" }, f.controller.signal)).rejects.toThrow(/frame|limit/i);
  });

  it("rejects malformed image results without claiming execution success", async () => {
    const f = fixture('if(message.method === "tools/call") { reply(message,{content:[{type:"image",mimeType:"image/png",data:"not-base64"}]}); continue; }');
    const session = await f.mount(true);
    await expect(session.execute("audit_write", { value: "screenshot" }, f.controller.signal)).rejects.toThrow("Invalid or oversized MCP image");
  });
  it.each([
    { type: "object", properties: { value: { type: "string", minLength: 2 } }, required: ["value"] },
    { type: "object", properties: { value: { type: "string", enum: ["a"], minLength: 2 } }, required: ["value"] },
    { type: "object", properties: { value: { type: "array", minItems: 2 } }, required: ["value"] },
    { type: "object", properties: { value: { type: "string", default: "fallback" } }, required: ["value"] },
    { type: "object", required: ["value"] },
    { type: "object", properties: { value: { type: "array", items: {type:"string"}, uniqueItems: true } }, required: ["value"] },
  ])("enforces original constraints without defaults or coercion %#", async (toolSchema) => {
    const f = fixture("", toolSchema);
    const session = await f.mount();
    const invalid = "enum" in (toolSchema.properties?.value ?? {}) ? {value:"a"}
      : "uniqueItems" in (toolSchema.properties?.value ?? {}) ? {value:["a","a"]}
        : toolSchema.properties?.value.type === "array" ? {value:[]}
          : "minLength" in (toolSchema.properties?.value ?? {}) ? {value:"😀"} : {};
    expect(() => session.validate("audit_write", invalid)).toThrow("input schema");
    expect(f.read().calls.some((call) => call.method === "tools/call")).toBe(false);
    expect(session.definitions[0].function.parameters).toEqual(toolSchema);
  });

  it("retains composition and draft 2020-12 constraints", async () => {
    const toolSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
      properties: { value: {type:"array",items:{type:"number"},contains:{const:2},minContains:1} },
      required: ["value"], additionalProperties: false,
    };
    const f = fixture("", toolSchema);
    const session = await f.mount();
    expect(() => session.validate("audit_write", {value:[1]})).toThrow("input schema");
    expect(() => session.validate("audit_write", {value:[2]})).not.toThrow();
  });

  it.each([
    ["email", "user@example.com", "invalid"],
    ["uri", "https://example.com/path", "not a uri"],
    ["date-time", "2026-09-13T12:00:00Z", "2026-13-41"],
  ])("enforces the standard %s format", async (format, valid, invalid) => {
    const f = fixture("", {type:"object",properties:{value:{type:"string",format}},required:["value"]});
    const session = await f.mount();
    expect(() => session.validate("audit_write", {value:valid})).not.toThrow();
    expect(() => session.validate("audit_write", {value:invalid})).toThrow("input schema");
  });

  it.each([
    { type: "object", properties: {value:{type:"string",format:"unregistered-format"}} },
    { type: "object", properties: {value:{$ref:"https://example.invalid/private-schema"}} },
    { type: "object", properties: {value:{type:"string",unrecognizedAssertion: true}} },
  ])("refuses schemas it cannot validate instead of silently weakening them %#", async (toolSchema) => {
    const f = fixture("", toolSchema);
    await expect(f.mount()).rejects.toThrow("schema could not be validated");
    expect(alive(f.read().pid)).toBe(false);
  });

  it("honors the configured per-call timeout instead of the fixed default", async () => {
    // The fixture answers tools/call only after a delay; a short callTimeoutMs
    // must trip the timeout, a generous one lets the same call complete.
    const delayed = `if (message.method === "tools/call") { setTimeout(() => reply(message, {content:[{type:"text",text:"recorded:"+message.params.arguments.value}]}), 400); return; }`;
    const f = fixture(delayed);
    const short = await mountChatTools({ custom: { audit: f.server } }, f.controller.signal, false, undefined, 100);
    sessions.push(short);
    await expect(short.execute("audit_write", { value: "x" }, f.controller.signal)).rejects.toThrow("MCP request timed out");
    await expect(f.read().calls.filter((call) => call.method === "tools/call")).toHaveLength(1);

    const long = await mountChatTools({ custom: { audit: f.server } }, f.controller.signal, false, undefined, 5_000);
    sessions.push(long);
    await expect(long.execute("audit_write", { value: "y" }, f.controller.signal)).resolves.toMatchObject({ ok: true, text: "recorded:y" });
  });
});
