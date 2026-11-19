import { describe, expect, it } from "vitest";
import { permissionCell, permissionPatch, type PermissionBot, type PermissionResource } from "./bot-permission-board";
import type { McpServerSummary } from "./mcp-servers";
import { grantScopedApps, widensConnectorScopes } from "../../shared/connector-scopes";

const bot = (patch: Partial<PermissionBot> = {}) => ({ id: "one", name: "One", ...patch }) as PermissionBot;
const service: PermissionResource = { kind: "service", key: "mail", label: "Mail" };
const servers: McpServerSummary[] = [
  { name: "search", enabled: true }, { name: "files", enabled: true },
  { name: "foreign", enabled: true, bot: "two" },
  { name: "offline", enabled: true, offFor: ["one"] },
];
const mcp = (name: string): Extract<PermissionResource, { kind: "mcp" }> => ({ kind: "mcp", key: name, label: name, server: servers.find(entry => entry.name === name)! });

describe("permissions matrix uses existing bot ceilings", () => {
  it("preserves exact tools and read-only scope on an already allowed service", () => {
    const current = bot({ connectorScopes: { apps: { mail: "read" } }, connectorTools: { mail: { tools: ["MAIL_GET_MESSAGE"] } } });
    expect(permissionCell(current, service, servers)).toMatchObject({ checked: true, readOnly: true, limited: true });
    expect(permissionPatch(current, service, true, ["mail", "calendar"], servers)).toEqual({});
    expect(permissionPatch(current, service, false, ["mail", "calendar"], servers)).toEqual({ connectorScopes: { apps: {} } });
  });

  it("the first service grant while apps are off enables only that app", () => {
    expect(permissionPatch(bot({ composio: false }), service, true, ["mail", "calendar"], servers))
      .toEqual({ composio: true, connectorScopes: { apps: { mail: "write" } } });
  });

  it("does not reactivate other stored service grants when enabling one cell on a globally disabled bot", () => {
    const current = bot({ composio: false, connectorScopes: { apps: { mail: "read", calendar: "write" } } });
    expect(permissionPatch(current, service, true, ["mail", "calendar"], servers))
      .toEqual({ composio: true, connectorScopes: { apps: { mail: "read" } } });
  });

  it("preserves account ceilings for remaining apps when revoking a service", () => {
    const current = bot({ connectorScopes: { apps: { mail: "read", calendar: "write" }, accounts: { mail: ["personal"], calendar: ["work"] } } });
    const patch = permissionPatch(current, service, false, ["mail", "calendar"], servers)!;
    expect(patch).toEqual({ connectorScopes: { apps: { calendar: "write" }, accounts: { calendar: ["work"] } } });
    expect(widensConnectorScopes(current.connectorScopes, { ...current, ...patch }.connectorScopes)).toBe(false);
  });

  it("preserves other apps' account ceilings when granting a service", () => {
    const current = bot({ connectorScopes: { apps: { calendar: "read" }, accounts: { calendar: ["work"] } } });
    expect(permissionPatch(current, service, true, ["mail", "calendar"], servers)).toEqual({
      connectorScopes: { apps: { calendar: "read", mail: "write" }, accounts: { calendar: ["work"] } },
    });
  });

  it("reactivates only the selected service with its stored account and tool ceilings", () => {
    const current = bot({ composio: false,
      connectorScopes: { apps: { mail: "read", calendar: "write" }, accounts: { mail: ["personal"], calendar: ["work"] } },
      connectorTools: { mail: { tools: ["MAIL_GET_MESSAGE"] }, calendar: { tools: "*" } },
    });
    const patch = permissionPatch(current, service, true, ["mail", "calendar"], servers)!;
    expect(patch).toEqual({ composio: true, connectorScopes: { apps: { mail: "read" }, accounts: { mail: ["personal"] } } });
    expect({ ...current, ...patch }.connectorTools).toEqual(current.connectorTools);
  });

  it("does not grant previously omitted tools when materializing an inherited app ceiling", () => {
    const current = bot({ connectorTools: { mail: { tools: ["MAIL_GET_MESSAGE"] }, notes: { tools: ["NOTES_GET_NOTE"] } } });
    const patch = permissionPatch(current, service, false, ["mail", "calendar", "notes"], servers)!;
    expect(patch).toEqual({ connectorScopes: { apps: { notes: "write" } } });
    const saved = { ...current, ...patch };
    expect(grantScopedApps(saved)).toBe(false);
    expect(saved.connectorTools).toEqual(current.connectorTools);
    expect(permissionCell(saved, { kind: "service", key: "calendar", label: "Calendar" }, servers).checked).toBe(false);
  });

  it("does not rewrite ceilings when a stale service revoke is already satisfied", () => {
    for (const current of [bot({ composio: false }), bot({ connectorTools: {} })]) {
      expect(permissionPatch(current, service, false, ["mail", "calendar"], servers)).toEqual({});
    }
  });

  it("does not write unknown future tool-grant formats", () => {
    const current = bot({ connectorTools: { mail: { tools: [] } } });
    expect(permissionCell(current, service, servers).reason).toBe("unknownGrant");
    expect(permissionPatch(current, service, false, ["mail"], servers)).toBeNull();
  });

  it("materializes effective inherited MCP grants without losing granted delegation or adding foreign servers", () => {
    expect(permissionPatch(bot(), mcp("search"), false, [], servers))
      .toEqual({ mcpServers: ["files", "offline"] });
  });

  it("checks current MCP eligibility rather than stale resource metadata", () => {
    const resource = mcp("files");
    for (const changed of [{ ...resource.server, enabled: false }, { ...resource.server, bot: "two" }]) {
      const latest = servers.map(server => server.name === "files" ? changed : server);
      expect(permissionCell(bot(), resource, latest).checked).toBe(false);
      expect(permissionPatch(bot(), resource, true, [], latest)).toBeNull();
    }
    const removed = servers.filter(server => server.name !== "files");
    expect(permissionCell(bot(), resource, removed)).toEqual({ checked: false, reason: "unavailable" });
    expect(permissionPatch(bot(), resource, true, [], removed)).toBeNull();
  });

  it("keeps inherited MCP selection separate from tool restrictions and health", () => {
    const current = bot({ mcpServers: null, toolScope: { deny: ["mcp:files:*", "mcp:offline:*"] } });
    expect(permissionCell(current, mcp("files"), servers).checked).toBe(true);
    const patch = permissionPatch(current, mcp("search"), false, [], servers);
    expect(patch).toEqual({ mcpServers: ["files", "offline"] });
    expect({ ...current, ...patch }.toolScope).toEqual(current.toolScope);
  });

  it("preserves explicit disabled/unknown names when toggling an eligible MCP", () => {
    expect(permissionPatch(bot({ mcpServers: ["old-disabled", "search"] }), mcp("files"), true, [], servers))
      .toEqual({ mcpServers: ["old-disabled", "search", "files"] });
    expect(permissionPatch(bot({ mcpServers: [] }), mcp("files"), false, [], servers)).toBeNull();
  });

  it("allows revoking an unhealthy server without erasing its health warning", () => {
    expect(permissionCell(bot(), mcp("offline"), servers)).toMatchObject({ checked: true, warning: "unavailable" });
    expect(permissionCell(bot(), mcp("offline"), servers).reason).toBeUndefined();
    expect(permissionPatch(bot(), mcp("offline"), false, [], servers)).toEqual({ mcpServers: ["search", "files"] });
  });

  it("keeps another bot's servers read-only while a busy bot's own MCP stays editable", () => {
    for (const [name, reason] of [["foreign", "otherBot"]]) {
      expect(permissionCell(bot(), mcp(name!), servers).reason).toBe(reason);
      expect(permissionPatch(bot(), mcp(name!), false, [], servers)).toBeNull();
    }
    expect(permissionPatch(bot({ busy: true }), mcp("files"), false, [], servers)).toEqual({ mcpServers: ["search", "offline"] });
    const disabled: PermissionResource = { kind: "mcp", key: "off", label: "Off", server: { name: "off", enabled: false } };
    expect(permissionCell(bot(), disabled, [...servers, disabled.server]).reason).toBe("globallyOff");
  });
});
