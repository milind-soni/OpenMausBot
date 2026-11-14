import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

import { createToolListNormalizer, providerSafeInputSchema } from "./mcp-tool-schema.ts";
import { TOOL_SCHEMA_PROFILE_ENV, toolSchemaProfile } from "./tool-schema-profile.ts";

const fields = Object.fromEntries([
  ["constructor", { type: "integer", description: "Constructor number" }],
  ["toString", { type: "string", description: "Display format" }],
  ["__proto__", { type: "boolean", description: "Include the prototype section" }],
]);
const required = Object.keys(fields);
const schema = (keyword: string) => ({
  type: "object", additionalProperties: false,
  [keyword]: [{ properties: fields, required }, { properties: fields, required }],
});

describe("MCP schema properties that share JavaScript object names", () => {
  for (const profile of [undefined, toolSchemaProfile("moonshot")]) {
    it.each(["allOf", "anyOf", "oneOf"])(`keeps branch fields in %s through the ${profile?.provider ?? "plain"} wire normalizer`, (keyword) => {
      const inputSchema = schema(keyword);
      const before = JSON.stringify(inputSchema);
      const normalizer = createToolListNormalizer(profile);
      normalizer.observeRequest('{"jsonrpc":"2.0","id":7,"method":"tools/list"}');
      const wire = normalizer.rewriteResponse(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: [{ name: "configure", inputSchema }] } }));
      const listed = JSON.parse(wire).result.tools[0].inputSchema;
      expect(listed).toEqual({ type: "object", additionalProperties: false, properties: fields, required });
      expect(Object.keys(listed.properties)).toEqual(required);
      expect(JSON.stringify(inputSchema)).toBe(before);
    });
  }

  it("keeps root declarations authoritative and returns an ordinary own-property map", () => {
    const rootFields = Object.fromEntries(required.map((key) => [key, { type: "string", description: "Root wins" }]));
    const input = { ...schema("allOf"), properties: rootFields };
    const safe = providerSafeInputSchema(input);
    expect(safe.properties).toEqual(rootFields);
    expect(Object.getPrototypeOf(safe.properties)).toBe(Object.prototype);
    for (const key of required) expect(Object.hasOwn(safe.properties as object, key)).toBe(true);
    expect(input.properties).toBe(rootFields);
  });

  it("passes an already-safe tool list through byte for byte", () => {
    const normalizer = createToolListNormalizer();
    const inputSchema = { type: "object", properties: fields, required };
    expect(providerSafeInputSchema(inputSchema)).toBe(inputSchema);
    const wire = JSON.stringify({ jsonrpc: "2.0", id: "safe", result: { tools: [{ name: "configure", inputSchema }] } });
    normalizer.observeRequest('{"jsonrpc":"2.0","id":"safe","method":"tools/list"}');
    expect(normalizer.rewriteResponse(wire)).toBe(wire);
  });

  it.each(["", "moonshot"])("advertises and forwards the fields through a real stdio bridge (profile %j)", async (profile) => {
    const tools = ["allOf", "anyOf", "oneOf"].map((keyword) => ({ name: keyword, inputSchema: schema(keyword) }));
    const driver = `
      const { createInterface } = require("node:readline");
      createInterface({ input: process.stdin }).on("line", (line) => {
        const frame = JSON.parse(line);
        const result = frame.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
          : frame.method === "tools/list" ? { tools: JSON.parse(process.env.OMB_SCHEMA_FIXTURE_TOOLS) }
          : { content: [], structuredContent: frame.params.arguments };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\\n");
      });
    `;
    const source = `import { runMcpBridge } from ${JSON.stringify(new URL("./mcp-bridge.ts", import.meta.url).href)};
      runMcpBridge({ command: process.execPath, args: ["-e", ${JSON.stringify(driver)}], label: "schema fixture" });`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", source], {
      stdio: "pipe", env: { ...process.env, [TOOL_SCHEMA_PROFILE_ENV]: profile, OMB_SCHEMA_FIXTURE_TOOLS: JSON.stringify(tools) },
    });
    const reader = createInterface({ input: child.stdout });
    const lines = reader[Symbol.asyncIterator]();
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
    const ask = async (id: number, method: string, params?: unknown) => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const line = await Promise.race([
          lines.next(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Bridge timed out: ${stderr}`)), 5_000); }),
        ]);
        expect(line.done).toBe(false);
        return JSON.parse(line.value as string);
      } finally { clearTimeout(timer); }
    };
    try {
      await ask(1, "initialize", {});
      const listed = await ask(2, "tools/list");
      for (const tool of listed.result.tools) {
        expect(tool.inputSchema.properties).toEqual(fields);
        expect(tool.inputSchema.required).toEqual(required);
      }
      const args = JSON.parse('{"constructor":12,"toString":"detailed","__proto__":true}');
      expect((await ask(3, "tools/call", { name: "allOf", arguments: args })).result.structuredContent).toEqual(args);
      expect(stderr).toBe("");
    } finally {
      reader.close();
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill();
        await closed;
      }
    }
  });
});
