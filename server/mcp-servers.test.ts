// The invariants a custom MCP server has to hold, taken from the review of
// the earlier attempt (PR #61): a name can never become a routing identity,
// two servers can never collide into one, and an env value can never leave
// the server.
import { describe, expect, it } from "vitest";

import {
  enabledMcpServers,
  mcpKey,
  parseMcpServers,
  redactMcpServers,
  type McpServerSpec,
  type McpServersInput,
} from "./mcp-servers.ts";

let n = 0;
const ids = () => `id-${++n}`;
const spec = (over: Partial<McpServerSpec> = {}): McpServerSpec => ({
  id: "stored-1",
  name: "Filesystem",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem"],
  env: { TOKEN: "s3cret" },
  enabled: true,
  ...over,
});

describe("mcpKey", () => {
  it("folds a label into something an agent can prefix a tool with", () => {
    expect(mcpKey("Filesystem")).toBe("filesystem");
    expect(mcpKey("My Files (work)")).toBe("my-files-work");
    expect(mcpKey("  spaced  out  ")).toBe("spaced-out");
  });
});

describe("parseMcpServers", () => {
  // Half of these cases feed shapes the type forbids — which is the point:
  // this parser IS the boundary, and a hand-written PATCH never typechecks.
  // SAFETY: the cast reaches only the runtime schema under test.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  const parse = (value: unknown, existing: McpServerSpec[] = []) =>
    parseMcpServers(value as McpServersInput, existing, ids);

  it("accepts a minimal server and fills in the rest", () => {
    const out = parse([{ name: "files", command: "npx" }]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.servers[0]).toMatchObject({ name: "files", command: "npx", args: [], env: {}, enabled: true });
    expect(out.servers[0].id).toMatch(/^id-/);
  });

  it("refuses two servers that would answer to the same name", () => {
    const out = parse([
      { name: "My Files", command: "a" },
      { name: "my files", command: "b" },
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/same name/i);
  });

  it("keeps a server's id across a rename, so a turn cannot be re-pointed", () => {
    const stored = spec({ id: "stored-1", name: "Filesystem" });
    const out = parse([{ id: "stored-1", name: "Documents", command: "npx" }], [stored]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.servers[0].id).toBe("stored-1");
    expect(out.servers[0].name).toBe("Documents");
  });

  it("keeps a stored env value when the editor sends it back untouched", () => {
    const stored = spec();
    const out = parse([{ id: "stored-1", name: "Filesystem", command: "npx", env: { TOKEN: true } }], [stored]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.servers[0].env).toEqual({ TOKEN: "s3cret" });
  });

  it("refuses a placeholder env value with nothing stored behind it", () => {
    const out = parse([{ name: "files", command: "npx", env: { TOKEN: true } }]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/TOKEN/);
  });

  it("rejects the shapes a hand-written PATCH gets wrong", () => {
    expect(parse("nope").ok).toBe(false);
    expect(parse([{ command: "npx" }]).ok).toBe(false);
    expect(parse([{ name: "files" }]).ok).toBe(false);
    expect(parse([{ name: "files", command: "npx", args: "-y" }]).ok).toBe(false);
    expect(parse([{ name: "files", command: "npx", env: { A: 3 } }]).ok).toBe(false);
    expect(parse([{ name: "   ", command: "npx" }]).ok).toBe(false);
  });
});

describe("redactMcpServers", () => {
  it("replaces every env value with a marker, keeping the names", () => {
    const wire = redactMcpServers([spec({ env: { TOKEN: "s3cret", REGION: "eu" } })]);
    expect(wire[0].env).toEqual({ TOKEN: true, REGION: true });
    expect(JSON.stringify(wire)).not.toContain("s3cret");
  });
});

describe("enabledMcpServers", () => {
  it("drops the disabled ones and tolerates a bot with none", () => {
    expect(enabledMcpServers([spec({ id: "a" }), spec({ id: "b", enabled: false })]).map((s) => s.id)).toEqual(["a"]);
    expect(enabledMcpServers(undefined)).toEqual([]);
  });
});
