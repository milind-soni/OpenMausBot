import { describe, expect, it } from "vitest";
import type { Bot } from "@/state/store";
import { permissionCell, permissionPatch, type PermissionResource } from "./bot-permission-board";
import type { McpServerSummary } from "./mcp-servers";

const bot = (patch: Partial<Bot> = {}) => ({ id: "one", name: "One", ...patch }) as Bot;
const service: PermissionResource = { kind: "service", key: "mail", label: "Mail" };
const servers: McpServerSummary[] = [
  { name: "search", enabled: true }, { name: "files", enabled: true },
  { name: "foreign", enabled: true, bot: "two" },
  { name: "offline", enabled: true, offFor: ["one"] },
];
const mcp = (name: string): PermissionResource => ({ kind: "mcp", key: name, label: name, server: servers.find(entry => entry.name === name)! });

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

  it("does not write unknown future tool-grant formats", () => {
    const current = bot({ connectorTools: { mail: { tools: [] } } });
    expect(permissionCell(current, service, servers).reason).toBe("unknownGrant");
    expect(permissionPatch(current, service, false, ["mail"], servers)).toBeNull();
  });

  it("materializes effective inherited MCP grants without losing granted delegation or adding foreign servers", () => {
    expect(permissionPatch(bot(), mcp("search"), false, [], servers))
      .toEqual({ mcpServers: ["files", "offline"] });
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
    expect(permissionCell(bot(), disabled, servers).reason).toBe("globallyOff");
  });
});
