import { describe, expect, it } from "vitest";

import {
  listMcpServers,
  mcpServerNameError,
  parseMcpServerMutation,
  parseMcpServersImport,
  parseStoredMcpServer,
} from "./mcp-registry.ts";

describe("custom MCP registry", () => {
  it("parses stdio servers and keeps newly added commands disabled", () => {
    expect(parseMcpServerMutation("notes", { command: "npx", args: ["-y", "notes-mcp"] })).toEqual({
      ok: true,
      server: { command: "npx", args: ["-y", "notes-mcp"], env: {}, enabled: false },
    });
    expect(parseStoredMcpServer("notes", { command: "npx" })).toEqual({
      ok: true,
      server: { command: "npx", args: [], env: {}, enabled: true },
    });
  });

  it("refuses unsafe and reserved routing names", () => {
    expect(mcpServerNameError("Bad.Name")).toMatch(/lowercase/);
    expect(mcpServerNameError("computer")).toMatch(/reserved/);
    expect(mcpServerNameError("safe-notes")).toBeNull();
  });

  it("refuses harness-owned environment names in stored and renderer entries", () => {
    for (const key of ["OMB_HARNESS_URL", "OGB_BOX_TOKEN", "ELECTRON_RUN_AS_NODE"]) {
      expect(parseStoredMcpServer("notes", { command: "notes-mcp", env: { [key]: "bad" } })).toEqual({
        ok: false,
        error: `Environment variable “${key}” is reserved by OpenMausBot.`,
      });
      expect(parseMcpServerMutation("notes", { command: "notes-mcp", env: { [key]: "bad" } })).toEqual({
        ok: false,
        error: `Environment variable “${key}” is reserved by OpenMausBot.`,
      });
    }
  });

  it("never puts environment values in renderer listings", () => {
    const listings = listMcpServers({
      github: { command: "github-mcp", env: { GITHUB_TOKEN: "ghp_real", MODE: "read-only" } },
    });
    expect(listings).toEqual([{
      name: "github",
      command: "github-mcp",
      args: [],
      envKeys: ["GITHUB_TOKEN", "MODE"],
      enabled: true,
    }]);
    expect(JSON.stringify(listings)).not.toContain("ghp_real");
    expect(JSON.stringify(listings)).not.toContain("read-only");
  });

  it("preserves write-only values only when a matching value is stored", () => {
    const existing = { command: "old", args: [], env: { TOKEN: "secret", DROP: "gone" }, enabled: true };
    expect(parseMcpServerMutation("notes", {
      command: "new",
      env: { TOKEN: true, NEXT: "fresh" },
      enabled: true,
    }, existing)).toEqual({
      ok: true,
      server: { command: "new", args: [], env: { TOKEN: "secret", NEXT: "fresh" }, enabled: true },
    });
    expect(parseMcpServerMutation("notes", { command: "new", env: { MISSING: true } }, existing)).toEqual({
      ok: false,
      error: "No saved value exists for MISSING.",
    });
  });

});

describe("parseMcpServersImport", () => {
  // The block every other agent tool shares: Claude Code, Cursor and Claude
  // Desktop all write {"mcpServers": {name: {command, args, env}}}. Pasting
  // it here should just work, with the same rules as the form.
  it("reads the standard mcpServers block, disabled until explicitly enabled", () => {
    const result = parseMcpServersImport(JSON.stringify({
      mcpServers: {
        notes: { command: "npx", args: ["-y", "@example/notes-mcp"], env: { NOTES_TOKEN: "t" } },
        "Linear Tasks": { command: "linear-mcp" },
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.servers)).toEqual(["notes", "linear-tasks"]);
    expect(result.servers.notes).toEqual({ command: "npx", args: ["-y", "@example/notes-mcp"], env: { NOTES_TOKEN: "t" }, enabled: false });
    expect(result.servers["linear-tasks"]).toEqual({ command: "linear-mcp", args: [], env: {}, enabled: false });
  });

  it("accepts a bare map, one server, or a single entry with a name", () => {
    const bare = parseMcpServersImport('{"fs": {"command": "mcp-fs", "args": ["/tmp"]}}');
    expect(bare.ok && Object.keys(bare.servers)).toEqual(["fs"]);
    const single = parseMcpServersImport('{"name": "fs", "command": "mcp-fs"}');
    expect(single.ok && Object.keys(single.servers)).toEqual(["fs"]);
  });

  it("imports executable paths with spaces without treating them as shell commands", () => {
    for (const command of ["/Applications/Fixture Tools/mcp", "C:\\Program Files\\Fixture\\mcp.exe"]) {
      expect(parseMcpServersImport(JSON.stringify({ constructor: { command, enabled: true } }))).toEqual({
        ok: true, servers: { constructor: { command, args: [], env: {}, enabled: false } },
      });
    }
  });

  it("rejects colliding normalized names and invalid late entries without returning a partial import", () => {
    expect(parseMcpServersImport(JSON.stringify({ "Notes App": { command: "notes" }, "notes-app": { command: "other" } })))
      .toMatchObject({ ok: false, error: expect.stringMatching(/twice/) });
    expect(parseMcpServersImport(JSON.stringify({ good: { command: "notes" }, bad: { command: "other", env: { TOKEN: true } } })))
      .toMatchObject({ ok: false });
  });

  it("accepts remote servers in their own shape, refuses reserved names and junk", () => {
    expect(parseMcpServersImport('{"mcpServers": {"web": {"type": "http", "url": "https://x.example/mcp", "headers": {"Authorization": "Bearer t"}, "enabled": true}}}')).toEqual({
      ok: true,
      // enabled from the paste is dropped: nothing is reached before it was tested
      servers: { web: { type: "http", url: "https://x.example/mcp", headers: { Authorization: "Bearer t" }, enabled: false } },
    });
    expect(parseMcpServersImport('{"name": "docs", "url": "https://x.example/sse", "type": "sse"}')).toEqual({
      ok: true,
      servers: { docs: { type: "sse", url: "https://x.example/sse", headers: {}, enabled: false } },
    });
    expect(parseMcpServersImport('{"mcpServers": {"web": {"url": "x.example/mcp"}}}')).toMatchObject({ ok: false, error: expect.stringMatching(/full address/) });
    expect(parseMcpServersImport('{"mcpServers": {"computer": {"command": "x"}}}')).toMatchObject({ ok: false, error: expect.stringMatching(/reserved/i) });
    expect(parseMcpServersImport('{"mcpServers": {"ok": {"command": "x", "env": {"OMB_TOKEN": "1"}}}}')).toMatchObject({ ok: false });
    expect(parseMcpServersImport("not json")).toMatchObject({ ok: false, error: expect.stringMatching(/JSON/i) });
    expect(parseMcpServersImport("[]")).toMatchObject({ ok: false });
  });
});

describe("remote (url) MCP servers", () => {
  it("parses a url entry, defaulting to streamable HTTP; a new one starts off", () => {
    expect(parseMcpServerMutation("docs", { url: "https://docs.example/mcp", headers: { Authorization: "Bearer t" } })).toEqual({
      ok: true,
      server: { type: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer t" }, enabled: false },
    });
    expect(parseStoredMcpServer("docs", { type: "sse", url: "http://127.0.0.1:8123/sse" })).toEqual({
      ok: true,
      server: { type: "sse", url: "http://127.0.0.1:8123/sse", headers: {}, enabled: true },
    });
  });

  it("refuses bad addresses, header names and mixed shapes", () => {
    expect(parseStoredMcpServer("docs", { url: "docs.example/mcp" })).toEqual({ ok: false, error: "Use a full address, like https://example.com/mcp." });
    expect(parseStoredMcpServer("docs", { url: "ftp://docs.example/mcp" })).toEqual({ ok: false, error: "The address must start with http:// or https://." });
    expect(parseStoredMcpServer("docs", { url: "https://user:pw@docs.example/mcp" })).toEqual({ ok: false, error: "Put credentials in a header, not in the address." });
    expect(parseStoredMcpServer("docs", { url: "https://docs.example/mcp", headers: { "Bad Header": "v" } })).toEqual({ ok: false, error: "Header “Bad Header” is not a valid header name." });
    expect(parseStoredMcpServer("docs", { url: "https://docs.example/mcp", headers: { "X-A": "a\nb" } })).toEqual({ ok: false, error: "Header “X-A” must be a single line." });
    expect(parseStoredMcpServer("docs", { url: "https://docs.example/mcp", command: "npx" })).toMatchObject({ ok: false });
    expect(parseStoredMcpServer("docs", { type: "http" })).toMatchObject({ ok: false });
  });

  it("lists a url server by address and header names only", () => {
    const listings = listMcpServers({ docs: { url: "https://docs.example/mcp", headers: { Authorization: "Bearer real", "X-Org": "acme" } } });
    expect(listings).toEqual([{ name: "docs", type: "http", url: "https://docs.example/mcp", headerKeys: ["Authorization", "X-Org"], enabled: true }]);
    expect(JSON.stringify(listings)).not.toContain("real");
    expect(JSON.stringify(listings)).not.toContain("acme");
  });

  it("keeps saved header values behind write-only placeholders", () => {
    const existing = { type: "http" as const, url: "https://docs.example/mcp", headers: { Authorization: "Bearer old" }, enabled: true };
    expect(parseMcpServerMutation("docs", { url: "https://docs.example/mcp", headers: { Authorization: true, "X-Org": "acme" } }, existing)).toEqual({
      ok: true,
      server: { type: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer old", "X-Org": "acme" }, enabled: true },
    });
    // a placeholder cannot borrow from a server of the other shape
    expect(parseMcpServerMutation(
      "docs",
      { url: "https://docs.example/mcp", headers: { Authorization: true } },
      { command: "old", args: [], env: { Authorization: "x" }, enabled: true },
    )).toEqual({ ok: false, error: "No saved value exists for Authorization." });
  });
});
