import { expect, it } from "vitest";
import { workflowSearchCatalog, workflowToolCatalog } from "./catalog.ts";

it("offers only granted, direct tools with input schemas to the planner", () => {
  const schema = { type: "object", properties: { folder: { type: "string" } } };
  const frame = { result: { tools: [
    { name: "MAIL_LIST", description: "List mail", inputSchema: schema },
    { name: "MAIL_DELETE", inputSchema: schema },
    { name: "MAIL_UNKNOWN" },
    { name: "COMPOSIO_MULTI_EXECUTE_TOOL", inputSchema: schema },
  ] } };
  expect(workflowToolCatalog(frame, (name) => name !== "MAIL_DELETE")).toEqual([{ name: "MAIL_LIST", description: "List mail", inputSchema: schema }]);
  expect(() => workflowToolCatalog({ result: { tools: [] } }, () => true)).toThrow(/no granted/i);
  expect(() => workflowToolCatalog({ error: "not connected" }, () => true)).toThrow(/unavailable/i);
});

it("reads inline schemas returned by connected-tool search", () => {
  const schema = { type: "object", properties: { folder: { type: "string" } } };
  const result = { successful: true, data: { results: [{ tools: [{ tool_slug: "MAIL_LIST", input_schema: schema }, { tool_slug: "MAIL_DELETE", input_schema: schema }] }] } };
  expect(workflowSearchCatalog(result, (name) => name === "MAIL_LIST")).toEqual([{ name: "MAIL_LIST", inputSchema: schema }]);
});
