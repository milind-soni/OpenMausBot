import { describe, expect, it } from "vitest";

import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, permissionInfo, permissionsForRole, scopesForPermissions } from "./permissions.ts";
import { roleScopes } from "./users.ts";

describe("the permission catalog", () => {
  it("has unique ids, a label and a real scope on every entry", () => {
    const ids = PERMISSIONS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PERMISSIONS) {
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(["admin", "client"]).toContain(p.scope);
      expect(permissionInfo(p.id)).toBe(p);
    }
    expect(permissionInfo("nope" as never)).toBeUndefined();
  });

  it("gives an admin everything and a member only the client-scoped ones", () => {
    expect(DEFAULT_ROLE_PERMISSIONS.admin).toEqual(PERMISSIONS.map((p) => p.id));
    expect(permissionsForRole("member")).toEqual(PERMISSIONS.filter((p) => p.scope === "client").map((p) => p.id));
    // The things that make a role mean something.
    expect(permissionsForRole("member")).toContain("chat");
    expect(permissionsForRole("member")).not.toContain("users.manage");
    expect(permissionsForRole("member")).not.toContain("settings.write");
    expect(permissionsForRole("admin")).toContain("users.manage");
  });
});

describe("the projection onto the enforced scopes", () => {
  // This is the load-bearing claim of phase 3: the catalog DESCRIBES the model,
  // requiredScope() ENFORCES it, and the two must never disagree. If they
  // drift, a panel would show a capability the server refuses (or worse).
  it("agrees with roleScopes for every built-in role", () => {
    for (const role of ["admin", "member"] as const) {
      expect(scopesForPermissions(permissionsForRole(role)).sort()).toEqual([...roleScopes(role)].sort());
    }
  });

  it("grants admin only when an admin-scoped capability is present", () => {
    expect(scopesForPermissions(["chat", "bots.read"])).toEqual(["client"]);
    expect(scopesForPermissions(["chat", "users.manage"]).sort()).toEqual(["admin", "client"]);
    // Client is always implied: nobody holds admin without also being able to chat.
    expect(scopesForPermissions([])).toEqual(["client"]);
    expect(scopesForPermissions(["audit.read"])).toContain("client");
  });

  it("ignores an unknown permission rather than escalating on it", () => {
    expect(scopesForPermissions(["not-a-permission" as never])).toEqual(["client"]);
  });

  it("falls back to the least privilege for an unknown role", () => {
    expect(permissionsForRole("superuser" as never)).toEqual(permissionsForRole("member"));
  });
});
