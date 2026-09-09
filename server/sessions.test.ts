import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EXCHANGE_REPLAY_MS,
  formatPairingCode,
  generatePairingCode,
  LOCKOUT,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_TTL_MS,
  SESSION_TTL_MS,
  SessionRegistry,
  STREAM_TICKET_TTL_MS,
  SESSION_MAX_AGE_MS,
  cookieMaxAgeSeconds,
  daysMs,
} from "./sessions.ts";

let dir: string;
let clock: number;
let registry: SessionRegistry;
const file = () => join(dir, "sessions.json");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-sessions-"));
  clock = 1_700_000_000_000;
  registry = new SessionRegistry({ file: file(), now: () => clock });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function pair(label = "MacBook", source = "10.0.0.2") {
  const { code } = registry.openPairing();
  const result = registry.exchange({ code, label, source });
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("pairing codes", () => {
  it("are 12 unambiguous symbols and survive human retyping", () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(12);
      for (const ch of code) expect(PAIRING_CODE_ALPHABET).toContain(ch);
    }
    expect(formatPairingCode("ABCDEFGHJKLM")).toBe("ABCD-EFGH-JKLM");
    expect(normalizePairingCode(" abcd-efgh jklm ")).toBe("ABCDEFGHJKLM");
    expect(normalizePairingCode("0O1I")).toBe("OOII");
  });

  it("exchange once, then never again, and expire after five minutes", () => {
    const { code } = registry.openPairing({ label: "phone" });
    const first = registry.exchange({ code: formatPairingCode(code).toLowerCase(), label: "", source: "a" });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.session.label).toBe("phone");
    // without an attempt id there is no replay: the same source asking again is refused too
    const again = registry.exchange({ code, label: "x", source: "a" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/wrong or has expired/);
    const { code: stale } = registry.openPairing();
    clock += PAIRING_CODE_TTL_MS + 1;
    expect(registry.exchange({ code: stale, label: "x", source: "b" }).ok).toBe(false);
    expect(registry.openPairings()).toEqual([]);
  });

  it("locks a source out after repeated failures, and forgets on success", () => {
    for (let i = 0; i < LOCKOUT.failures; i++) {
      expect(registry.exchange({ code: "AAAAAAAAAAAA", label: "", source: "attacker" }).ok).toBe(false);
    }
    const { code } = registry.openPairing();
    const locked = registry.exchange({ code, label: "", source: "attacker" });
    expect(locked.ok).toBe(false);
    if (!locked.ok) {
      expect(locked.status).toBe(429);
      expect(locked.error).toMatch(/from your address; try again in 60s/);
    }
    // a different source is unaffected, and the code is still unused
    expect(registry.exchange({ code, label: "", source: "friend" }).ok).toBe(true);
    clock += LOCKOUT.lockMs + 1;
    const { code: fresh } = registry.openPairing();
    expect(registry.exchange({ code: fresh, label: "", source: "attacker" }).ok).toBe(true);
  });

  it("answers a lost-response retry with the same session for a minute, keyed on the client's attempt id", () => {
    const { code } = registry.openPairing();
    const first = registry.exchange({ code, label: "phone", source: "a", attemptId: "attempt-0001-abcd" });
    expect(first.ok).toBe(true);
    // same attempt id: the same answer, even from another address (the phone changed networks)
    expect(registry.exchange({ code, label: "phone", source: "b", attemptId: "attempt-0001-abcd" })).toEqual(first);
    expect(registry.list()).toHaveLength(1);
    // a different attempt id, or none, is a new attempt against a consumed code
    expect(registry.exchange({ code, label: "x", source: "a", attemptId: "attempt-0002-efgh" }).ok).toBe(false);
    expect(registry.exchange({ code, label: "x", source: "a" }).ok).toBe(false);
    // malformed attempt ids never replay
    const { code: c2 } = registry.openPairing();
    expect(registry.exchange({ code: c2, label: "p", source: "a", attemptId: "no" }).ok).toBe(true);
    expect(registry.exchange({ code: c2, label: "p", source: "a", attemptId: "no" }).ok).toBe(false);
    clock += EXCHANGE_REPLAY_MS + 1;
    expect(registry.exchange({ code, label: "phone", source: "a", attemptId: "attempt-0001-abcd" }).ok).toBe(false);
  });

  it("forgets a source's failures once its window and lock have passed", () => {
    registry.exchange({ code: "AAAAAAAAAAAA", label: "", source: "flaky" });
    expect(registry.failureSources()).toContain("flaky");
    clock += LOCKOUT.windowMs + 1;
    registry.openPairing(); // any registry activity prunes
    expect(registry.failureSources()).not.toContain("flaky");
  });

  it("names the device from the client, else the code's label, else the user agent", () => {
    const a = registry.openPairing({ label: "Milind's MacBook" });
    const named = registry.exchange({ code: a.code, label: "", source: "s1", fallbackLabel: "Safari on Mac" });
    if (!named.ok) throw new Error(named.error);
    expect(named.session.label).toBe("Milind's MacBook");
    const b = registry.openPairing();
    const ua = registry.exchange({ code: b.code, label: "  ", source: "s2", fallbackLabel: "Safari on Mac" });
    if (!ua.ok) throw new Error(ua.error);
    expect(ua.session.label).toBe("Safari on Mac");
    const c = registry.openPairing({ label: "ignored" });
    const explicit = registry.exchange({ code: c.code, label: "Kitchen iPad", source: "s3", fallbackLabel: "Safari on iPad" });
    if (!explicit.ok) throw new Error(explicit.error);
    expect(explicit.session.label).toBe("Kitchen iPad");
  });

  it("carries scopes from the code into the session, deduplicated", () => {
    const { code } = registry.openPairing({ scopes: ["client", "client"] });
    const result = registry.exchange({ code, label: "viewer", source: "s" });
    if (!result.ok) throw new Error(result.error);
    expect(result.session.scopes).toEqual(["client"]);
    expect(pair().session.scopes).toEqual(["admin", "client"]);
  });
});

describe("sessions", () => {
  it("stores only a hash, owner-only, and reloads from disk", () => {
    const { token, session } = pair();
    const onDisk = readFileSync(file(), "utf8");
    expect(onDisk).not.toContain(token);
    expect(onDisk).toContain(session.id);
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600); // Windows has no POSIX modes
    const reloaded = new SessionRegistry({ file: file(), now: () => clock });
    expect(reloaded.authenticate(token)?.id).toBe(session.id);
    expect(reloaded.authenticate("omb_sess_nope")).toBeNull();
  });

  it("expires after 30 days and can be revoked", () => {
    const { token, session } = pair();
    clock += SESSION_TTL_MS - 1;
    expect(registry.authenticate(token)?.id).toBe(session.id);
    clock += 2;
    expect(registry.authenticate(token)).toBeNull();
    const other = pair("iPad");
    expect(registry.list().map((s) => s.label)).toEqual(["iPad"]);
    expect(registry.revoke(other.session.id)).toBe(true);
    expect(registry.revoke(other.session.id)).toBe(false);
    expect(registry.authenticate(other.token)).toBeNull();
  });

  it("updates last-seen at most once a minute so reads stay cheap", () => {
    const { token } = pair();
    const before = statSync(file()).mtimeMs;
    clock += 1_000;
    registry.authenticate(token);
    expect(registry.list()[0]?.lastSeenAt).toBe(clock - 1_000);
    clock += 60_000;
    registry.authenticate(token);
    expect(registry.list()[0]?.lastSeenAt).toBe(clock);
    expect(statSync(file()).mtimeMs).toBeGreaterThanOrEqual(before);
  });

  it("renews a session with half its term or less left, and never revives an expired one", () => {
    const { token, session } = pair();
    clock += SESSION_TTL_MS / 2 - 60_000;
    expect(registry.renew(session.id)).toBe(false); // more than half left: untouched
    expect(registry.list()[0]?.expiresAt).toBe(session.expiresAt);
    clock += 120_000;
    expect(registry.renew(session.id)).toBe(true);
    expect(registry.list()[0]?.expiresAt).toBe(clock + SESSION_TTL_MS);
    expect(registry.renew(session.id)).toBe(false); // just renewed: nothing to do
    clock += SESSION_TTL_MS - 1;
    expect(registry.authenticate(token)?.id).toBe(session.id); // alive well past the original term
    expect(registry.renew(session.id)).toBe(true);
    const reloaded = new SessionRegistry({ file: file(), now: () => clock });
    expect(reloaded.list()[0]?.expiresAt).toBe(clock + SESSION_TTL_MS); // the renewal reached disk
    const quiet = pair("iPad");
    clock += SESSION_TTL_MS + 1;
    expect(registry.renew(quiet.session.id)).toBe(false);
    expect(registry.authenticate(quiet.token)).toBeNull();
  });

  it("stops renewing at the absolute cap counted from pairing", () => {
    const { token, session } = pair();
    const cap = session.createdAt + SESSION_MAX_AGE_MS;
    let last = session.expiresAt;
    for (let i = 0; i < 20; i += 1) {
      clock = last - SESSION_TTL_MS / 2; // exactly at the halfway mark, each time
      registry.renew(session.id);
      const now = registry.list()[0]?.expiresAt ?? 0;
      expect(now).toBeLessThanOrEqual(cap);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
    expect(last).toBe(cap);
    clock = cap - 1;
    expect(registry.authenticate(token)?.id).toBe(session.id);
    expect(registry.renew(session.id)).toBe(false); // at the cap: no further extension
    clock = cap + 1;
    expect(registry.authenticate(token)).toBeNull();
  });

  it("applies the cap to a session paired long before this version", () => {
    const day = 24 * 60 * 60_000;
    const old = {
      id: "old-device", tokenHash: "0".repeat(64), label: "old laptop", scopes: ["admin"],
      createdAt: clock - 160 * day, lastSeenAt: clock - day, expiresAt: clock + 15 * day,
    };
    const older = { ...old, id: "older-device", tokenHash: "1".repeat(64), createdAt: clock - 175 * day };
    writeFileSync(file(), JSON.stringify({ version: 1, sessions: [old, older] }));
    const loaded = new SessionRegistry({ file: file(), now: () => clock });
    // 160 days in with 15 left: the cap allows 20, so the renewal reaches the cap, not a full term
    expect(loaded.renew("old-device")).toBe(true);
    expect(loaded.list()[0]?.expiresAt).toBe(old.createdAt + SESSION_MAX_AGE_MS);
    // 175 days in with 15 left: the cap (5 days out) is already below the term it has; nothing is taken away
    expect(loaded.renew("older-device")).toBe(false);
    expect(loaded.list()[1]?.expiresAt).toBe(older.expiresAt);
  });

  it("reads whole days from the environment and falls back on anything else", () => {
    const day = 24 * 60 * 60_000;
    expect(daysMs(undefined, 30)).toBe(30 * day);
    expect(daysMs("7", 30)).toBe(7 * day);
    for (const bad of ["0", "-1", "0.5", "soon", "1e308", "3651", ""]) expect(daysMs(bad, 30)).toBe(30 * day);
    expect(daysMs("3650", 30)).toBe(3650 * day);
  });

  it("gives a cookie whole seconds, never less than one", () => {
    expect(cookieMaxAgeSeconds({ expiresAt: 10_500 }, 0)).toBe(10);
    expect(cookieMaxAgeSeconds({ expiresAt: 100 }, 0)).toBe(1);
    expect(cookieMaxAgeSeconds({ expiresAt: 0 }, 5_000)).toBe(1);
  });
});

describe("stream tickets", () => {
  it("are single use, short-lived, and die with their session", () => {
    const { session } = pair();
    const { ticket } = registry.issueStreamTicket(session.id);
    expect(registry.redeemStreamTicket(ticket)?.id).toBe(session.id);
    expect(registry.redeemStreamTicket(ticket)).toBeNull();
    const { ticket: late } = registry.issueStreamTicket(session.id);
    clock += STREAM_TICKET_TTL_MS + 1;
    expect(registry.redeemStreamTicket(late)).toBeNull();
    const { ticket: orphan } = registry.issueStreamTicket(session.id);
    registry.revoke(session.id);
    expect(registry.redeemStreamTicket(orphan)).toBeNull();
  });
});
