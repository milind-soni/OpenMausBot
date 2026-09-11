import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus } from "@/state/store";
import { WorkspacesSection, WorkspacesTable, workspacesAvailable, type FleetView } from "./WorkspacesSection";

const fixture = vi.hoisted(() => ({ config: null as ConfigStatus | null }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: { config: fixture.config }, dispatch: () => {} }),
}));
afterEach(() => vi.unstubAllGlobals());

function config(features: string[], fleet: boolean): ConfigStatus {
  return {
    composio: { configured: false }, box: { configured: false }, vps: { configured: false, sshAlias: "" },
    rooms: { turnTimeoutMinutes: 30 }, localVm: { mode: "shared", maxInstances: 1 },
    edition: { edition: features.length ? "enterprise" : "oss", features }, fleet: { available: fleet },
  } as ConfigStatus;
}

const fleet: FleetView = {
  domain: "agentada.cc",
  operator: "maus",
  workspaces: [
    { slug: "acme", host: "acme.agentada.cc", port: 8810, status: "running", createdAt: "", live: "active", usage: { month: "2026-09", turns: 12, costUsd: 3.5, billableUsd: 7 } },
    { slug: "globex", host: "globex.agentada.cc", port: 8820, status: "suspended", createdAt: "", live: "inactive", usage: { month: "2026-09", turns: 0, costUsd: null, billableUsd: null } },
  ],
};

describe("workspaces section", () => {
  it("appears only with the admin entitlement and a fleet agent on this server", () => {
    expect(workspacesAvailable(config([], true))).toBe(false);
    expect(workspacesAvailable(config(["admin"], false))).toBe(false);
    expect(workspacesAvailable(config(["admin"], true))).toBe(true);
    fixture.config = config(["admin"], false);
    expect(renderToStaticMarkup(createElement(WorkspacesSection, { load: async () => fleet }))).toBe("");
  });

  it("lists workspaces with their state, this month's cost and billable, and the actions that fit", () => {
    const html = renderToStaticMarkup(createElement(WorkspacesTable, { fleet, onAct: () => {}, busy: null }));
    expect(html).toContain("acme.agentada.cc");
    expect(html).toContain("Running");
    expect(html).toContain("$3.50");
    expect(html).toContain("$7.00");
    expect(html).toContain("Suspended");
    expect(html).toContain(">Suspend<");
    expect(html).toContain(">Resume<");
    expect(html).toContain(">Delete<");
    expect(html).toContain('href="https://globex.agentada.cc"');
    expect(renderToStaticMarkup(createElement(WorkspacesTable, { fleet: { ...fleet, workspaces: [] }, onAct: () => {}, busy: null }))).toContain("No workspaces on agentada.cc yet");
  });
});
