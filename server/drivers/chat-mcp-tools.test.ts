import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { augmentedPath } from "../env-path.ts";
import { ChatToolSessionError, mountChatTools, type ChatToolSession } from "./chat-mcp-tools.ts";

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
    async mount(computerUse = false, localComputer = false) {
      const session = await mountChatTools(localComputer ? { localComputer: server } : { custom: { audit: server } }, controller.signal, computerUse);
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
});
