import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as composio from "./composio.ts";
import type { AppConfig } from "./config.ts";
import { createTeamConnectionsHost } from "./host/team-connections-host.ts";

const directories: string[] = [];
let backend = 0;
const capability = { threadId: "room", generation: "g" };
const opaqueCalls = [{ slug: "COMPOSIO_PROXY_EXECUTE" }];

function guard(cfg: AppConfig = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-inventory-"));
  directories.push(dataDir);
  const host = createTeamConnectionsHost({
    team: { id: "fixture", name: "Fixture" }, dataDir, cfg: () => cfg,
    adminOrigin: null, harnessUrl: "http://127.0.0.1:1", audienceOf: () => "room:fixture", requester: () => null,
    mint: () => "fixture", mcpOAuth: {} as never, botMcp: () => ({}), isSessionLive: () => true,
    brokerUrl: () => null, composio,
  });
  host.scopes.set("app", "gmail", "person");
  return host;
}

afterEach(() => {
  composio.setManagedBrokerAccess(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("broker inventory completeness", () => {
  it.each(["unavailable", "incomplete", "malformed"])("keeps display and bridge slugs but refuses opaque calls after an %s refresh", async (failure) => {
    composio.setManagedBrokerAccess({ url: `https://broker.test/${++backend}`, token: "a".repeat(64) });
    let broken = false;
    vi.stubGlobal("fetch", async () => {
      if (broken && failure === "unavailable") throw new Error("synthetic inventory timeout");
      if (broken && failure === "malformed") return Response.json({});
      return Response.json({ services: { slack: { connected: true } }, complete: !(broken && failure === "incomplete") });
    });
    const context = { harnessUrl: "http://127.0.0.1:1", commsToken: "fixture", botId: "bot", threadId: "room", connectorTools: { slack: { tools: "*" as const } } };
    const host = guard();
    const initialBridge = await composio.mcpIntegration({}, context);
    await expect(composio.connectedServiceSlugs({})).resolves.toEqual(["slack"]);
    await expect(host.callRefusal(capability, opaqueCalls)).resolves.toBeNull();
    broken = true;
    // A fresh display cache cannot prove that a person's app is absent now.
    await expect(host.callRefusal(capability, opaqueCalls)).resolves.toEqual(expect.stringMatching(/inventory.*could not be verified/));
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try {
      await expect(composio.connectedServiceSlugs({})).resolves.toEqual(["slack"]);
      expect(await composio.mcpIntegration({}, context)).toEqual(initialBridge);
      await expect(host.callRefusal(capability, opaqueCalls)).resolves.toEqual(expect.stringMatching(/inventory.*could not be verified/));
      broken = false;
      await expect(host.callRefusal(capability, opaqueCalls)).resolves.toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    { label: "legacy HTTP 200", proof: {} },
    { label: "explicitly incomplete HTTP 200", proof: { complete: false } },
  ])("refuses opaque calls for $label and retries without caching the empty result", async ({ proof }) => {
    composio.setManagedBrokerAccess({ url: `https://broker.test/${++backend}`, token: "a".repeat(64) });
    let body = { configured: true, services: {}, ...proof };
    vi.stubGlobal("fetch", async () => Response.json(body));
    const host = guard();

    await expect(host.callRefusal(capability, opaqueCalls)).resolves.toEqual(expect.stringMatching(/inventory.*could not be verified/));
    await expect(composio.connectedServicesInventory({})).resolves.toEqual({ services: {}, complete: false });
    await expect(composio.verifiedConnectedServiceSlugs({})).rejects.toThrow(/inventory.*incomplete/i);

    body = { configured: true, services: {}, complete: true };
    await expect(composio.connectedServicesInventory({})).resolves.toEqual({ services: {}, complete: true });
    await expect(host.callRefusal(capability, opaqueCalls)).resolves.toBeNull();
    await expect(composio.connectedServiceSlugs({})).resolves.toEqual([]);
  });
});

describe.each(["connected_accounts", "toolkits"])("self-hosted %s inventory", (walker) => {
  it.each(["repeated cursor", "cursor cycle", "page cap", "missing items", "invalid items", "missing item identity",
    "missing account id", "invalid account id", "missing slug", "empty slug", "invalid slug",
    ...(walker === "toolkits" ? ["missing selected account", "missing selected id", "invalid selected id"] : [])])(
    "refuses opaque calls on %s and recovers on the same backend", async (failure) => {
      const cfg: AppConfig = { composio: { apiKey: `ak_inventory_${++backend}`, userId: "fixture", sessionId: "trs_inventory" } };
      vi.stubEnv("OMB_COMPOSIO_API", "http://127.0.0.1:9876/api/v3.1");
      let broken = true;
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/auth_configs")) return Response.json({ items: [] });
        if (url.pathname.endsWith("/tool_router/session/trs_inventory")) return Response.json({
          session_id: "trs_inventory", mcp: { type: "http", url: "http://127.0.0.1:9876/mcp" },
          config: { user_id: "fixture", multi_account: { enable: true } },
        });
        if (url.pathname.endsWith("/connected_accounts") || url.pathname.endsWith("/toolkits")) {
          if (broken && url.pathname.endsWith(`/${walker}`)) {
            const malformed: Record<string, unknown> = walker === "connected_accounts" ? {
              "missing item identity": {}, "missing account id": { toolkit: { slug: "gmail" } },
              "invalid account id": { id: "bad id", toolkit: { slug: "gmail" } },
              "missing slug": { id: "ca_gmail", toolkit: {} },
              "empty slug": { id: "ca_gmail", toolkit: { slug: "" } },
              "invalid slug": { id: "ca_gmail", toolkit: { slug: " " } },
            } : {
              "missing item identity": {}, "missing slug": { is_no_auth: true },
              "empty slug": { slug: "", is_no_auth: true }, "invalid slug": { slug: " ", is_no_auth: true },
              "missing selected account": { slug: "gmail" },
              "missing selected id": { slug: "gmail", connected_account: {} },
              "invalid selected id": { slug: "gmail", connected_account: { id: "bad id" } },
              "missing account id": { slug: "gmail", connected_account: null },
              "invalid account id": { slug: "gmail", is_no_auth: true, connected_account: { id: "bad id" } },
            };
            if (Object.hasOwn(malformed, failure)) return Response.json({ items: [malformed[failure]] });
            const cursor = url.searchParams.get("cursor");
            if (failure === "missing items") return Response.json({});
            if (failure === "invalid items") return Response.json({ items: {} });
            const next = failure === "page cap" ? `${Number(cursor ?? 0) + 1}`
              : failure === "cursor cycle" && cursor === "a" ? "b" : "a";
            return Response.json({ items: [], next_cursor: next });
          }
          return Response.json({ items: [] });
        }
        throw new Error(`Unexpected inventory request: ${url}`);
      });
      const host = guard(cfg);
      await expect(host.callRefusal(capability, opaqueCalls)).resolves.toEqual(expect.stringMatching(/inventory.*could not be verified/));
      await expect(composio.verifiedConnectedServiceSlugs(cfg)).rejects.toThrow();
      broken = false;
      await expect(host.callRefusal(capability, opaqueCalls)).resolves.toBeNull();
      await expect(composio.connectedServiceSlugs(cfg)).resolves.toEqual([]);
    },
  );
});
