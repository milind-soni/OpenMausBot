import type { IncomingMessage } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ChiefOperator } from "../chief-operator.ts";
import type { RequestAuth } from "../request-auth.ts";
import { SessionRegistry } from "../sessions.ts";
import { chiefOperatorOwner, createChiefOperatorRoutes } from "./chief-operator.ts";
import type { RouteContext } from "./table.ts";

const request = (token?: string): IncomingMessage => ({ headers: { host: "127.0.0.1:8799", ...(token ? { "x-openmausbot-desktop-owner": token } : {}) } }) as IncomingMessage;
const loopback: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const liveOwner = { sessions: { isLive: () => true }, ownerActive: () => true };
const teamSession = (role: "owner" | "admin" | "member"): RequestAuth => {
  const scopes = role === "member" ? ["client"] as const : ["admin", "client"] as const;
  return { kind: "session", via: "bearer", scopes,
    session: { id: `team-${role}`, tokenHash: "0".repeat(64), label: role, scopes: [...scopes], createdAt: 0, lastSeenAt: 0, expiresAt: 1000,
      email: "owner@example.test", membershipAuthority: "team", teamRole: role } };
};

describe("Chief Operator owner proof", () => {
  it("requires a signed-in Team Cloud Owner rather than an Admin or Member", () => {
    const options = { team: true, desktopManaged: false, ...liveOwner };
    expect(chiefOperatorOwner(teamSession("owner"), request(), options)).toBe("owner@example.test");
    expect(chiefOperatorOwner(teamSession("admin"), request(), options)).toBeNull();
    expect(chiefOperatorOwner(teamSession("member"), request(), options)).toBeNull();
  });

  it("refuses shell-like owner loopback except the desktop's per-boot owner proof", () => {
    const options = { team: false, desktopManaged: true, desktopMutationToken: "fixture-desktop-token", ...liveOwner };
    expect(chiefOperatorOwner(loopback, request(), options)).toBeNull();
    expect(chiefOperatorOwner(loopback, request("fixture-desktop-token"), { ...options, desktopManaged: false })).toBeNull();
    expect(chiefOperatorOwner(loopback, request("wrong"), options)).toBeNull();
    expect(chiefOperatorOwner(loopback, request("fixture-desktop-token"), options)).toBe("local-owner");
    expect(chiefOperatorOwner({ ...loopback, companionDevice: "phone" }, request("fixture-desktop-token"), options)).toBeNull();
  });
});

it.each(["PUT", "DELETE"].flatMap(method => ["revoke", "demote", "unchanged"].map(change => [method, change])))
  ("revalidates the live owner after a gated %s body: %s", async (method, change) => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-public-operator-body-"));
    try {
      const sessions = new SessionRegistry({ file: join(dataDir, "sessions.json") });
      const issued = sessions.issue({ label: "Owner", scopes: ["admin", "client"] });
      const session = { ...sessions.authenticate(issued.token)!, email: "owner@example.test", membershipAuthority: "team" as const, teamRole: "owner" as const };
      const auth: RequestAuth = { kind: "session", via: "bearer", scopes: session.scopes, session };
      let ownerActive = true;
      const operator = new ChiefOperator({ dataDir, config: () => ({ language: "en" }), botIdentity: () => "chief-identity", writeSetting: () => {}, changed: () => {} });
      if (method === "DELETE") operator.appoint({ botId: "chief", read: ["language"], write: [], expectedRevision: "none" }, session.email);
      const stateFile = join(dataDir, "chief-operator.json");
      const bytes = () => existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null;
      const before = bytes();
      const body = method === "PUT" ? { botId: "chief", read: ["language"], write: [], expectedRevision: "none" } : { expectedRevision: operator.appointment().revision };
      const options = { team: true, desktopManaged: false, sessions, ownerActive: () => ownerActive };
      const route = createChiefOperatorRoutes(operator, (auth, req) => chiefOperatorOwner(auth, req, options));
      let release!: (value: unknown) => void;
      const gated = new Promise(resolve => { release = resolve; });
      let status = 0;
      const pending = route({ req: request(), res: {} as RouteContext["res"], path: "/api/chief-operator", method, auth,
        url: new URL("http://127.0.0.1/api/chief-operator"), readBody: () => gated,
        json: (_res, code) => { status = code; } });
      if (change === "revoke") sessions.revoke(session.id);
      if (change === "demote") ownerActive = false;
      release(body);
      await pending;
      expect(status, `${method}: ${change}`).toBe(change === "unchanged" ? 200 : 403);
      if (change !== "unchanged") expect(bytes(), `${method}: ${change}`).toBe(before);
      else expect(bytes()).not.toBe(before);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
});
