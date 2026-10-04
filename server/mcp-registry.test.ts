import { describe, expect, it } from "vitest";

import {
  addDisabledMcpServer,
  listMcpServers,
  MAX_MCP_SERVERS,
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

describe("addDisabledMcpServer", () => {
  const notes = { command: "old", args: ["a"], env: { TOKEN: "kept" }, enabled: true };

  it("stores a stdio server and a remote url server switched off, secrets included", () => {
    expect(addDisabledMcpServer({}, {
      name: "notes",
      command: "npx",
      args: ["-y", "notes-mcp"],
      env: { NOTES_TOKEN: "secret-token" },
      note: "dropped",
    })).toEqual({
      ok: true,
      name: "notes",
      server: { command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_TOKEN: "secret-token" }, enabled: false },
      next: { notes: { command: "npx", args: ["-y", "notes-mcp"], env: { NOTES_TOKEN: "secret-token" }, enabled: false } },
    });
    const remote = {
      type: "sse" as const,
      url: "https://docs.example/mcp",
      headers: { Authorization: "Bearer real" },
      oauth: { clientId: "corp-app", clientSecret: "app-secret", scopes: ["mcp.read"] },
      enabled: false,
    };
    expect(addDisabledMcpServer({}, {
      name: "docs",
      url: remote.url,
      type: "sse",
      headers: remote.headers,
      oauth: { clientId: "corp-app", clientSecret: "app-secret", scopes: ["mcp.read"] },
    })).toEqual({ ok: true, name: "docs", server: remote, next: { docs: remote } });
  });

  it("refuses a body that contains enabled and leaves the map unchanged", () => {
    const current = { notes: { ...notes } };
    expect(addDisabledMcpServer(current, { name: "other", command: "npx", enabled: true })).toEqual({
      ok: false,
      status: 400,
      error: "A bot cannot change the on/off switch. The server is saved off, and only the user can turn it on in MCP server settings.",
    });
    expect(addDisabledMcpServer(current, { name: "other", command: "npx", enabled: false }).ok).toBe(false);
    expect(current).toEqual({ notes });
  });

  it("refuses an existing name and leaves that server unchanged", () => {
    const current = { notes: { ...notes }, other: { command: "stay", args: [], env: {}, enabled: false } };
    const before = structuredClone(current);
    expect(addDisabledMcpServer(current, { name: "notes", command: "new", env: { TOKEN: "nope" }, enabled: false })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(addDisabledMcpServer(current, { name: "notes", command: "new", env: { TOKEN: "nope" } })).toEqual({
      ok: false,
      status: 409,
      error: "An MCP server with that name already exists.",
    });
    expect(current).toEqual(before);
  });

  it("refuses a new server once the installation is already full", () => {
    const current: Record<string, unknown> = {};
    for (let i = 0; i < MAX_MCP_SERVERS; i++) current[`s${i}`] = { command: "x", args: [], env: {}, enabled: false };
    const before = structuredClone(current);
    expect(addDisabledMcpServer(current, { name: "extra", command: "npx" })).toEqual({
      ok: false,
      status: 400,
      error: `You can add at most ${MAX_MCP_SERVERS} MCP servers.`,
    });
    expect(addDisabledMcpServer(current, { name: "s0", command: "new" })).toMatchObject({ ok: false, status: 409 });
    expect(current).toEqual(before);
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

describe("a url server's sign-in app", () => {
  const url = "https://docs.example/mcp";
  const saved = {
    type: "http" as const, url, headers: {}, enabled: true,
    oauth: { clientId: "corp-app", clientSecret: "app-secret-value", scopes: ["api://mcp/read"] },
  };

  it("stores a client id, secret and scopes, and lists only whether a secret is saved", () => {
    expect(parseStoredMcpServer("docs", { url, oauth: { clientId: " corp-app ", scopes: ["a", "a", "offline_access"] } })).toEqual({
      ok: true,
      server: { type: "http", url, headers: {}, oauth: { clientId: "corp-app", scopes: ["a", "offline_access"] }, enabled: true },
    });
    const listings = listMcpServers({ docs: saved });
    expect(listings).toEqual([{
      name: "docs", type: "http", url, headerKeys: [], enabled: true,
      oauth: { clientId: "corp-app", scopes: ["api://mcp/read"], clientSecretConfigured: true },
    }]);
    expect(JSON.stringify(listings)).not.toContain("app-secret-value");
  });

  it("keeps a saved secret behind a placeholder only for the same client id", () => {
    expect(parseMcpServerMutation("docs", { url, oauth: { clientId: "corp-app", clientSecret: true } }, saved)).toEqual({
      ok: true,
      server: { type: "http", url, headers: {}, oauth: { clientId: "corp-app", clientSecret: "app-secret-value" }, enabled: true },
    });
    expect(parseMcpServerMutation("docs", { url, oauth: { clientId: "other-app", clientSecret: true } }, saved)).toEqual({
      ok: false, error: "No client secret is saved for this client ID. Enter it again, or leave it out for an app without one.",
    });
    expect(parseMcpServerMutation("docs", { url, oauth: { clientId: "corp-app", clientSecret: true } })).toMatchObject({ ok: false });
    // a stored entry never takes the placeholder
    expect(parseStoredMcpServer("docs", { url, oauth: { clientId: "corp-app", clientSecret: true } })).toMatchObject({ ok: false });
    // leaving the app out removes it, secret and all
    expect(parseMcpServerMutation("docs", { url }, saved)).toEqual({ ok: true, server: { type: "http", url, headers: {}, enabled: true } });
  });

  it("refuses an empty client id, a scope with spaces and unknown fields, with a sentence that teaches", () => {
    expect(parseStoredMcpServer("docs", { url, oauth: { clientId: "  " } })).toEqual({
      ok: false, error: "Enter the client ID of the app registered with this server's sign-in provider.",
    });
    expect(parseStoredMcpServer("docs", { url, oauth: { clientId: "a", scopes: ["read write"] } })).toEqual({
      ok: false, error: "Scopes are single words, like offline_access or api://my-app/mcp.read.",
    });
    expect(parseStoredMcpServer("docs", { url, oauth: { clientId: "a", callbackPort: 8080 } })).toMatchObject({ ok: false });
  });
});
