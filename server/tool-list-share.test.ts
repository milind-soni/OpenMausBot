import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createToolListNormalizer } from "./mcp-tool-schema.ts";
import { workspaceAppsLikeCatalog } from "./testing/workspace-apps-like-catalog.ts";
import { definitionListBytes, type ListedTool } from "./tool-list-budget.ts";
import {
  readRecordedToolList, TOOL_LIST_RECORD_ENV, TOOL_LIST_SHARE_ENV, toolsForSessionShare, toolsListResultForSessionShare,
} from "./tool-list-share.ts";

type Json = Record<string, unknown>;
const apps = workspaceAppsLikeCatalog();
const names = (tools: readonly unknown[]) => (tools as ListedTool[]).map((tool) => tool.name);
const folder = () => mkdtempSync(join(tmpdir(), "tls-"));

describe("a relayed server's share of the session's tool budget", () => {
  it("leaves a list alone when the session gave no share and asked for no record", () => {
    const result = { tools: apps };
    expect(toolsListResultForSessionShare(result, {})).toBe(result);
  });

  it("fits a connected-apps list into its share: every tool, its name and its required fields kept", () => {
    const share = 26_000;
    expect(definitionListBytes(apps)).toBeGreaterThan(share * 4);
    const fitted = toolsForSessionShare(apps, { [TOOL_LIST_SHARE_ENV]: String(share) }) as ListedTool[];
    expect(names(fitted)).toEqual(names(apps));
    expect(definitionListBytes(fitted)).toBeLessThanOrEqual(share);
    fitted.forEach((tool, index) => {
      const schema = tool.inputSchema as Json;
      const original = apps[index]!.inputSchema as Json;
      expect(schema.required).toEqual(original.required);
      expect(Object.keys(schema.properties as Json)).toEqual(Object.keys(original.properties as Json));
      expect((tool.description ?? "").length).toBeGreaterThan(0);
    });
  });

  it("says by how much a list is over its share at its shortest, and still lists every tool", () => {
    const logged: string[] = [];
    const fitted = toolsForSessionShare(apps, { [TOOL_LIST_SHARE_ENV]: "5000" }, (line) => logged.push(line));
    expect(names(fitted)).toEqual(names(apps));
    expect(logged).toEqual([expect.stringMatching(/^tool list is \d+ bytes at its shortest, \d+ over its 5000-byte share of the session's tool budget$/)]);
  });

  it("records the list it relays, before its share, for the next session to size", () => {
    const record = join(folder(), "records", "composio.json");
    toolsForSessionShare(apps, { [TOOL_LIST_SHARE_ENV]: "20000", [TOOL_LIST_RECORD_ENV]: record });
    expect(readRecordedToolList(record)).toEqual(apps.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
  });

  it("still fits its list when the record cannot be written, and reads nothing from a damaged record", () => {
    const blocked = join(folder(), "file");
    writeFileSync(blocked, "not a folder");
    const fitted = toolsForSessionShare(apps, { [TOOL_LIST_SHARE_ENV]: "26000", [TOOL_LIST_RECORD_ENV]: join(blocked, "record.json") });
    expect(names(fitted)).toEqual(names(apps));
    const damaged = join(folder(), "damaged.json");
    writeFileSync(damaged, "{\"tools\": [{\"description\": 1}]}");
    expect(readRecordedToolList(damaged)).toBeUndefined();
    expect(readRecordedToolList(join(folder(), "missing.json"))).toBeUndefined();
  });

  it("leaves a page of a longer list as it came", () => {
    const page = { tools: apps.slice(0, 10), nextCursor: "2" };
    expect(toolsListResultForSessionShare(page, { [TOOL_LIST_SHARE_ENV]: "100" })).toBe(page);
  });

  it("fits a bridged server's list after its profile, on its last page only", () => {
    const share = (tools: unknown[]) => toolsForSessionShare(tools, { [TOOL_LIST_SHARE_ENV]: "26000" });
    const normalizer = createToolListNormalizer(undefined, undefined, [], share);
    normalizer.observeRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const listed = JSON.parse(normalizer.rewriteResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: apps } }))) as { result: { tools: ListedTool[] } };
    expect(names(listed.result.tools)).toEqual(names(apps));
    expect(definitionListBytes(listed.result.tools)).toBeLessThanOrEqual(26_000);
    normalizer.observeRequest(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const first = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: apps.slice(0, 3), nextCursor: "next" } });
    expect(JSON.parse(normalizer.rewriteResponse(first)).result.tools).toEqual(apps.slice(0, 3));
  });
});
