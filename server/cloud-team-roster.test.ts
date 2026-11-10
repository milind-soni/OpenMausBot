import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTeamRoster, TEAM_ROSTER_ADMIN_PATH, teamRosterSignature } from "./cloud-team-roster.ts";
import { SessionRegistry } from "./sessions.ts";

const HOUR = 60 * 60_000, MINUTE = 60_000;
const ADA = { email: "ada@acme.test", role: "member" as const };
const ADMIN = "https://cloud.example.test";
const SECRET = "s".repeat(43);

let dir: string, clock: number, registry: SessionRegistry;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-team-roster-"));
  clock = Date.UTC(2026, 10, 10, 9);
  registry = new SessionRegistry({ file: join(dir, "sessions.json"), now: () => clock });
});
afterEach(() => { registry.close(); rmSync(dir, { recursive: true, force: true }); });

/** A browser sign-in the Admin signed for a member (the join page's Open, a User's team home). */
function browserSession(member: { email: string; role: "owner" | "admin" | "member" } = ADA) {
  const { credential } = registry.openPairing({ scopes: ["client"], member, browser: true, owner: member.email });
  const paired = registry.exchange({ code: credential, browser: true, label: "Safari on Mac", source: "b" });
  if (!paired.ok) throw new Error(paired.error);
  return paired.token;
}
/** A code the member made from that session, redeemed by their phone. */
function phoneSession(token: string) {
  const session = registry.authenticate(token)!;
  const { code } = registry.openPairing({ scopes: ["client"], member: { email: session.email!, role: session.teamRole! }, memberCheckedAt: session.createdAt });
  const paired = registry.exchange({ code, label: "Ada's phone", source: "p" });
  if (!paired.ok) throw new Error(paired.error);
  return paired.token;
}

/** The Admin as the Team Cloud meets it: checks the signature, answers each address's role from `roster`. */
function admin(roster: Record<string, string | null>, options: { status?: number; down?: boolean } = {}) {
  const asked: string[][] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (options.down) throw new TypeError("fetch failed");
    expect(url).toBe(`${ADMIN}${TEAM_ROSTER_ADMIN_PATH}`);
    const headers = init.headers as Record<string, string>, body = String(init.body);
    expect(headers["x-omb-cloud-signature"]).toBe(`v1=${teamRosterSignature(SECRET, "cm-home", headers["x-omb-cloud-timestamp"]!, headers["x-omb-cloud-nonce"]!, body)}`);
    const emails = (JSON.parse(body) as { emails: string[] }).emails;
    asked.push(emails);
    if (options.status) return Response.json({ error: "no" }, { status: options.status });
    return Response.json({ members: Object.fromEntries(emails.map((email) => [email, roster[email] ?? null])) });
  }) as unknown as typeof fetch;
  const roster_ = startTeamRoster({ machineId: "cm-home", adminOrigin: ADMIN, secret: SECRET, sessions: registry, fetchImpl, now: () => clock,
    setTimer: () => ({}), clearTimer: () => {} });
  return { check: roster_.check, asked };
}

describe("a Team Cloud's roster check", () => {
  it("signs as openmaus-cloud's server/cloud-team-roster.ts does", () => {
    // The same vector is pinned in openmaus-cloud tests/cloud-team-join.test.ts.
    expect(teamRosterSignature(SECRET, "cm-test-home", "1792670400", "nonce-nonce-nonce-1", '{"v":1,"emails":["ada@acme.test"]}')).toBe("WvlpjOna5b6fkOkqkNZgLdv0c913uLp8ufS_2gFEI3Y");
  });

  it("keeps a member's browser and phone signed in while they use them, with no desktop pairing again, and across a restart", async () => {
    const browser = browserSession(), phone = phoneSession(browser);
    const started = clock;
    const { check, asked } = admin({ [ADA.email]: "member" });
    clock += 30 * MINUTE;
    await check();
    expect(asked, "nobody's session ends soon: nothing is asked").toEqual([]);
    clock += 15 * MINUTE;
    registry.authenticate(browser);
    await check();
    expect(asked).toEqual([[ADA.email]]);
    expect(registry.authenticate(browser)?.expiresAt).toBe(clock + HOUR);
    expect(registry.authenticate(phone)?.expiresAt).toBe(clock + HOUR);
    registry.close();
    registry = new SessionRegistry({ file: join(dir, "sessions.json"), now: () => clock });
    clock = started + HOUR + 10 * MINUTE;
    expect(registry.authenticate(browser), "past the first hour, kept by the Admin's word").not.toBeNull();
    expect(registry.authenticate(phone)).not.toBeNull();
  });

  it("asks nothing about a session nobody used in the last hour; it ends at its hour", async () => {
    const browser = browserSession();
    const { check, asked } = admin({ [ADA.email]: "member" });
    clock += 59 * MINUTE;
    // Not used since it opened, an hour ago in effect: the check leaves it.
    clock += 2 * MINUTE;
    await check();
    expect(asked).toEqual([]);
    expect(registry.authenticate(browser)).toBeNull();
  });

  it("signs someone out at once when the Admin no longer lists them, and ends sessions at a role they no longer have", async () => {
    const ada = browserSession(), ben = browserSession({ email: "ben@acme.test", role: "admin" });
    const { check } = admin({ [ADA.email]: null, "ben@acme.test": "member" });
    clock += 45 * MINUTE;
    registry.authenticate(ada); registry.authenticate(ben);
    await check();
    expect(registry.authenticate(ada)).toBeNull();
    expect(registry.authenticate(ben), "an Admin made a User: their admin session ends").toBeNull();
  });

  it("no answer, a refusal or an older Admin changes nothing: sessions end within the hour, as before", async () => {
    for (const options of [{ down: true }, { status: 404 }, { status: 401 }, { status: 503 }]) {
      const browser = browserSession(), opened = clock;
      const { check } = admin({ [ADA.email]: "member" }, options);
      clock += 45 * MINUTE;
      registry.authenticate(browser);
      await check();
      expect(registry.authenticate(browser)?.expiresAt).toBe(opened + HOUR);
      clock = opened + HOUR;
      expect(registry.authenticate(browser)).toBeNull();
    }
  });
});
