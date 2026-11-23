import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { configureFeatures } from "./features.ts";
import { createWorkspaceAccess, hostedWorkspaceConfiguration, hostedWorkspaceConfigured, registerWorkspaceAccess, sharedWorkspaceFullAccessConfigured } from "./hosted-workspace.ts";
import { SessionRegistry } from "./sessions.ts";

const dirs: string[] = [];
function sessionsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-hosted-workspace-"));
  dirs.push(dir);
  return join(dir, "sessions.json");
}

afterEach(() => {
  registerWorkspaceAccess(undefined);
  configureFeatures({}, undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("hosted workspace configuration", () => {
  it("requires an explicit operator policy on a complete portal-managed non-desktop workspace", () => {
    const env = { OMB_ADMIN_URL: "https://admin.example.test", OMB_ADMIN_WORKSPACE: "acme", OMB_PUBLIC_URL: "https://acme.example.test",
      OMB_ADMIN_MEMBERSHIP: "portal", OMB_SHARED_WORKSPACE_FULL_ACCESS: "1" };
    expect(sharedWorkspaceFullAccessConfigured(env)).toBe(true);
    for (const patch of [
      { OMB_SHARED_WORKSPACE_FULL_ACCESS: undefined }, { OMB_SHARED_WORKSPACE_FULL_ACCESS: "true" },
      { OMB_DESKTOP_PARENT: "1" }, { OMB_ADMIN_MEMBERSHIP: "local" }, { OMB_ADMIN_MEMBERSHIP: undefined },
      { OMB_ADMIN_URL: "http://admin.example.test" }, { OMB_PUBLIC_URL: "" }, { OMB_ADMIN_WORKSPACE: "" },
    ]) expect(sharedWorkspaceFullAccessConfigured({ ...env, ...patch })).toBe(false);
    expect(sharedWorkspaceFullAccessConfigured({ OMB_SHARED_WORKSPACE_FULL_ACCESS: "1" })).toBe(false);
  });

  it("does not create a hosted bridge unless opted in, and marks partial configuration as hosted", () => {
    expect(hostedWorkspaceConfigured({})).toBe(false);
    expect(hostedWorkspaceConfigured({ OMB_PUBLIC_URL: "https://legacy.example.test" })).toBe(false);
    expect(hostedWorkspaceConfigured({ OMB_ADMIN_URL: "" })).toBe(true);
    expect(hostedWorkspaceConfigured({ OMB_ADMIN_WORKSPACE: "acme" })).toBe(true);
    expect(hostedWorkspaceConfigured({ OMB_ADMIN_MEMBERSHIP: "portal" })).toBe(true);
    const sessions = new SessionRegistry({ file: sessionsFile() });
    expect(createWorkspaceAccess({ sessions, cookieName: "session", closeSessionStreams() {}, env: {} })).toBeNull();
    expect(createWorkspaceAccess({ sessions, cookieName: "session", closeSessionStreams() {}, env: { OMB_ADMIN_WORKSPACE: "acme" } })).toBeNull();
  });

  it("requires complete valid hosted configuration before opting into portal membership", () => {
    const env = { OMB_ADMIN_URL: "https://admin.example.test", OMB_ADMIN_WORKSPACE: "acme", OMB_PUBLIC_URL: "https://acme.example.test" };
    expect(hostedWorkspaceConfiguration(env)?.portalMembership).toBe(false);
    expect(hostedWorkspaceConfiguration({ ...env, OMB_ADMIN_MEMBERSHIP: "portal" })?.portalMembership).toBe(true);
    expect(hostedWorkspaceConfiguration({ ...env, OMB_ADMIN_MEMBERSHIP: "local" })?.portalMembership).toBe(false);
    for (const patch of [{ OMB_ADMIN_URL: "" }, { OMB_PUBLIC_URL: "http://acme.example.test" }, { OMB_ADMIN_WORKSPACE: "" }, { OMB_ADMIN_MEMBERSHIP: "PORTAL" }]) {
      expect(hostedWorkspaceConfiguration({ ...env, OMB_ADMIN_MEMBERSHIP: "portal", ...patch })).toBeNull();
    }
    const invalid = { OMB_ADMIN_MEMBERSHIP: "portal" };
    const sessions = new SessionRegistry({ file: sessionsFile(), portalMembership: hostedWorkspaceConfiguration(invalid)?.portalMembership === true });
    const issued = sessions.issuePortal({ email: "member@example.test", grant: "g".repeat(43), scopes: ["client"] });
    expect(sessions.authenticate(issued.token)).toBeNull();
  });

  it("hands a registered adapter the live admin feature", async () => {
    registerWorkspaceAccess((options) => ({ handlePublic: async () => options.adminEnabled(), authorize: async () => null, revalidate: async () => {} }));
    const sessions = new SessionRegistry({ file: sessionsFile() });
    const bridge = createWorkspaceAccess({ sessions, cookieName: "session", closeSessionStreams() {}, env: { OMB_ADMIN_WORKSPACE: "acme" } });
    expect(await bridge!.handlePublic(null as never, null as never, null as never)).toBe(false);
    configureFeatures({ APP_FEATURES: "admin" }, undefined);
    expect(await bridge!.handlePublic(null as never, null as never, null as never)).toBe(true);
  });
});
