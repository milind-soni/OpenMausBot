import { describe, expect, it } from "vitest";
import { TEAM_SESSION_MAX_MS, isTeamRole, memberLoginRefusal, parseMemberClaim, personalConnectionRefusal, personalMoveRefusal, teamRoleScopes, teamSessionExpiresAt } from "./cloud-team.ts";

const ACME = { id: "team-1", name: "Acme" };

describe("the Admin's member claim", () => {
  it("binds one address and one of the three roles; the team claim, when present, must be this team", () => {
    expect(parseMemberClaim({ member: { email: "Mira@Example.com", role: "owner" } }, ACME)).toEqual({ ok: true, member: { email: "mira@example.com", role: "owner" } });
    expect(parseMemberClaim({ team: { id: "team-1", name: "Acme" }, member: { email: "ben@example.com", role: "admin" } }, ACME)).toEqual({ ok: true, member: { email: "ben@example.com", role: "admin" } });
    expect(parseMemberClaim({ team: { id: "team-2" }, member: { email: "ben@example.com", role: "admin" } }, ACME)).toEqual({ ok: false, error: "team_mismatch" });
    expect(parseMemberClaim({ team: "team-1", member: { email: "ben@example.com", role: "admin" } }, ACME)).toEqual({ ok: false, error: "team_mismatch" });
    expect(parseMemberClaim({}, ACME)).toEqual({ ok: false, error: "member_required" });
    expect(parseMemberClaim({ member: null }, ACME)).toEqual({ ok: false, error: "invalid_member" });
    expect(parseMemberClaim({ member: { email: "ben@example.com", role: "superuser" } }, ACME)).toEqual({ ok: false, error: "invalid_member" });
    expect(parseMemberClaim({ member: { email: "not an address", role: "member" } }, ACME)).toEqual({ ok: false, error: "invalid_member" });
    expect(parseMemberClaim({ member: { email: "<b>@example.com", role: "member" } }, ACME)).toEqual({ ok: false, error: "invalid_member" });
    expect(parseMemberClaim({ member: { role: "member" } }, ACME)).toEqual({ ok: false, error: "invalid_member" });
  });
  it("owners and admins get the admin scope, a member only the client scope", () => {
    expect(teamRoleScopes("owner")).toEqual(["admin", "client"]);
    expect(teamRoleScopes("admin")).toEqual(["admin", "client"]);
    expect(teamRoleScopes("member")).toEqual(["client"]);
    expect(isTeamRole("member")).toBe(true);
    expect(isTeamRole("user")).toBe(false);
  });
});

describe("a team session", () => {
  it("ends within the hour of its pairing, however much it is used", () => {
    expect(TEAM_SESSION_MAX_MS).toBe(3_600_000);
    expect(teamSessionExpiresAt(1_000, 1_000 + 30 * 24 * 3_600_000)).toBe(1_000 + TEAM_SESSION_MAX_MS);
    expect(teamSessionExpiresAt(1_000, 1_000 + 60_000)).toBe(1_000 + 60_000);
  });
});

describe("the lines", () => {
  it("say what is refused and who to ask, in the team's name", () => {
    expect(personalConnectionRefusal(ACME, "Gmail")).toBe("Personal connections never enter Acme. Ask an admin to connect Gmail for Acme.");
    expect(personalConnectionRefusal(ACME)).toBe("Personal connections never enter Acme. Ask an admin to connect it for Acme.");
    expect(personalMoveRefusal(ACME)).toBe("Moving a computer's bots, chats and logins goes to My Cloud only. Nothing personal comes into Acme.");
    expect(memberLoginRefusal(ACME)).toBe("On Acme only an admin can save a login, and it is then used by every bot in Acme.");
  });
});
