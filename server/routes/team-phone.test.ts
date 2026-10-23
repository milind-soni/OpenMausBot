import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import type { PublicSession, SessionRecord } from "../sessions.ts";
import { PASS } from "./table.ts";
import { createTeamPhoneRoutes, sessionMember, TEAM_PHONE_PAIRING_PATH, TEAM_PHONES_PATH, visiblePhones } from "./team-phone.ts";

const TEAM = { id: "team-acme-1", name: "Acme" };
const session = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "s-ada", tokenHash: "0".repeat(64), label: "Desktop", scopes: ["client"], createdAt: 1_000, lastSeenAt: 1_000, expiresAt: 9_000,
  email: "ada@acme.test", teamRole: "member", membershipAuthority: "team", ...over,
});
const asSession = (record: SessionRecord): RequestAuth => ({ kind: "session", scopes: record.scopes, session: record, via: "bearer" }) as unknown as RequestAuth;

const phone = (id: string, email: string, label: string, createdAt = 2_000): PublicSession => ({ id, label, email, teamRole: "member", scopes: ["client"], createdAt, lastSeenAt: createdAt, expiresAt: 9_000 });
const PHONES = [phone("ph-cleo", "cleo@acme.test", "Cleo's Pixel"), phone("ph-ada-2", "ada@acme.test", "Ada's iPad", 3_000), phone("ph-ada", "ada@acme.test", "Ada's iPhone")];

function call(team: typeof TEAM | null, auth: RequestAuth, path = TEAM_PHONE_PAIRING_PATH, { live = true, base = "https://acme.example", method = "POST" }: { live?: boolean; base?: string | null; method?: string } = {}) {
  const opened: Array<Record<string, unknown>> = [];
  const revoked: string[] = [];
  const route = createTeamPhoneRoutes({
    team,
    sessions: {
      isLive: () => live,
      openPairing: (input) => { opened.push(input as Record<string, unknown>); return { id: "p-1", code: "ABCDEFGHJKLM", credential: `omb_pair_${"a".repeat(43)}`, expiresAt: 5_000 }; },
      memberPhones: () => PHONES.filter((entry) => !revoked.includes(entry.id)),
      revoke: (id) => { revoked.push(id); return true; },
    },
    publicBase: () => base,
  });
  const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
  const json = ((_res: ServerResponse, status: number, body: Record<string, unknown>) => { answers.push({ status, body }); }) as never;
  return route({ req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL(`http://x${path}`), path, method, auth, json, readBody: (async () => ({})) as never })
    .then((out) => ({ out, opened, revoked, answer: answers[0] }));
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

describe("the phones beside the code, on a Team Cloud", () => {
  const ada = asSession(session());
  const ben = asSession(session({ id: "s-ben", email: "ben@acme.test", teamRole: "admin", scopes: ["admin", "client"] }));
  const rows = (body: Record<string, unknown> | undefined) => ((body?.phones ?? []) as Array<{ label: string; email: string }>).map((entry) => `${entry.label} · ${entry.email}`);

  it("lists a member's own phones for her, and every member's for an admin or the owner", async () => {
    const mine = await call(TEAM, ada, TEAM_PHONES_PATH, { method: "GET" });
    expect(mine.answer?.status).toBe(200);
    expect(rows(mine.answer?.body)).toEqual(["Ada's iPhone · ada@acme.test", "Ada's iPad · ada@acme.test"]);
    expect(mine.answer?.body.current).toBe("s-ada");
    expect(JSON.stringify(mine.answer?.body), "never the session's scopes or tokens").not.toMatch(/scopes|token/);
    const everyone = ["Ada's iPhone · ada@acme.test", "Ada's iPad · ada@acme.test", "Cleo's Pixel · cleo@acme.test"];
    expect(rows((await call(TEAM, ben, TEAM_PHONES_PATH, { method: "GET" })).answer?.body)).toEqual(everyone);
    const olive = asSession(session({ id: "s-olive", email: "olive@acme.test", teamRole: "owner", scopes: ["admin", "client"] }));
    expect(rows((await call(TEAM, olive, TEAM_PHONES_PATH, { method: "GET" })).answer?.body)).toEqual(everyone);
  });

  it("an admin's role with no admin scope on the session sees only their own", () => {
    expect(visiblePhones(PHONES, { email: "ada@acme.test", role: "admin" }, ["client"]).map((entry) => entry.id)).toEqual(["ph-ada", "ph-ada-2"]);
  });

  it("removes a member's own phone or, for an admin, anyone's; never another member's", async () => {
    const refused = await call(TEAM, ada, `${TEAM_PHONES_PATH}/ph-cleo`, { method: "DELETE" });
    expect(refused.answer?.status).toBe(404);
    expect(refused.revoked).toEqual([]);
    const own = await call(TEAM, ada, `${TEAM_PHONES_PATH}/ph-ada`, { method: "DELETE" });
    expect(own.answer).toEqual({ status: 200, body: { ok: true } });
    expect(own.revoked).toEqual(["ph-ada"]);
    const byAdmin = await call(TEAM, ben, `${TEAM_PHONES_PATH}/ph-cleo`, { method: "DELETE" });
    expect(byAdmin.answer?.status).toBe(200);
    expect(byAdmin.revoked).toEqual(["ph-cleo"]);
    const notAPhone = await call(TEAM, ben, `${TEAM_PHONES_PATH}/s-ada`, { method: "DELETE" });
    expect(notAPhone.answer?.status, "an app's own sign-in is not removed here").toBe(404);
    expect(notAPhone.revoked).toEqual([]);
  });

  it("answers off a team as before, and refuses a session the Admin never signed", async () => {
    expect((await call(null, ada, TEAM_PHONES_PATH, { method: "GET" })).out).toBe(PASS);
    expect((await call(null, ben, `${TEAM_PHONES_PATH}/ph-ada`, { method: "DELETE" })).out).toBe(PASS);
    const unsigned = asSession(session({ membershipAuthority: undefined, teamRole: undefined, scopes: ["admin", "client"] }));
    expect((await call(TEAM, unsigned, TEAM_PHONES_PATH, { method: "GET" })).answer?.status).toBe(403);
    const loopback = { kind: "loopback", scopes: ["admin", "client"] } as unknown as RequestAuth;
    const fromLoopback = await call(TEAM, loopback, `${TEAM_PHONES_PATH}/ph-ada`, { method: "DELETE" });
    expect(fromLoopback.answer?.status).toBe(403);
    expect(fromLoopback.revoked).toEqual([]);
  });
});
