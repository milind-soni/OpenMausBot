import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerKindForResource, ManagedDesktopPolicy, mcpEntryMatches, parseManagedPolicy, type ManagedPolicy } from "./managed-policy.ts";

const policies: ManagedDesktopPolicy[] = [];
afterEach(() => { for (const policy of policies.splice(0)) policy.close(); vi.useRealTimers(); });
function policy(overrides: Partial<ManagedPolicy> = {}): ManagedPolicy {
  return { organizationId: "11111111-1111-4111-8111-111111111111", organizationName: "Fixture Agency", expiresAt: Date.now() + 60_000, version: 3,
    companyModelsOnly: false, allowedEngines: "all", mcp: { allowCustom: true, allowlist: [] },
    computers: { thisComputer: true, localVm: true, box: true, vps: true }, remoteAccess: true, ...overrides };
}
function overlay(value: ManagedPolicy | null, now = () => Date.now()) {
  const onChange = vi.fn(), managed = new ManagedDesktopPolicy({ now, onChange });
  policies.push(managed); managed.apply(value);
  return { managed, onChange };
}

describe("organisation desktop policy overlay", () => {
  it("is inert until an enrolled parent sends a policy", () => {
    const { managed } = overlay(null);
    expect(managed.current()).toBeNull(); expect(managed.summary()).toBeNull();
    expect(managed.modelRefusal({ driverKind: "grok" }, false)).toBeUndefined();
    expect(managed.computerRefusal("thisComputer")).toBeUndefined();
    expect(managed.remoteAccessRefusal()).toBeUndefined();
    const servers = { anything: { url: "https://example.test/mcp" }, local: {} };
    expect(managed.filterMcp(servers)).toBe(servers);
    expect(managed.restrictsMcp()).toBe(false);
  });

  it("the default policy restricts nothing", () => {
    const { managed } = overlay(policy());
    expect(managed.modelRefusal({ driverKind: "grok", displayName: "Grok" }, false)).toBeUndefined();
    for (const kind of ["thisComputer", "localVm", "box", "vps"] as const) expect(managed.computerRefusal(kind)).toBeUndefined();
    expect(managed.mcpRefusal("anything", "https://example.test")).toBeUndefined();
    expect(managed.remoteAccessRefusal()).toBeUndefined();
  });

  it("refuses non-company instances and disallowed engines with a sentence naming the organisation", () => {
    const { managed } = overlay(policy({ companyModelsOnly: true, allowedEngines: ["claudeAgent", "codex"] }));
    expect(managed.modelRefusal({ driverKind: "claudeAgent", displayName: "Claude" }, false)).toBe("Fixture Agency allows only company models on this computer. Choose a Company model for this bot.");
    expect(managed.modelRefusal({ driverKind: "claudeAgent" }, true)).toBeUndefined();
    // Engine rules apply to Company instances too.
    expect(managed.modelRefusal({ driverKind: "openai-compat", displayName: "OpenAI-compatible" }, true)).toBe("Fixture Agency does not allow the OpenAI-compatible engine on this computer. Choose another model for this bot.");
    managed.apply(policy({ allowedEngines: ["codex"] }));
    expect(managed.modelRefusal({ driverKind: "claudeAgent", displayName: "Claude" }, false)).toMatch(/does not allow the Claude engine/);
    expect(managed.modelRefusal({ driverKind: "codex" }, false)).toBeUndefined();
  });

  it("filters MCP servers by name or address only while custom servers are off", () => {
    const servers = { github: { command: "npx" }, docs: { type: "http", url: "https://mcp.example.com/v1/mcp" }, other: { type: "http", url: "https://evil.example.test/mcp" }, notes: { command: "notes" } };
    const { managed } = overlay(policy({ mcp: { allowCustom: true, allowlist: ["github"] } }));
    expect(managed.filterMcp(servers)).toBe(servers);
    managed.apply(policy({ mcp: { allowCustom: false, allowlist: ["GitHub", "https://mcp.example.com/*"] } }));
    expect(Object.keys(managed.filterMcp(servers))).toEqual(["github", "docs"]);
    expect(managed.mcpRefusal("notes")).toBe("Fixture Agency allows only MCP servers it has approved. Ask your administrator to add this server to the approved list.");
    expect(managed.mcpRefusal("docs", "https://mcp.example.com/other")).toBeUndefined();
    expect(managed.mcpRefusal("docs", "https://mcp.example.com.evil.test/x")).toBeDefined();
    managed.apply(policy({ mcp: { allowCustom: false, allowlist: [] } }));
    expect(managed.filterMcp(servers)).toEqual({});
  });

  it.each([
    ["https://evil.test/x.example.com/mcp", "a wildcard never spans into the path"],
    ["https://a.example.com.evil.test/mcp", "the pattern's host must end the target's host"],
    ["https://a.example.com@evil.test/mcp", "credentials in the target are refused"],
    ["http://a.example.com/mcp", "only https matches"],
    ["https://a.example.com:8443/mcp", "the port must match"],
    ["https://example.com/mcp", "* stands for at least one label"],
    ["https://a.example.com/mcp/extra", "the path is literal outside *"],
    ["not a url", "an unparsable address never matches"],
  ])("refuses the bypass %s: %s", target => {
    expect(mcpEntryMatches("https://*.example.com/mcp", "x", target)).toBe(false);
  });

  it("matches whole host labels and wildcard paths", () => {
    expect(mcpEntryMatches("https://*.example.com/mcp", "x", "https://a.example.com/mcp")).toBe(true);
    expect(mcpEntryMatches("https://*.example.com/mcp", "x", "https://a.b.example.com/mcp?session=1")).toBe(true);
    expect(mcpEntryMatches("https://mcp*.example.com/mcp", "x", "https://mcp1.example.com/mcp")).toBe(false);
    expect(mcpEntryMatches("https://*/mcp", "x", "https://intranet/mcp")).toBe(false);
    expect(mcpEntryMatches("https://user:secret@mcp.example.com/*", "x", "https://mcp.example.com/a")).toBe(false);
    expect(mcpEntryMatches("http://mcp.example.com/*", "http", "http://mcp.example.com/a")).toBe(false);
  });

  it("matches address patterns literally except for the wildcard", () => {
    expect(mcpEntryMatches("https://mcp.example.com/*", "x", "https://mcp.example.com/a/b")).toBe(true);
    expect(mcpEntryMatches("https://mcp.example.com/*", "x", "https://mcpXexample.com/a")).toBe(false);
    expect(mcpEntryMatches("https://*.example.com/mcp", "x", "https://a.example.com/mcp")).toBe(true);
    expect(mcpEntryMatches("https://mcp.example.com/mcp", "x", undefined)).toBe(false);
    expect(mcpEntryMatches("https://mcp.example.com/(.*)", "x", "https://mcp.example.com/zzz")).toBe(false);
    expect(mcpEntryMatches("linear", "Linear")).toBe(true);
  });

  it("maps every computer claim to its kind and refuses disallowed ones", () => {
    expect(computerKindForResource("computer:host")).toBe("thisComputer");
    expect(computerKindForResource("computer:vm:shared")).toBe("localVm");
    expect(computerKindForResource("computer:box:abc")).toBe("box");
    expect(computerKindForResource("computer:box-bot:bot-1")).toBe("box");
    expect(computerKindForResource("computer:vps:alias:bot-1")).toBe("vps");
    expect(computerKindForResource("computer:phone")).toBeUndefined();
    const { managed } = overlay(policy({ computers: { thisComputer: false, localVm: true, box: false, vps: true } }));
    expect(managed.computerRefusal("thisComputer")).toBe("Fixture Agency does not allow bots to use this computer.");
    expect(managed.computerRefusal("box")).toBe("Fixture Agency does not allow bots to use Box cloud computers.");
    expect(managed.computerAllowed("localVm")).toBe(true);
  });

  it("refuses remote access only when turned off", () => {
    const { managed } = overlay(policy({ remoteAccess: false }));
    expect(managed.remoteAccessRefusal()).toBe("Fixture Agency does not allow remote access to this computer.");
  });

  it("holds the last policy until the credential expires, then lifts it", () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { managed, onChange } = overlay(policy({ remoteAccess: false, expiresAt: start + 1000 }));
    expect(onChange).toHaveBeenCalledTimes(1);
    managed.apply(policy({ remoteAccess: false, expiresAt: start + 1000 }));
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1001);
    expect(managed.current()).toBeNull(); expect(managed.remoteAccessRefusal()).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("validates the private message and exposes nothing but settings to the renderer", () => {
    expect(() => parseManagedPolicy({ ...policy(), extra: true })).toThrow("Invalid organisation policy");
    expect(() => parseManagedPolicy({ ...policy(), allowedEngines: ["bad engine"] })).toThrow();
    expect(parseManagedPolicy(policy({ expiresAt: Date.now() - 1 }))).toBeNull();
    const { managed } = overlay(policy());
    expect(managed.summary()).not.toHaveProperty("organizationId");
    expect(managed.summary()).not.toHaveProperty("expiresAt");
    expect(managed.summary()).toMatchObject({ organizationName: "Fixture Agency", version: 3 });
  });
});

// Every computer claim in index.ts goes through bindTurnComputer. Run its
// actual guard (not a copy) against a synthetic policy.
describe("claim-time computer refusal in bindTurnComputer", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("\nasync function bindTurnComputer(");
  const guardEnd = source.indexOf("  const active = () =>", start);
  const guard = source.slice(start + 1, guardEnd) + "  return \"claimed\";\n}";
  const code = ts.transpileModule(guard, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  const bind = (managedPolicy: ManagedDesktopPolicy) => new Function("managedPolicy", "computerKindForResource", `${code}; return bindTurnComputer;`)(managedPolicy, computerKindForResource) as (owner: unknown, resource: string) => Promise<string>;

  it("refuses a disallowed kind before claiming anything", async () => {
    expect(start).toBeGreaterThan(0); expect(guardEnd).toBeGreaterThan(start);
    const { managed } = overlay(policy({ computers: { thisComputer: false, localVm: true, box: true, vps: false } }));
    const bindTurnComputer = bind(managed);
    await expect(bindTurnComputer({}, "computer:host")).rejects.toThrow("Fixture Agency does not allow bots to use this computer.");
    await expect(bindTurnComputer({}, "computer:vps:alias:bot")).rejects.toThrow("VPS computers");
    await expect(bindTurnComputer({}, "computer:vm:shared")).resolves.toBe("claimed");
    managed.apply(null);
    await expect(bindTurnComputer({}, "computer:host")).resolves.toBe("claimed");
  });
});
