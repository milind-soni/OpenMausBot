import type { FakeHttpMcpTool } from "./fake-http-mcp-server.ts";

const callRequest = {
  type: "object",
  properties: { path: { type: "string", description: "An exact path from search." }, input: { description: "The tool's input, matching its input type." } },
  required: ["path", "input"],
  additionalProperties: true,
};

/** The tools an Executor MCP gateway (github.com/UsefulSoftwareCo/executor, Nov 2026) lists, with the input schemas Effect
 * Schema 4.0.1 writes for them: no `$schema`, and `skills` carries 2020-12's `dependentRequired`. */
export const EXECUTOR_LIKE_TOOLS: FakeHttpMcpTool[] = [
  {
    name: "skills",
    description: "List or read the skills apps ship.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$" },
        name: { type: "string" },
        file: { type: "string" },
        version: { type: "string", pattern: "^dpl_[\\s\\S]+$" },
        revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
        accounts: {},
      },
      additionalProperties: true,
      dependentRequired: { name: ["app"], file: ["app", "name"], version: ["app"], revision: ["app"], accounts: ["app"] },
    },
  },
  {
    name: "search",
    description: "Search the tools of the connected apps.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, namespace: { type: "string" }, limit: { type: "integer", exclusiveMinimum: 0 }, offset: { type: "integer", minimum: 0 } },
      additionalProperties: true,
    },
  },
  {
    name: "describe",
    description: "Describe tools by their exact paths.",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 } }, required: ["paths"], additionalProperties: true },
  },
  {
    name: "call",
    description: "Call one tool, or several at once.",
    inputSchema: {
      type: "object",
      properties: { calls: { anyOf: [callRequest, { type: "array", items: callRequest, minItems: 1 }] } },
      required: ["calls"],
      additionalProperties: true,
    },
  },
  {
    name: "execute",
    description: "Run a program against the connected apps.",
    inputSchema: { type: "object", properties: { code: { type: "string", maxLength: 100_000 } }, required: ["code"], additionalProperties: true },
  },
  {
    name: "resume",
    description: "Continue a paused program with the person's answer.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { anyOf: [{ type: "string", pattern: "^apr_[\\s\\S]+$" }, { type: "string", pattern: "^elc_[\\s\\S]+$" }] },
        response: {
          anyOf: [
            { type: "object", properties: { _meta: { anyOf: [{ type: "object" }, { type: "null" }] }, action: { type: "string", enum: ["accept"] }, content: { type: "object" } }, required: ["action"], additionalProperties: true },
            { type: "object", properties: { _meta: { anyOf: [{ type: "object" }, { type: "null" }] }, action: { type: "string", enum: ["cancel", "decline"] } }, required: ["action"], additionalProperties: true },
          ],
        },
      },
      required: ["requestId", "response"],
      additionalProperties: true,
    },
  },
];
