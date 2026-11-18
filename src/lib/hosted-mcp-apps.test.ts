import { describe, expect, it } from "vitest";
import { HOSTED_MCP_APPS, hostedConnections, hostedMcpApp, hostedServerName, type HostedApp } from "./hosted-mcp-apps";

describe("hosted MCP apps", () => {
  it("has unique ids that are valid server names and unique https endpoints", () => {
    const ids = HOSTED_MCP_APPS.map((app) => app.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    const urls = HOSTED_MCP_APPS.map((app) => app.url);
    expect(new Set(urls).size).toBe(urls.length);
    for (const url of urls) expect(url).toMatch(/^https:\/\//);
  });

  describe.each(HOSTED_MCP_APPS.map((app) => [app.id, app] as const))("%s", (_id, app) => {
    const { host } = new URL(app.url);
    it("is recognized at its official endpoint, with or without a trailing slash, under any local name", () => {
      expect(hostedMcpApp({ type: "http", url: app.url })).toBe(app);
      expect(hostedMcpApp({ type: "http", url: `${app.url}/` })).toBe(app);
    });
    it("does not brand other servers, transports or modified URLs", () => {
      const bare = host.split(".").slice(-2).join(".");
      for (const url of [app.url.replace("https:", "http:"), `https://${host}.evil.test/mcp`, `https://${bare}/mcp`, `${app.url}?key=secret`, `${app.url}#hash`, `https://key@${host}${new URL(app.url).pathname}`, `https://${host}/docs`, "invalid"]) {
        expect(hostedMcpApp({ type: "http", url }), url).toBeUndefined();
      }
      expect(hostedMcpApp({ type: "sse", url: app.url })).toBeUndefined();
      expect(hostedMcpApp({})).toBeUndefined();
    });
    it("is named after itself and never takes an existing server's name", () => {
      expect(hostedServerName(app, [])).toBe(app.id);
      expect(hostedServerName(app, [{ name: app.id }])).toBe(`${app.id}-2`);
      expect(hostedServerName(app, [{ name: app.id }, { name: `${app.id}-2` }])).toBe(`${app.id}-3`);
      expect(hostedServerName(app, [{ name: `${app.id}-2` }])).toBe(app.id);
    });
  });

  type Extra = { enabled: boolean; auth?: "signed-in" | "needs-sign-in"; headerKeys?: string[] };
  const connectedWith = (app: HostedApp, extra: Extra) => hostedConnections([{ type: "http", url: app.url, ...extra }])[app.id];

  it.each(HOSTED_MCP_APPS.filter((app) => !("key" in app)))("$label is connected only while its server is on and signed in", (app) => {
    expect(connectedWith(app, { enabled: true, auth: "signed-in" })).toBe(true);
    expect(connectedWith(app, { enabled: true })).toBe(false);
    expect(connectedWith(app, { enabled: true, auth: "needs-sign-in" })).toBe(false);
    expect(connectedWith(app, { enabled: false, auth: "signed-in" })).toBe(false);
    expect(connectedWith(app, { enabled: true, headerKeys: ["Authorization"] })).toBe(false);
  });

  it.each(HOSTED_MCP_APPS.filter((app) => "key" in app))("$label is connected only while its server is on and holds its key", (app) => {
    expect(connectedWith(app, { enabled: true, headerKeys: ["Authorization"] })).toBe(true);
    expect(connectedWith(app, { enabled: true, headerKeys: ["authorization"] })).toBe(true);
    expect(connectedWith(app, { enabled: true, headerKeys: [] })).toBe(false);
    expect(connectedWith(app, { enabled: true, headerKeys: ["X-Api-Key"] })).toBe(false);
    expect(connectedWith(app, { enabled: false, headerKeys: ["Authorization"] })).toBe(false);
    expect(connectedWith(app, { enabled: true, auth: "signed-in" })).toBe(false);
  });

  it("takes a pasted key exactly for the services with no browser sign-in, each with an https page to make one", () => {
    expect(HOSTED_MCP_APPS.filter((app) => "key" in app).map((app) => app.id)).toEqual(["vapi", "telnyx"]);
    for (const app of HOSTED_MCP_APPS) if ("key" in app) expect(app.key.url).toMatch(/^https:\/\//);
  });

  it("counts each app on its own server", () => {
    const [first] = HOSTED_MCP_APPS;
    const connections = hostedConnections([
      { type: "http", url: first.url, enabled: true, auth: "signed-in" },
      { type: "http", url: "https://unrelated.example/mcp", enabled: true, auth: "signed-in" },
    ]);
    expect(Object.entries(connections).filter(([, on]) => on).map(([id]) => id)).toEqual([first.id]);
  });
});
