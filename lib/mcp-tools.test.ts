// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { MCP_TOOLS } from "./mcp-tools";

test("the README lists every MCP tool, read tools first", () => {
  const line = readFileSync(new URL("../README.md", import.meta.url), "utf8").split("\n").find(row => row.startsWith("- **Tools:**"))!;
  const [read, write] = line.split("with write access");
  const names = (text: string) => [...text.matchAll(/`([a-z_]+)`/g)].map(match => match[1]);
  expect(names(read!)).toEqual(MCP_TOOLS.filter(tool => !tool.write).map(tool => tool.name));
  expect(names(write!)).toEqual(MCP_TOOLS.filter(tool => tool.write).map(tool => tool.name));
});
