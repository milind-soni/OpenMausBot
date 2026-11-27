import { describe, expect, it } from "vitest";

import { gapIn, readMcpPaste, shellCommands, type McpPaste, type PastedMcpServer } from "./mcp-paste";

const servers = (paste: McpPaste | null): PastedMcpServer[] => {
  if (!paste?.ok) throw new Error(`expected servers, got ${JSON.stringify(paste)}`);
  return paste.servers;
};
const one = (text: string, taken: string[] = []) => {
  const found = servers(readMcpPaste(text, taken));
  expect(found).toHaveLength(1);
  return found[0]!;
};

const GATEWAY = `claude mcp add --transport http my-mcp https://mcp.example.com/route \\
  --header "CF-Access-Client-Id: $CF_ID" \\
  --header "CF-Access-Client-Secret: $CF_SECRET"`;

describe("pasting a claude mcp add command", () => {
  it("reads a gateway's command: transport, name, address, and each header, asking for the values that were variables", () => {
    expect(one(GATEWAY)).toEqual({
      transport: "remote", name: "my-mcp", type: "http", url: "https://mcp.example.com/route",
      headers: [
        { name: "CF-Access-Client-Id", value: "", gap: { kind: "variable", names: ["CF_ID"], before: "", after: "" } },
        { name: "CF-Access-Client-Secret", value: "", gap: { kind: "variable", names: ["CF_SECRET"], before: "", after: "" } },
      ],
    });
  });

  it("keeps real values, in either quote style, with -t, -H, --opt=value and the scope ignored", () => {
    const server = one(`claude mcp add -s user -t sse docs 'https://mcp.example.com/sse' -H 'X-Team: blue team' --header="Authorization: Bearer abc:def" --scope=project`);
    expect(server).toEqual({
      transport: "remote", name: "docs", type: "sse", url: "https://mcp.example.com/sse",
      headers: [{ name: "X-Team", value: "blue team" }, { name: "Authorization", value: "Bearer abc:def" }],
    });
    expect(one(`claude mcp add -t http q https://q.example/mcp -H "Quote: say \\"hi\\" \\$5"`)).toMatchObject({ headers: [{ name: "Quote", value: "say \"hi\" $5" }] });
  });

  it("treats ${VAR}, $(command) and a variable inside a value the same way, keeping the text around one variable", () => {
    const server = one(`claude mcp add --transport http api https://api.example.com/mcp -H "Authorization: Bearer \${API_TOKEN}" -H "X-Key: $(op read op://vault/key)" -H "Both: $A-$B"`);
    if (server.transport !== "remote") throw new Error("remote expected");
    expect(server.headers).toEqual([
      { name: "Authorization", value: "", gap: { kind: "variable", names: ["API_TOKEN"], before: "Bearer ", after: "" } },
      { name: "X-Key", value: "", gap: { kind: "variable", names: ["op read op://vault/key"], before: "", after: "" } },
      { name: "Both", value: "", gap: { kind: "variable", names: ["A", "B"], before: "", after: "" } },
    ]);
  });

  it("asks for placeholders the instructions left in, in the address too", () => {
    const server = one(`claude mcp add --transport http acme https://<your-tenant>.example.com/mcp --header "Authorization: Bearer YOUR_API_KEY"`);
    expect(server).toMatchObject({
      url: "https://<your-tenant>.example.com/mcp",
      urlGap: { kind: "placeholder", names: ["your-tenant"] },
      headers: [{ name: "Authorization", value: "", gap: { kind: "placeholder", names: ["YOUR_API_KEY"], before: "Bearer ", after: "" } }],
    });
  });

  it("joins continued lines from bash, PowerShell, cmd and Windows line endings", () => {
    const expected = { url: "https://mcp.example.com/route", headers: [{ name: "A", value: "1" }, { name: "B", value: "2" }] };
    expect(one("claude mcp add --transport http g https://mcp.example.com/route \\\r\n  -H \"A: 1\" \\\r\n  -H \"B: 2\"")).toMatchObject(expected);
    expect(one("claude mcp add --transport http g https://mcp.example.com/route `\n  -H \"A: 1\" `\n  -H \"B: 2\"")).toMatchObject(expected);
    expect(one("claude mcp add --transport http g https://mcp.example.com/route ^\n  -H \"A: 1\" ^\n  -H \"B: 2\"")).toMatchObject(expected);
    expect(one("claude mcp add --transport http g \"https://mcp.example.com/\\\nroute\" -H \"A: 1\" -H \"B: 2\"")).toMatchObject(expected);
  });

  it("reads a stdio server: -e values, the command after --, and several -e values after one flag", () => {
    expect(one(`claude mcp add github -e GITHUB_TOKEN=ghp_abc -e MODE=read -- npx -y @modelcontextprotocol/server-github --read-only`)).toEqual({
      transport: "stdio", name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github", "--read-only"],
      env: [{ name: "GITHUB_TOKEN", value: "ghp_abc" }, { name: "MODE", value: "read" }],
    });
    expect(one(`claude mcp add --transport stdio --env AIRTABLE_KEY=$AIRTABLE_KEY MODE=x airtable -- npx -y airtable-mcp-server`)).toEqual({
      transport: "stdio", name: "airtable", command: "npx", args: ["-y", "airtable-mcp-server"],
      env: [{ name: "AIRTABLE_KEY", value: "", gap: { kind: "variable", names: ["AIRTABLE_KEY"], before: "", after: "" } }, { name: "MODE", value: "x" }],
    });
  });

  it("takes several commands, one per line or joined by &&, as several servers", () => {
    const names = (text: string) => servers(readMcpPaste(text)).map((server) => server.name);
    expect(names(`# the two servers\n$ claude mcp add --transport http one https://one.example/mcp\nclaude mcp add --transport http two https://two.example/mcp`)).toEqual(["one", "two"]);
    expect(names(`claude mcp add --transport http one https://one.example/mcp && claude mcp add --transport http two https://two.example/mcp`)).toEqual(["one", "two"]);
    expect(readMcpPaste(`claude mcp add --transport http one https://one.example/mcp && echo done`)).toEqual({ ok: false, error: "mcp.paste.notRecognized" });
  });

  it("survives typographic quotes and dashes from a document", () => {
    expect(one("claude mcp add —transport http docs https://docs.example/mcp —header “X-Key: k1”")).toMatchObject({ type: "http", headers: [{ name: "X-Key", value: "k1" }] });
  });

  it("gives a name OpenMausBot keeps for itself an mcp- prefix and a taken one a number", () => {
    expect(one("claude mcp add --transport http browser https://b.example/mcp").name).toBe("mcp-browser");
    expect(one(GATEWAY, ["my-mcp"]).name).toBe("my-mcp-2");
    expect(one(GATEWAY, ["my-mcp", "my-mcp-2"]).name).toBe("my-mcp-3");
  });
});

describe("pasting claude mcp add-json", () => {
  it("reads an http entry with a ${VAR} header", () => {
    expect(one(`claude mcp add-json gate '{"type":"http","url":"https://mcp.example.com/route","headers":{"CF-Access-Client-Id":"\${CF_ID}","X-Plain":"v"}}' --scope user`)).toEqual({
      transport: "remote", name: "gate", type: "http", url: "https://mcp.example.com/route",
      headers: [{ name: "CF-Access-Client-Id", value: "", gap: { kind: "variable", names: ["CF_ID"], before: "", after: "" } }, { name: "X-Plain", value: "v" }],
    });
  });

  it("reads a stdio entry, and a broken one is said to be broken", () => {
    expect(one(`claude mcp add-json weather '{"type":"stdio","command":"uvx","args":["weather-mcp"],"env":{"KEY":"k"}}'`)).toEqual({
      transport: "stdio", name: "weather", command: "uvx", args: ["weather-mcp"], env: [{ name: "KEY", value: "k" }],
    });
    expect(readMcpPaste(`claude mcp add-json weather '{"type":"stdio",'`)).toEqual({ ok: false, error: "mcp.paste.badJson" });
  });
});

describe("pasting anything else", () => {
  it("reads a bare address, naming it after the host", () => {
    expect(one("https://mcp.acme.example/mcp")).toEqual({ transport: "remote", name: "acme", type: "http", url: "https://mcp.acme.example/mcp", headers: [] });
    expect(one("  https://api.example.org/sse  ")).toMatchObject({ name: "example", type: "sse" });
    expect(one("https://mcp.acme.example/mcp", ["acme"]).name).toBe("acme-2");
  });

  it("reads an mcpServers block, a VS Code servers block and a single entry", () => {
    const block = servers(readMcpPaste(JSON.stringify({ mcpServers: {
      Notes: { command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_TOKEN: "<token>" } },
      docs: { type: "streamable-http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer abc" } },
    } })));
    expect(block).toEqual([
      { transport: "stdio", name: "notes", command: "npx", args: ["-y", "notes-mcp"], env: [{ name: "NOTES_TOKEN", value: "", gap: { kind: "placeholder", names: ["token"], before: "", after: "" } }] },
      { transport: "remote", name: "docs", type: "http", url: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", value: "Bearer abc" }] },
    ]);
    expect(one(JSON.stringify({ servers: { gh: { type: "http", url: "https://api.code.example/mcp/", headers: { Authorization: "Bearer ${input:github_token}" } } } })))
      .toMatchObject({ name: "gh", headers: [{ name: "Authorization", value: "", gap: { names: ["github_token"], before: "Bearer " } }] });
    expect(one(JSON.stringify({ command: "npx -y @modelcontextprotocol/server-everything" }))).toEqual({
      transport: "stdio", name: "everything", command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"], env: [],
    });
  });

  it("reads npx, uvx, pnpm dlx and docker lines, moving docker's -e values out of the arguments", () => {
    expect(one("GITHUB_TOKEN=abc npx -y @modelcontextprotocol/server-github")).toEqual({
      transport: "stdio", name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: [{ name: "GITHUB_TOKEN", value: "abc" }],
    });
    expect(one("uvx mcp-server-fetch")).toMatchObject({ name: "fetch", command: "uvx", args: ["mcp-server-fetch"] });
    expect(one("pnpm dlx @acme/mcp-server@1.2.0")).toMatchObject({ name: "acme", args: ["dlx", "@acme/mcp-server@1.2.0"] });
    expect(one("docker run -i --rm -v /data:/data -e GITHUB_TOKEN=ghp_secret -e MODE registry.example/acme/github-mcp-server:latest stdio")).toEqual({
      transport: "stdio", name: "github", command: "docker",
      args: ["run", "-i", "--rm", "-v", "/data:/data", "-e", "GITHUB_TOKEN", "-e", "MODE", "registry.example/acme/github-mcp-server:latest", "stdio"],
      env: [{ name: "GITHUB_TOKEN", value: "ghp_secret" }, { name: "MODE", value: "", gap: { kind: "variable", names: ["MODE"], before: "", after: "" } }],
    });
  });

  it("says plainly that garbage isn't a server, and never echoes a value it read", () => {
    for (const garbage of ["hello world", "please connect my server", "rm -rf /", "claude --help", "git clone https://example.com/x.git", "claude mcp list", "npm install", "{}", "[1, 2]", "{\"mcpServers\": {\"a\": 5}}"]) {
      expect(readMcpPaste(garbage), garbage).toEqual({ ok: false, error: "mcp.paste.notRecognized" });
    }
    expect(readMcpPaste(`claude mcp add --transport http x https://x.example/mcp -H "unterminated`)).toEqual({ ok: false, error: "mcp.paste.notRecognized" });
    expect(readMcpPaste("{\"mcpServers\": ")).toEqual({ ok: false, error: "mcp.paste.badJson" });
    expect(readMcpPaste("claude mcp add --transport http lonely")).toEqual({ ok: false, error: "mcp.paste.incomplete" });
    const noColon = readMcpPaste(`claude mcp add --transport http x https://x.example/mcp -H "Authorization Bearer sk-live-123"`);
    expect(noColon).toEqual({ ok: false, error: "mcp.paste.badPair" });
    expect(JSON.stringify(noColon)).not.toContain("sk-live-123");
    expect(readMcpPaste("   \n ")).toBeNull();
  });
});

describe("the pieces", () => {
  it("splits shell words like a POSIX shell", () => {
    expect(shellCommands(`a 'b c' "d \\"e\\"" f\\ g # comment\nh;i && j`)).toEqual([["a", "b c", "d \"e\"", "f g"], ["h"], ["i"], ["j"]]);
    expect(shellCommands(`x 'single $NOT expanded' "$(echo a b)"`)).toEqual([["x", "single $NOT expanded", "$(echo a b)"]]);
  });

  it("finds a variable or placeholder only where nothing real could be", () => {
    expect(gapIn("abc123")).toBeUndefined();
    expect(gapIn("Bearer sk-live-123")).toBeUndefined();
    expect(gapIn("price$")).toBeUndefined();
    expect(gapIn("$CF_ID")).toEqual({ kind: "variable", names: ["CF_ID"], before: "", after: "" });
    expect(gapIn("${CF_ID:-fallback}")).toEqual({ kind: "variable", names: ["CF_ID"], before: "", after: "" });
    expect(gapIn("key=<api key>;v=1")).toEqual({ kind: "placeholder", names: ["api key"], before: "key=", after: ";v=1" });
  });
});
