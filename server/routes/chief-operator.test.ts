import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { chiefOperatorOwner } from "./chief-operator.ts";

const request = (token?: string): IncomingMessage => ({ headers: { host: "127.0.0.1:8799", ...(token ? { "x-openmausbot-desktop-owner": token } : {}) } }) as IncomingMessage;
const loopback: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const teamSession = (role: "owner" | "admin" | "member"): RequestAuth => {
  const scopes = role === "member" ? ["client"] as const : ["admin", "client"] as const;
  return { kind: "session", via: "bearer", scopes,
    session: { id: `team-${role}`, tokenHash: "0".repeat(64), label: role, scopes: [...scopes], createdAt: 0, lastSeenAt: 0, expiresAt: 1000,
      email: "owner@example.test", membershipAuthority: "team", teamRole: role } };
};

describe("Chief Operator owner proof", () => {
  it("requires a signed-in Team Cloud Owner rather than an Admin or Member", () => {
    const options = { team: true, desktopManaged: false };
    expect(chiefOperatorOwner(teamSession("owner"), request(), options)).toBe("owner@example.test");
    expect(chiefOperatorOwner(teamSession("admin"), request(), options)).toBeNull();
    expect(chiefOperatorOwner(teamSession("member"), request(), options)).toBeNull();
  });

  it("refuses shell-like owner loopback except the desktop's per-boot owner proof", () => {
    const options = { team: false, desktopManaged: true, desktopMutationToken: "fixture-desktop-token" };
    expect(chiefOperatorOwner(loopback, request(), options)).toBeNull();
    expect(chiefOperatorOwner(loopback, request("fixture-desktop-token"), { ...options, desktopManaged: false })).toBeNull();
    expect(chiefOperatorOwner(loopback, request("wrong"), options)).toBeNull();
    expect(chiefOperatorOwner(loopback, request("fixture-desktop-token"), options)).toBe("local-owner");
    expect(chiefOperatorOwner({ ...loopback, companionDevice: "phone" }, request("fixture-desktop-token"), options)).toBeNull();
  });
});
