import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { PASS } from "./table.ts";
import { createTeamPhoneRoutes, sessionMember, TEAM_PHONE_PAIRING_PATH } from "./team-phone.ts";

const TEAM = { id: "team-acme-1", name: "Acme" };
const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "s-ada", tokenHash: "0".repeat(64), label: "Desktop", scopes: ["client"], createdAt: 1_000, lastSeenAt: 1_000, expiresAt: 9_000,
  email: "ada@acme.test", teamRole: "member", membershipAuthority: "team", ...over,
});
const asSession = (record: SessionRecord): RequestAuth => ({ kind: "session", scopes: record.scopes, session: record, via: "bearer" }) as unknown as RequestAuth;

function call(team: typeof TEAM | null, auth: RequestAuth, path = TEAM_PHONE_PAIRING_PATH, { live = true, base = "https://acme.example" }: { live?: boolean; base?: string | null } = {}) {
  const opened: Array<Record<string, unknown>> = [];
  const route = createTeamPhoneRoutes({
    team,
    sessions: { isLive: () => live, openPairing: (input) => { opened.push(input as Record<string, unknown>); return { id: "p-1", code: "ABCDEFGHJKLM", credential: `omb_pair_${"a".repeat(43)}`, expiresAt: 5_000 }; } },
    publicBase: () => base,
  });
  const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
  const json = ((_res: ServerResponse, status: number, body: Record<string, unknown>) => { answers.push({ status, body }); }) as never;
  return route({ req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(`http://x${path}`), path, method: "POST", auth, json, readBody: (async () => ({})) as never })
    .then((out) => ({ out, opened, answer: answers[0] }));
}

describe("Open on your phone, on a Team Cloud", () => {
  it("makes a code for the person signed in: their address, their role's scopes, and the Admin's last check of them", async () => {
    const { opened, answer } = await call(TEAM, asSession(session({ memberCheckedAt: 700 })));
    expect(opened).toEqual([{ scopes: ["client"], label: "Phone", member: { email: "ada@acme.test", role: "member" }, memberCheckedAt: 700 }]);
    expect(answer).toMatchObject({ status: 200, body: { code: "ABCD-EFGH-JKLM", url: "https://acme.example/pair#code=ABCD-EFGH-JKLM", serverName: "Acme", team: { id: TEAM.id, name: "Acme", role: "member" } } });
    expect(String(answer!.body.inviteUrl)).toContain("name=Acme");
    const admin = await call(TEAM, asSession(session({ email: "ben@acme.test", teamRole: "admin", scopes: ["admin", "client"] })), "/api/auth/pairing");
    expect(admin.opened, "an admin's own pairing code carries them too, never a bare admin code").toEqual([{ scopes: ["admin", "client"], label: "Phone", member: { email: "ben@acme.test", role: "admin" }, memberCheckedAt: 1_000 }]);
  });

  it("answers off a team, and for a session the Admin never signed, exactly as before", async () => {
    expect((await call(null, asSession(session()))).out).toBe(PASS);
    expect((await call(null, asSession(session()), "/api/auth/pairing")).out).toBe(PASS);
    const loopback = { kind: "loopback", scopes: ["admin", "client"] } as unknown as RequestAuth;
    expect((await call(TEAM, loopback, "/api/auth/pairing")).out).toBe(PASS);
    const unsigned = asSession(session({ membershipAuthority: undefined, teamRole: undefined, scopes: ["admin", "client"] }));
    expect((await call(TEAM, unsigned, "/api/auth/pairing")).out).toBe(PASS);
    const refused = await call(TEAM, unsigned);
    expect(refused.answer).toMatchObject({ status: 403 });
    expect(refused.opened).toEqual([]);
  });

  it("makes nothing for an ended session or one with no scope its role gives", async () => {
    expect((await call(TEAM, asSession(session()), TEAM_PHONE_PAIRING_PATH, { live: false })).answer?.status).toBe(401);
    const odd = await call(TEAM, asSession(session({ teamRole: "member", scopes: ["admin"] })));
    expect(odd.answer?.status).toBe(403);
    expect(odd.opened).toEqual([]);
  });

  it("reads a member only from a session the Admin's claim opened", () => {
    expect(sessionMember(session())).toEqual({ member: { email: "ada@acme.test", role: "member" }, checkedAt: 1_000 });
    expect(sessionMember(session({ membershipAuthority: "portal" }))).toBeNull();
    expect(sessionMember(session({ email: undefined }))).toBeNull();
  });
});
