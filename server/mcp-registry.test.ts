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
    expect(mcpServerNameError("data")).toMatch(/reserved/);
    expect(parseStoredMcpServer("data", { command: "custom-data" })).toMatchObject({ ok: false, error: expect.stringMatching(/reserved/) });
    expect(mcpServerNameError("safe-notes")).toBeNull();
  });

  it("refuses harness-owned environment names in stored and renderer entries", () => {
    for (const key of ["OMB_HARNESS_URL", "OGB_BOX_TOKEN"]) {
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

  it("lets a custom server run an Electron binary as node, and nothing else", () => {
    const refused = "Environment variable “ELECTRON_RUN_AS_NODE” is reserved by OpenMausBot; a custom server may set it to “1” only.";
    expect(parseStoredMcpServer("notes", { command: "notes-mcp", env: { ELECTRON_RUN_AS_NODE: "0" } })).toEqual({ ok: false, error: refused });
    expect(parseMcpServerMutation("notes", { command: "notes-mcp", env: { ELECTRON_RUN_AS_NODE: "true" } })).toEqual({ ok: false, error: refused });
    const stored = parseStoredMcpServer("bundled", {
      command: "/Applications/App.app/Contents/MacOS/App",
      args: ["server.js"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(stored).toMatchObject({ ok: true, server: { env: { ELECTRON_RUN_AS_NODE: "1" } } });
    if (!stored.ok) throw new Error(stored.error);
    // A "keep the saved value" placeholder judges the saved value.
    expect(parseMcpServerMutation("bundled", { command: "other", env: { ELECTRON_RUN_AS_NODE: true } }, stored.server)).toMatchObject({ ok: true });
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
      apps: true,
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
    expect(listings).toEqual([{ name: "docs", type: "http", url: "https://docs.example/mcp", headerKeys: ["Authorization", "X-Org"], enabled: true, apps: true }]);
    expect(JSON.stringify(listings)).not.toContain("real");
    expect(JSON.stringify(listings)).not.toContain("acme");
  });

  it("keeps saved header values behind write-only placeholders", () => {
    const existing = { type: "http" as const, url: "https://docs.example/mcp", headers: { Authorization: "Bearer old" }, enabled: true };
    expect(parseMcpServerMutation("docs", { url: "https://docs.example/mcp", headers: { Authorization: true, "X-Org": "acme" } }, existing)).toEqual({
      ok: true,
      server: { type: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer old", "X-Org": "acme" }, enabled: true },
    });
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
      name: "docs", type: "http", url, headerKeys: [], enabled: true, apps: true,
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
    expect(parseStoredMcpServer("docs", { url, oauth: { clientId: "corp-app", clientSecret: true } })).toMatchObject({ ok: false });
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

describe("a server's result size limit", () => {
  it("is stored, listed, and optional", () => {
    expect(parseMcpServerMutation("motion", { command: "effectcraft-mcp", resultBudget: 40_000 })).toEqual({
      ok: true,
      server: { command: "effectcraft-mcp", args: [], env: {}, enabled: false, resultBudget: 40_000 },
    });
    expect(parseMcpServerMutation("docs", { url: "https://docs.example/mcp", resultBudget: 0 })).toMatchObject({ ok: true, server: { resultBudget: 0 } });
    const plain = parseMcpServerMutation("notes", { command: "notes-mcp" });
    expect(plain.ok && "resultBudget" in plain.server).toBe(false);
    const listings = listMcpServers({ motion: { command: "effectcraft-mcp", resultBudget: 40_000 }, docs: { url: "https://docs.example/mcp", resultBudget: 0 }, notes: { command: "notes-mcp" } });
    expect(listings.map((l) => l.resultBudget)).toEqual([40_000, 0, undefined]);
  });

  it("refuses a negative, fractional, oversized or non-numeric limit", () => {
    for (const resultBudget of [-1, 1.5, 3_000_000, "40000"]) {
      expect(parseMcpServerMutation("motion", { command: "effectcraft-mcp", resultBudget })).toMatchObject({ ok: false, error: expect.stringMatching(/result size limit/i) });
    }
  });

  it("survives a pasted config block", () => {
    const parsed = parseMcpServersImport(JSON.stringify({ mcpServers: { motion: { command: "effectcraft-mcp", resultBudget: 40_000 } } }));
    expect(parsed).toMatchObject({ ok: true, servers: { motion: { resultBudget: 40_000 } } });
  });
});

describe("a server of another computer's", () => {
  const MAC = { environmentId: "env-desktop-1", label: "Milind's MacBook" };

  it("keeps the computer it runs on, which an edit keeps unless it says null, and lists it", () => {
    const stored = parseStoredMcpServer("notes", { command: "/usr/local/bin/notes-mcp", runsOn: MAC });
    expect(stored).toEqual({ ok: true, server: { command: "/usr/local/bin/notes-mcp", args: [], env: {}, enabled: true, runsOn: MAC } });
    if (!stored.ok) throw new Error("unreachable");
    expect(parseMcpServerMutation("notes", { command: "/usr/local/bin/notes-mcp", args: ["--quiet"] }, stored.server)).toMatchObject({ ok: true, server: { runsOn: MAC } });
    expect(parseMcpServerMutation("notes", { command: "notes-mcp", runsOn: null }, stored.server)).toMatchObject({ ok: true, server: expect.not.objectContaining({ runsOn: expect.anything() }) });
    expect(parseMcpServerMutation("docs", { type: "http", url: "http://127.0.0.1:9/mcp", runsOn: MAC })).toMatchObject({ ok: true, server: { runsOn: MAC } });
    expect(parseStoredMcpServer("notes", { command: "notes-mcp", runsOn: { environmentId: "../x", label: "Mac" } }).ok).toBe(false);
    expect(parseStoredMcpServer("notes", { command: "notes-mcp", runsOn: { environmentId: "e", label: "Mac", extra: 1 } }).ok).toBe(false);
    expect(listMcpServers({ notes: { command: "notes-mcp", runsOn: MAC }, docs: { type: "http", url: "http://127.0.0.1:9/mcp", runsOn: MAC } }))
      .toEqual([expect.objectContaining({ name: "notes", runsOn: MAC }), expect.objectContaining({ name: "docs", runsOn: MAC })]);
  });

  it("is never set by a bot or a pasted config block", () => {
    const added = addDisabledMcpServer({}, { name: "notes", command: "notes-mcp", runsOn: MAC });
    expect(added).toMatchObject({ ok: true, server: expect.not.objectContaining({ runsOn: expect.anything() }) });
    const pasted = parseMcpServersImport(JSON.stringify({ mcpServers: { notes: { command: "notes-mcp", runsOn: MAC } } }));
    expect(pasted).toMatchObject({ ok: true, servers: { notes: expect.not.objectContaining({ runsOn: expect.anything() }) } });
  });

  it("is never started here", async () => {
    const { customMcpServers } = await import("./config.ts");
    const servers = customMcpServers({ mcpServers: { notes: { command: "notes-mcp", runsOn: MAC }, dodo: { command: "npx", args: ["dodo"] } } } as never);
    expect(Object.keys(servers)).toEqual(["dodo"]);
  });
});

describe("the \"Show its apps in chat\" switch", () => {
  it("is on by default, stored only as apps: false, listed as a boolean, and kept by an edit that does not mention it", () => {
    expect(parseStoredMcpServer("draw", { type: "http", url: "https://mcp.excalidraw.com/mcp" })).toEqual({
      ok: true, server: { type: "http", url: "https://mcp.excalidraw.com/mcp", headers: {}, enabled: true },
    });
    const off = parseStoredMcpServer("draw", { type: "http", url: "https://mcp.excalidraw.com/mcp", apps: false });
    expect(off).toEqual({ ok: true, server: { type: "http", url: "https://mcp.excalidraw.com/mcp", headers: {}, enabled: true, apps: false } });
    expect(parseStoredMcpServer("draw", { command: "npx", apps: true })).toEqual({ ok: true, server: { command: "npx", args: [], env: {}, enabled: true } });
    expect(listMcpServers({ a: { command: "npx", apps: false }, b: { type: "http", url: "https://b.example/mcp" } }).map((server) => [server.name, server.apps]))
      .toEqual([["a", false], ["b", true]]);
    const existing = off.ok ? off.server : undefined;
    expect(parseMcpServerMutation("draw", { type: "http", url: "https://mcp.excalidraw.com/mcp", headers: {} }, existing)).toMatchObject({ ok: true, server: { apps: false } });
    expect(parseMcpServerMutation("draw", { type: "http", url: "https://mcp.excalidraw.com/mcp", apps: true }, existing)).toEqual({
      ok: true, server: { type: "http", url: "https://mcp.excalidraw.com/mcp", headers: {}, enabled: true },
    });
    expect(parseStoredMcpServer("draw", { command: "npx", apps: "no" }).ok).toBe(false);
  });
});
