import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";

import extension, {
  allocateToolName,
  StdioMcp,
  toTypebox,
  truncateToolText,
} from "./pi-mcp-extension.ts";

const tempDirs: string[] = [];
const clients: StdioMcp[] = [];
const originalMcpConfig = process.env.OMB_MCP_CONFIG;

type ExtensionApi = Parameters<typeof extension>[0];
type RegisteredTool = Parameters<ExtensionApi["registerTool"]>[0];
type ShutdownHandler = Parameters<ExtensionApi["on"]>[1];

interface SchemaNode {
  type?: string;
  const?: unknown;
  enum?: unknown[];
  anyOf?: SchemaNode[];
  required?: string[];
  additionalProperties?: boolean | SchemaNode;
  properties?: Record<string, SchemaNode>;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-pi-mcp-ext-"));
  tempDirs.push(dir);
  return dir;
}

function fakeMcpScript(source: string): string {
  const dir = tempDir();
  const path = join(dir, "fake-mcp.mjs");
  writeFileSync(path, source, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function createClient(source: string, env: Record<string, string> = {}): StdioMcp {
  const client = new StdioMcp({ command: process.execPath, args: [fakeMcpScript(source)], env });
  clients.push(client);
  return client;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.dispose();
  for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
  if (originalMcpConfig === undefined) delete process.env.OMB_MCP_CONFIG;
  else process.env.OMB_MCP_CONFIG = originalMcpConfig;
});

describe("Pi MCP JSON Schema conversion", () => {
  it("keeps the cua browser_prepare regression schema object-shaped at the root", () => {
    const schema = toTypebox({
      type: "object",
      additionalProperties: true,
      anyOf: [
        { required: ["pid"] },
        {
          properties: {
            allow_launch: { const: true },
            profile: { properties: { mode: { enum: ["isolated_new", "isolated_named"] } } },
          },
          required: ["allow_launch", "profile"],
        },
      ],
      properties: {
        allow_launch: { type: "boolean" },
        pid: { type: "integer" },
        profile: {
          type: "object",
          properties: { mode: { type: "string", enum: ["isolated_new", "isolated_named"] } },
          required: ["mode"],
        },
      },
      required: [],
    });
    // SAFETY: toTypebox returns a TypeBox JSON Schema; this test reads only
    // standard JSON Schema fields represented by SchemaNode.
    const inspected = schema as SchemaNode;

    expect(inspected.type).toBe("object");
    expect(inspected.additionalProperties).toBe(true);
    expect(inspected.properties?.pid.type).toBe("integer");
    expect(inspected.properties?.profile.type).toBe("object");
    expect(inspected.properties?.profile.required).toEqual(["mode"]);
  });

  it("preserves nested combinators, nullability, const and Google-compatible string enums", () => {
    const schema = toTypebox({
      type: "object",
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "null" }] },
        flag: { type: ["boolean", "null"] },
        mode: { type: "string", enum: ["ax", "vision"] },
        enabled: { const: true },
      },
      required: ["value"],
    });
    // SAFETY: toTypebox returns a TypeBox JSON Schema; this test reads only
    // standard JSON Schema fields represented by SchemaNode.
    const inspected = schema as SchemaNode;

    expect(inspected.type).toBe("object");
    expect(inspected.required).toEqual(["value"]);
    expect(inspected.properties?.value.anyOf?.map((item) => item.type)).toEqual(["string", "null"]);
    expect(inspected.properties?.flag.anyOf?.map((item) => item.type)).toEqual(["boolean", "null"]);
    expect(inspected.properties?.mode).toMatchObject({ type: "string", enum: ["ax", "vision"] });
    expect(inspected.properties?.enabled).toMatchObject({ type: "boolean", const: true });
  });

  it("collects properties declared only inside root combinator branches", () => {
    const schema = toTypebox({
      oneOf: [
        { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
      ],
    });
    // SAFETY: toTypebox returns a TypeBox JSON Schema; this test reads only
    // standard JSON Schema fields represented by SchemaNode.
    const inspected = schema as SchemaNode;

    expect(inspected.type).toBe("object");
    expect(Object.keys(inspected.properties ?? {})).toEqual(["query", "id"]);
    // A field required by only one choice cannot be globally required.
    expect(inspected.required).toBeUndefined();
  });

  it("always returns an object schema for malformed, nullable or absent root schemas", () => {
    expect(toTypebox(undefined)).toMatchObject({ type: "object" });
    expect(toTypebox({ anyOf: [] })).toMatchObject({ type: "object" });
    expect(toTypebox({ type: "object", nullable: true })).toMatchObject({ type: "object" });
  });
});

describe("Pi MCP tool names and output bounds", () => {
  it("keeps collision suffixes inside the provider 64-character limit", () => {
    const used = new Set<string>();
    const long = "x".repeat(100);
    const names = Array.from({ length: 12 }, () => {
      const name = allocateToolName("computer", long, used);
      used.add(name);
      return name;
    });

    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.length <= 64)).toBe(true);
    expect(names.at(-1)).toMatch(/_12$/);
  });

  it("truncates by lines and UTF-8 bytes without splitting a code point", () => {
    const manyLines = Array.from({ length: 2_100 }, (_, index) => `line ${index}`).join("\n");
    expect(truncateToolText(manyLines)).toContain("2000-line limit");

    const manyAccents = "á".repeat(30_000);
    const truncated = truncateToolText(manyAccents);
    expect(truncated).toContain("50KB limit");
    expect(truncated).not.toContain("�");
  });
});

describe("StdioMcp", () => {
  it("initializes, paginates tools/list, preserves images and truncates text", async () => {
    const client = createClient(`
      let buffer = "";
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
          else if (msg.method === "tools/list" && !msg.params?.cursor) send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "page-2" } });
          else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "second", inputSchema: { type: "object" } }] } });
          else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [
            { type: "text", text: "x".repeat(60 * 1024) },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }
          ] } });
        }
      });
    `);

    await client.init();
    await expect(client.listTools()).resolves.toMatchObject([{ name: "first" }, { name: "second" }]);
    const result = await client.callTool("first", {});
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("50KB limit") });
    expect(result.content[1]).toEqual({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" });
  });

  it("propagates abort and sends MCP notifications/cancelled", async () => {
    const dir = tempDir();
    const dump = join(dir, "cancel.json");
    const client = createClient(
      `
        import { writeFileSync } from "node:fs";
        let buffer = "";
        process.stdin.setEncoding("utf8");
        const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
        process.stdin.on("data", (chunk) => {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf("\\n")) !== -1) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            const msg = JSON.parse(line);
            if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
            else if (msg.method === "notifications/cancelled") writeFileSync(process.env.DUMP, JSON.stringify(msg.params));
          }
        });
      `,
      { DUMP: dump },
    );
    await client.init();
    const controller = new AbortController();
    const pending = client.callTool("slow", {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    await vi.waitFor(() => expect(JSON.parse(readFileSync(dump, "utf8"))).toMatchObject({ requestId: 2 }));
  });
});

describe("Pi MCP extension registration", () => {
  const scopedApi = (initial: string[]) => {
    let active = initial;
    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, (event?: any) => any>();
    return { tools, handlers, current: () => active, restore: (names: string[]) => { active = names; }, api: {
      registerTool(tool: RegisteredTool) { tools.push(tool); },
      on(event: string, handler: (event?: any) => any) { handlers.set(event, handler); },
      getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = names; },
    } };
  };
  const scopeConfig = (toolScope: unknown, other = {}) => {
    const dir = tempDir();
    process.env.OMB_MCP_CONFIG = join(dir, "scope.json");
    writeFileSync(process.env.OMB_MCP_CONFIG, JSON.stringify({ toolScope, ...other }));
    return dir;
  };

  it("intersects native and package tools before the first turn and after restoration", async () => {
    scopeConfig({ allow: ["native:read", "native:edit", "native:write"] });
    const f = scopedApi(["read", "write", "bash", "package_tool"]);
    await extension(f.api);
    await f.handlers.get("session_start")?.({});
    expect(f.current()).toEqual(["read", "write"]);
    f.restore(["read", "write", "bash", "late_package"]);
    await f.handlers.get("before_agent_start")?.({});
    expect(f.current()).toEqual(["read", "write"]);
    f.restore(["edit", "bash"]);
    await f.handlers.get("session_switch")?.({});
    await f.handlers.get("model_select")?.({});
    expect(f.current()).toEqual(["edit"]);
    expect(await f.handlers.get("tool_call")?.({ toolName: "bash" })).toMatchObject({ block: true });
    expect(await f.handlers.get("tool_call")?.({ toolName: "read" })).toBeUndefined();
    f.restore(["read", "bash"]);
    const payload = { tools: ["read", "bash", "late_package"].map((name) => ({ type: "function", function: { name, parameters: { type: "object" } } })) };
    await f.handlers.get("before_provider_request")?.({ payload });
    expect(payload.tools.map((tool) => tool.function.name)).toEqual(["read"]);
  });

  it("does not confirm a refused active-tool clamp or restore a tool another extension disabled", async () => {
    const directory = scopeConfig({ allow: ["native:read", "native:write"] });
    const readyPath = join(directory, "ready.json");
    scopeConfig({ allow: ["native:read", "native:write"] }, { scopeReadyPath: readyPath });
    const refused = scopedApi(["read", "bash"]);
    refused.api.setActiveTools = () => {};
    await extension(refused.api);
    expect(() => refused.handlers.get("session_start")?.({})).toThrow(/enforcement/i);
    expect(JSON.parse(readFileSync(readyPath, "utf8"))).toEqual({ ok: false });
    const f = scopedApi(["write"]);
    await extension(f.api);
    const payload = { tools: ["read", "write"].map((name) => ({ name, input_schema: { type: "object" } })) };
    await f.handlers.get("before_provider_request")?.({ payload });
    expect(payload.tools.map((tool) => tool.name)).toEqual(["write"]);
  });

  it("makes no-tools explicit and refuses unavailable enforcement APIs or corrupt configuration", async () => {
    scopeConfig({ allow: [] });
    const f = scopedApi(["read", "bash"]);
    await extension(f.api);
    await f.handlers.get("session_start")?.({});
    expect(f.current()).toEqual([]);
    expect(await f.handlers.get("tool_call")?.({ toolName: "read" })).toMatchObject({ block: true });
    await expect(extension({ registerTool() {}, on() {} })).rejects.toThrow(/enforcement/i);
    writeFileSync(process.env.OMB_MCP_CONFIG!, "not json");
    await expect(extension(f.api)).rejects.toThrow(/configuration/i);
  });

  it("removes declarations if enforcement becomes unavailable after startup", async () => {
    scopeConfig({ allow: ["native:read"] });
    const f = scopedApi(["read"]);
    await extension(f.api);
    await f.handlers.get("session_start")?.({});
    f.api.setActiveTools = () => {};
    f.restore(["read", "bash"]);
    const payload = { tools: ["read", "bash"].map((name) => ({ type: "function", function: { name } })) };
    // Pi catches extension exceptions and can keep sending the old payload.
    // This hook must return a deny-all declaration rather than throw past it.
    await f.handlers.get("before_provider_request")?.({ payload });
    expect(payload.tools).toEqual([]);
  });

  it("filters raw MCP identities and still asks before custom execution", async () => {
    const receipt = join(tempDir(), "execution.txt");
    const script = fakeMcpScript(`
      import { createInterface } from "node:readline";
      import { writeFileSync } from "node:fs";
      createInterface({input:process.stdin}).on("line", line => {
        const m = JSON.parse(line); if (m.id === undefined) return;
        let result = {};
        if (m.method === "tools/list") result = {tools:[{name:"read-notes",inputSchema:{type:"object"}},{name:"read_notes",inputSchema:{type:"object"}}]};
        if (m.method === "tools/call") { writeFileSync(process.env.RECEIPT, m.params.name); result = {content:[{type:"text",text:"selected"}]}; }
        process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result}) + "\\n");
      });
    `);
    scopeConfig({ allow: ["mcp:mail:read-notes"] }, { mcpServers: { mail: { command: process.execPath, args: [script], env: { RECEIPT: receipt }, scope: "custom" } } });
    const f = scopedApi(["read", "mail_read_notes"]);
    await extension(f.api);
    try {
      expect(f.tools.map((tool) => tool.name)).toEqual(["mail_read_notes"]);
      const blocked = await f.tools[0].execute("denied", {}, undefined, undefined, { ui: { confirm: async () => false } });
      expect(blocked.content).toMatchObject([{ text: "Blocked by the user." }]);
      expect(existsSync(receipt)).toBe(false);
      await f.tools[0].execute("allowed", {}, undefined, undefined, { ui: { confirm: async () => true } });
      expect(readFileSync(receipt, "utf8")).toBe("read-notes");
      expect(await f.handlers.get("tool_call")?.({ toolName: "mail_read_notes_2" })).toMatchObject({ block: true });
    } finally { await f.handlers.get("session_shutdown")?.(); }
  });
  it("keeps earlier tools alive when a later registration fails", async () => {
    const script = fakeMcpScript(`
      let buffer = "";
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
          else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
            { name: "good", inputSchema: { type: "object", properties: {} } },
            { name: "bad", inputSchema: { type: "object", properties: {} } }
          ] } });
          else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "still alive" }] } });
        }
      });
    `);
    const dir = tempDir();
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [script] } } }));
    process.env.OMB_MCP_CONFIG = config;

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, ShutdownHandler>();
    await extension({
      registerTool(tool) {
        if (tool.name.endsWith("_bad")) throw new Error("synthetic registration failure");
        tools.push(tool);
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    expect(tools).toHaveLength(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("synthetic registration failure"));
    await expect(
      tools[0].execute("call-1", {}, undefined, undefined, { ui: { confirm: async () => true } }),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "still alive" }] });
    await handlers.get("session_shutdown")?.();
  });

  it("throws when an MCP tool result declares isError", async () => {
    const script = fakeMcpScript(`
      let buffer = "";
      process.stdin.setEncoding("utf8");
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf("\\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { tools: {} } } });
          else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "fail", inputSchema: { type: "object", properties: {} } }] } });
          else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "remote failure" }] } });
        }
      });
    `);
    const dir = tempDir();
    const config = join(dir, "mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [script] } } }));
    process.env.OMB_MCP_CONFIG = config;

    const tools: RegisteredTool[] = [];
    const handlers = new Map<string, ShutdownHandler>();
    await extension({
      registerTool(tool) {
        tools.push(tool);
      },
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    expect(tools).toHaveLength(1);
    await expect(
      tools[0].execute("call-1", {}, undefined, undefined, { ui: { confirm: async () => true } }),
    ).rejects.toThrow("remote failure");
    await handlers.get("session_shutdown")?.();
  });
});
