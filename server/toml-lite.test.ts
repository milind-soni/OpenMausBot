import { describe, expect, it } from "vitest";

import { parseToml, TomlError } from "./toml-lite.ts";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("the TOML subset a Codex config.toml uses", () => {
  it("reads MCP server tables, their env subtables and inline tables, around the rest of the file", () => {
    const parsed = parseToml(`
# Codex settings
model = "gpt-5.5"
approval_policy = "on-request"

[profiles.fast]
model = "gpt-5.5-mini"   # a comment after a value

[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]

[mcp_servers.github.env]
GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_fixture"

[mcp_servers."docs search"]
url = 'https://docs.example.test/mcp'
http_headers = { "X-Team" = "core", Authorization = "Bearer fixture" }
startup_timeout_sec = 20
enabled = false

[mcp_servers.multi]
command = "uvx"
args = [
  "mcp-server-fetch",  # trailing comments inside arrays
  "--flag",
]
env = { LEVEL = 3, DEBUG = true }
`);
    expect(plain(parsed)).toEqual({
      model: "gpt-5.5",
      approval_policy: "on-request",
      profiles: { fast: { model: "gpt-5.5-mini" } },
      mcp_servers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_fixture" } },
        "docs search": {
          url: "https://docs.example.test/mcp",
          http_headers: { "X-Team": "core", Authorization: "Bearer fixture" },
          startup_timeout_sec: 20,
          enabled: false,
        },
        multi: { command: "uvx", args: ["mcp-server-fetch", "--flag"], env: { LEVEL: 3, DEBUG: true } },
      },
    });
  });

  it("keeps a table header inside a multi-line string as text", () => {
    const parsed = parseToml(`instructions = """
[mcp_servers.fake]
command = "rm"
"""
literal = '''
[mcp_servers.also_fake]'''
`);
    expect(plain(parsed)).toEqual({ instructions: "[mcp_servers.fake]\ncommand = \"rm\"\n", literal: "[mcp_servers.also_fake]" });
  });

  it("reads every string, number and key form", () => {
    const parsed = parseToml([
      'basic = "tab\\tquote\\" slash\\\\ \\u00e9 \\U0001F600"',
      "literal = 'C:\\Users\\nobody'",
      'folded = """one \\',
      '    two"""',
      'quotes = """a "quoted" word"""',
      "dotted.key = 1",
      'site."google.com" = true',
      "hex = 0xff",
      "octal = 0o17",
      "binary = 0b101",
      "big = 1_000",
      "float = -3.5e2",
      "infinite = -inf",
      "when = 1979-05-27 07:32:00Z",
      "day = 1979-05-27",
      "[[servers]]",
      'name = "a"',
      "[[servers]]",
      'name = "b"',
    ].join("\n"));
    expect(parsed.basic).toBe("tab\tquote\" slash\\ é 😀");
    expect(parsed.literal).toBe("C:\\Users\\nobody");
    expect(parsed.folded).toBe("one two");
    expect(parsed.quotes).toBe('a "quoted" word');
    expect(plain(parsed.dotted)).toEqual({ key: 1 });
    expect(plain(parsed.site)).toEqual({ "google.com": true });
    expect([parsed.hex, parsed.octal, parsed.binary, parsed.big, parsed.float, parsed.infinite]).toEqual([255, 15, 5, 1000, -350, -Infinity]);
    expect([parsed.when, parsed.day]).toEqual(["1979-05-27 07:32:00Z", "1979-05-27"]);
    expect(plain(parsed.servers)).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("gives a key named __proto__ no say over the prototype", () => {
    const parsed = parseToml('[mcp_servers.__proto__]\ncommand = "x"\n[mcp_servers.ok]\ncommand = "y"\n');
    const servers = parsed.mcp_servers as Record<string, unknown>;
    expect(Object.keys(servers)).toEqual(["__proto__", "ok"]);
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });

  it("refuses what it cannot read rather than guessing", () => {
    for (const bad of [
      'a = "unterminated',
      "a = 1\na = 2",
      "a = [1, 2",
      "a = { b = 1",
      "a = value",
      '[table\nb = 1',
      "a = 1 b = 2",
      'a = "\\q"',
      "a.b = 1\na.b.c = 2",
      `a = ${"[".repeat(80)}${"]".repeat(80)}`,
      `[mcp_servers.evil.command${".a".repeat(60_000)}]\nx = 1`,
      `${"k.".repeat(40)}k = 1`,
      `a = { ${"b.".repeat(40)}c = 1 }`,
    ]) {
      expect(() => parseToml(bad), bad).toThrow(TomlError);
    }
  });
});
