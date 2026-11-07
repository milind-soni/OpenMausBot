import { describe, expect, it } from "vitest";
import type { FleetRegistry, FleetWorkspace } from "./fleet.ts";
import { assertWorkspaceHost, workspaceHostFor } from "./fleet-tenancy.ts";

const entry = (slug: string, host: string, status: FleetWorkspace["status"], index: number): FleetWorkspace => ({
  slug, host, port: 8810 + index * 10, webhookPort: 8811 + index * 10, status, createdAt: "2026-09-10T08:00:00.000Z",
});

const registry: FleetRegistry = {
  version: 1,
  domain: "example.test",
  nextPort: 8860,
  workspaces: {
    globex: entry("globex", "globex.example.test", "running", 0),
    retired: entry("retired", "chat.retired.com", "retained", 1),
    broken: entry("broken", "broken.example.test", "error", 2),
    pending: entry("pending", "portal.pending.com", "provisioning", 3),
  },
};

const check = (host: string | undefined, extra: { slug?: string; portalUrl?: string } = {}) => () =>
  assertWorkspaceHost({ registry, slug: extra.slug ?? "acme", host, portalUrl: extra.portalUrl });

describe("workspace web address", () => {
  it("accepts a custom domain, its mixed-case spelling and the explicit default", () => {
    for (const host of ["chat.acme-corp.com", "Chat.Acme.COM", "acme.example.test", "ACME.example.test", "a.b.c.acme.co.uk"]) expect(check(host)).not.toThrow();
    expect(check(undefined)).not.toThrow();
  });

  it("normalises to lowercase and falls back to the default name", () => {
    expect(workspaceHostFor(registry, "acme")).toBe("acme.example.test");
    expect(workspaceHostFor(registry, "acme", "Chat.Acme.COM")).toBe("chat.acme.com");
    expect(workspaceHostFor({ ...registry, domain: "Example.TEST" }, "acme")).toBe("acme.example.test");
  });

  it.each([
    ["the fleet's own domain", "example.test", "fleet's own domain"],
    ["the fleet's own domain in capitals", "EXAMPLE.test", "fleet's own domain"],
    ["another workspace's default name", "initech.example.test", "reserved for workspace names"],
    ["a deeper name under the domain", "a.b.example.test", "reserved for workspace names"],
    ["an address another workspace serves", "globex.example.test", 'workspace "globex"'],
    ["an address a retained workspace keeps", "chat.retired.com", "(retained)"],
    ["the same address in capitals", "CHAT.retired.com", "(retained)"],
    ["an address a half-built workspace keeps", "portal.pending.com", "(provisioning)"],
    ["an address a failed workspace keeps", "broken.example.test", "(error)"],
    ["localhost", "localhost", "web address"],
    ["a name under localhost", "chat.localhost", "public web address"],
    ["an IPv4 literal", "10.0.0.1", "web address"],
    ["an IPv6 literal", "[::1]", "web address"],
    ["a wildcard", "*.acme.com", "web address"],
    ["a port", "acme.com:80", "web address"],
    ["a path", "acme.com/x", "web address"],
    ["a Caddy block break-out", "acme.com\n}", "web address"],
    ["a brace", "acme.com{", "web address"],
    ["a space", "acme .com", "web address"],
    ["a leading space", " acme.com", "web address"],
    ["a trailing dot", "acme.com.", "web address"],
    ["a single label", "intranet", "web address"],
    ["an empty string", "", "web address"],
    ["a 254 character name", `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com`, "web address"],
  ])("refuses %s", (_label, host, message) => {
    expect(check(host)).toThrow(message);
  });

  it("never echoes a hostile name raw into the error", () => {
    expect(check("acme.com\n}")).toThrow(/^[^\n]*$/);
  });

  it("refuses the portal's own address, and any custom address while a portal is set", () => {
    expect(check("admin.acme.com", { portalUrl: "https://admin.acme.com" })).toThrow("admin portal's address");
    expect(check("Admin.Acme.com", { portalUrl: "https://admin.acme.com" })).toThrow("admin portal's address");
    expect(check("chat.acme.com", { portalUrl: "https://admin.example.test" })).toThrow("--host cannot be combined with a portal");
    expect(check(undefined, { portalUrl: "https://admin.example.test" })).not.toThrow();
  });

  it("refuses a new name whose default address another workspace holds", () => {
    const held: FleetRegistry = { ...registry, workspaces: { ...registry.workspaces, chat: entry("chat", "initech.example.test", "running", 4) } };
    expect(() => assertWorkspaceHost({ registry: held, slug: "initech" })).toThrow('workspace "chat"');
    expect(() => assertWorkspaceHost({ registry: held, slug: "initech", host: "chat.initech.com" })).toThrow('workspace "chat"');
    expect(() => assertWorkspaceHost({ registry: held, slug: "other", host: "chat.initech.com" })).not.toThrow();
  });
});
