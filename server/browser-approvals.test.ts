import { describe, expect, it } from "vitest";
import { browserApprovalAccess, browserApprovalSchema, browserFullAccessEnabled } from "./browser-approvals.ts";
import type { RequestAuth } from "./request-auth.ts";

describe("self-hosted browser grants", () => {
  it("requires exact host opt-in, never truthy strings", () => {
    for (const value of [undefined, "0", "false", "true", "yes"]) expect(browserFullAccessEnabled({ OMB_ALLOW_BROWSER_FULL_ACCESS: value })).toBe(false);
    expect(browserFullAccessEnabled({ OMB_ALLOW_BROWSER_FULL_ACCESS: "1" })).toBe(true);
  });
  it("requires admin cookie authority, not loopback, client, bearer or ticket authority", () => {
    const admin: RequestAuth = { kind: "session", via: "cookie", scopes: ["admin", "client"], session: {
      id: "fixture", tokenHash: "0".repeat(64), label: "Fixture", scopes: ["admin", "client"], createdAt: 1, lastSeenAt: 1, expiresAt: 2,
    } };
    expect(browserApprovalAccess(admin, true)).toBe(true);
    expect(browserApprovalAccess(admin, false)).toBe(false);
    for (const auth of [
      { kind: "loopback", scopes: ["admin", "client"] },
      { ...admin, scopes: ["client"] },
      { ...admin, via: "bearer" },
      { ...admin, via: "ticket" },
    ]) expect(browserApprovalAccess(auth as RequestAuth, true)).toBe(false);
  });
  it("rejects Custom, mixed scopes, model changes and arbitrary fields", () => {
    for (const body of [{ mode: "custom" }, { mode: "full", threadOnly: true }, { mode: "full", threadId: "thread" },
      { mode: "full", modelSelection: {} }, { mode: "full", confirmFullAccess: "true" }]) {
      expect(browserApprovalSchema.safeParse(body).success).toBe(false);
    }
    expect(browserApprovalSchema.safeParse({ mode: "full", threadId: "thread", threadOnly: true, confirmFullAccess: true }).success).toBe(true);
  });
});
