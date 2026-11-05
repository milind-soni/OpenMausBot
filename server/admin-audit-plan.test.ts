import { describe, expect, it } from "vitest";

import { adminAuditPlan, sessionAuditRows } from "./admin-audit-plan.ts";

describe("which session changes the admin activity log records", () => {
  it("records a device signed out and a device whose view changed", () => {
    expect(adminAuditPlan("DELETE", "/api/auth/sessions/s1", false)).toMatchObject({ sessionId: "s1" });
    expect(adminAuditPlan("PATCH", "/api/auth/sessions/s1", false)).toMatchObject({ sessionId: "s1" });
    const phone = { id: "s1", label: "Phone", scopes: ["admin", "client"] };
    const limited = { ...phone, scopes: ["client"], view: { sections: ["Ops"], bots: [], groups: [] } };
    expect(sessionAuditRows(phone, [])).toMatchObject([{ action: "session.revoke", target: { id: "s1", name: "Phone" } }]);
    expect(sessionAuditRows(phone, [limited])).toMatchObject([{ action: "session.view", before: { view: "everything" }, after: { scopes: ["client"], view: limited.view } }]);
    expect(sessionAuditRows(limited, [limited])).toEqual([]);
  });
});
