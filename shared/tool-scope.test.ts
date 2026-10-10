import { describe, expect, it } from "vitest";

import { allowsTool, canUseMcpServer, narrowsNativeTools, parseToolScope, toolScopeWidens } from "./tool-scope.ts";

describe("per-bot tool selection", () => {
  it("distinguishes native restrictions from an MCP-only clamp", () => {
    for (const scope of [undefined, {}, { deny: [] }, { allow: ["native:*", "mcp:notes:read"] }, { deny: ["mcp:notes:*"] }]) expect(narrowsNativeTools(scope)).toBe(false);
    for (const scope of [{ allow: [] }, { allow: ["mcp:notes:read"] }, { deny: ["native:read"] }, { allow: ["native:*"], deny: ["native:bash"] }, { allow: "all" }]) expect(narrowsNativeTools(scope)).toBe(true);
  });
  it("keeps legacy tools available when no selection exists", () => {
    expect(allowsTool(undefined, { kind: "native", name: "bash" })).toBe(true);
    expect(allowsTool(undefined, { kind: "mcp", server: "computer", name: "click" })).toBe(true);
    expect(allowsTool({}, { kind: "mcp", server: "agents", name: "ask_bot" })).toBe(true);
  });

  it("gives a drafter only its selected native tools", () => {
    const scope = { allow: ["native:read", "native:edit", "native:write"] };
    expect(allowsTool(scope, { kind: "native", name: "read" })).toBe(true);
    expect(allowsTool(scope, { kind: "native", name: "edit" })).toBe(true);
    expect(allowsTool(scope, { kind: "native", name: "write" })).toBe(true);
    expect(allowsTool(scope, { kind: "native", name: "bash" })).toBe(false);
    expect(allowsTool(scope, { kind: "mcp", server: "computer", name: "read" })).toBe(false);
    expect(allowsTool(scope, { kind: "mcp", server: "agents", name: "list_bots" })).toBe(false);
  });

  it("gives a mail bot the selected server while a deny still excludes sending", () => {
    const scope = { allow: ["mcp:fastmail:*"], deny: ["mcp:fastmail:send_mail"] };
    expect(allowsTool(scope, { kind: "mcp", server: "fastmail", name: "search_mail" })).toBe(true);
    expect(allowsTool(scope, { kind: "mcp", server: "fastmail", name: "send_mail" })).toBe(false);
    expect(allowsTool(scope, { kind: "mcp", server: "agents", name: "search_mail" })).toBe(false);
    expect(allowsTool(scope, { kind: "native", name: "bash" })).toBe(false);
  });

  it("treats an empty allowlist as no tools and deny-only scope as a restriction", () => {
    expect(allowsTool({ allow: [] }, { kind: "native", name: "read" })).toBe(false);
    expect(allowsTool({ allow: [] }, { kind: "mcp", server: "fastmail", name: "search_mail" })).toBe(false);
    expect(allowsTool({ deny: ["native:bash"] }, { kind: "native", name: "read" })).toBe(true);
    expect(allowsTool({ deny: ["native:bash"] }, { kind: "native", name: "bash" })).toBe(false);
    expect(allowsTool({ allow: ["native:*"], deny: ["native:write"] }, { kind: "native", name: "write" })).toBe(false);
  });

  it("matches original names without alias, case or namespace confusion", () => {
    const scope = { allow: ["mcp:notes:read-notes", "mcp:notes:namespace:read", "native:read"] };
    expect(allowsTool(scope, { kind: "mcp", server: "notes", name: "read-notes" })).toBe(true);
    expect(allowsTool(scope, { kind: "mcp", server: "notes", name: "read_notes" })).toBe(false);
    expect(allowsTool(scope, { kind: "mcp", server: "notes", name: "namespace:read" })).toBe(true);
    expect(allowsTool(scope, { kind: "mcp", server: "notes", name: "Read-notes" })).toBe(false);
    expect(allowsTool(scope, { kind: "mcp", server: "notes-other", name: "read-notes" })).toBe(false);
    expect(allowsTool(scope, { kind: "native", name: "notes_read_notes" })).toBe(false);
    expect(allowsTool(scope, { kind: "mcp", server: "notes", name: "read" })).toBe(false);
  });

  it.each([
    null, false, "all", [], { allow: "*" }, { allow: undefined }, { deny: null },
    { enabled: true }, { allow: ["native:read", 42] }, { allow: ["read"] },
    { allow: ["native:"] }, { allow: ["mcp:notes:"] }, { allow: ["mcp:*:read"] },
    { allow: ["mcp:Notes:read"] }, { allow: ["mcp:notes:read*"] },
    { allow: ["native:read*"] }, { allow: ["native:read\n"] },
    { allow: ["native:read\u0000"] }, { allow: ["mcp:notes:read\u007f"] },
    { allow: Array.from({ length: 257 }, (_, i) => `native:tool_${i}`) },
    { allow: [`native:${"x".repeat(1024)}`] },
    JSON.parse('{"__proto__":{"allow":["native:read"]}}'),
    Object.create({ allow: ["native:read"] }), { allow: Array(1) },
    Object.defineProperty({}, "allow", { get: () => ["native:read"] }),
  ])("rejects malformed selection %j without granting a valid tool", (scope) => {
    expect(parseToolScope(scope).ok).toBe(false);
    expect(allowsTool(scope, { kind: "native", name: "read" })).toBe(false);
    expect(allowsTool(scope, { kind: "mcp", server: "notes", name: "read" })).toBe(false);
    expect(canUseMcpServer(scope, "notes")).toBe(false);
  });

  it("normalizes duplicate entries without turning an explicit empty allow into inheritance", () => {
    expect(parseToolScope(undefined)).toEqual({ ok: true, scope: undefined });
    expect(parseToolScope({ allow: [], deny: ["native:bash", "native:bash"] })).toEqual({
      ok: true, scope: { allow: [], deny: ["native:bash"] },
    });
    expect(parseToolScope({ allow: ["native:read", "native:read", "mcp:notes:read"] })).toEqual({
      ok: true, scope: { allow: ["native:read", "mcp:notes:read"] },
    });
  });

  it("never mounts a server with no permitted tools", () => {
    expect(canUseMcpServer(undefined, "agents")).toBe(true);
    expect(canUseMcpServer({ allow: [] }, "agents")).toBe(false);
    expect(canUseMcpServer({ allow: ["native:read"] }, "agents")).toBe(false);
    expect(canUseMcpServer({ allow: ["mcp:fastmail:search_mail"] }, "agents")).toBe(false);
    expect(canUseMcpServer({ allow: ["mcp:agents:ask_bot"], deny: ["mcp:agents:ask_bot"] }, "agents")).toBe(false);
    expect(canUseMcpServer({ allow: ["mcp:agents:*"], deny: ["mcp:agents:ask_bot"] }, "agents")).toBe(true);
    expect(canUseMcpServer({ deny: ["mcp:agents:*"] }, "agents")).toBe(false);
    expect(canUseMcpServer({ allow: ["mcp:agents:unknown"] }, "agents", ["ask_bot", "list_bots"])).toBe(false);
    expect(canUseMcpServer({ allow: ["mcp:agents:ask_bot"] }, "agents", ["ask_bot", "list_bots"])).toBe(true);
    expect(canUseMcpServer(undefined, "agents", [])).toBe(false);
  });

  it("detects added authority without mistaking narrower or equivalent selections for widening", () => {
    expect(toolScopeWidens({ allow: ["native:read"] }, { allow: ["native:edit", "native:read"] })).toBe(true);
    expect(toolScopeWidens({ allow: ["native:*"] }, { allow: ["native:read"] })).toBe(false);
    expect(toolScopeWidens({ allow: ["native:read", "native:edit"] }, { allow: ["native:edit", "native:read"] })).toBe(false);
    expect(toolScopeWidens({ allow: ["mcp:notes:read"] }, { allow: ["mcp:notes:*"] })).toBe(true);
    expect(toolScopeWidens({ allow: ["mcp:notes:*"] }, { allow: ["mcp:notes:read"] })).toBe(false);
    expect(toolScopeWidens({ deny: ["mcp:notes:*"] }, { deny: ["mcp:notes:write"] })).toBe(true);
    expect(toolScopeWidens(undefined, { deny: ["native:bash"] })).toBe(false);
    expect(toolScopeWidens({ allow: ["native:read"] }, undefined)).toBe(true);
    expect(toolScopeWidens({ allow: null }, { allow: [] })).toBe(false);
    expect(toolScopeWidens({ allow: null }, { allow: ["native:read"] })).toBe(true);
  });
});
