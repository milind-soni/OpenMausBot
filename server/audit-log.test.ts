import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendAudit, flushAuditLog, readAudit } from "./audit-log.ts";

let dir: string;
const file = () => join(dir, "audit.ndjson");
const actor = { kind: "user" as const, userId: "u-ada", userName: "Ada", source: "10.0.0.2" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omb-audit-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the human-action log", () => {
  it("writes one 0600 row per action, oldest first, with the actor and target", async () => {
    appendAudit(dir, { action: "user.create", actor, target: { kind: "user", id: "u-bob", name: "Bob" }, changes: { role: "member" } });
    appendAudit(dir, { action: "user.disable", actor, target: { kind: "user", id: "u-bob", name: "Bob" }, effects: { revokedSessions: 2 } });
    await flushAuditLog(dir);

    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);
    const rows = readAudit(dir, 10);
    expect(rows.map((r) => r.action)).toEqual(["user.create", "user.disable"]);
    expect(rows[0].actor).toMatchObject({ kind: "user", userId: "u-ada", userName: "Ada" });
    expect(rows[0].target).toMatchObject({ id: "u-bob", name: "Bob" });
    expect(rows[1].effects).toEqual({ revokedSessions: 2 });
    // Every row is stamped, and stamped in order.
    expect(new Date(rows[0].at).getTime()).toBeLessThanOrEqual(new Date(rows[1].at).getTime());
  });

  it("serializes concurrent appends instead of interleaving them", async () => {
    for (let i = 0; i < 25; i++) {
      appendAudit(dir, { action: "pairing.mint", actor, target: { kind: "pairing", id: `p-${i}` } });
    }
    await flushAuditLog(dir);
    const rows = readAudit(dir, 100);
    expect(rows).toHaveLength(25);
    // Order preserved, and no torn lines (every line parsed).
    expect(rows.map((r) => r.target?.id)).toEqual(Array.from({ length: 25 }, (_, i) => `p-${i}`));
  });

  it("returns only the newest rows when asked for fewer", async () => {
    for (let i = 0; i < 10; i++) appendAudit(dir, { action: "session.revoke", actor, target: { kind: "session", id: `s-${i}` } });
    await flushAuditLog(dir);
    expect(readAudit(dir, 3).map((r) => r.target?.id)).toEqual(["s-7", "s-8", "s-9"]);
  });

  it("filters by person, matching them as either the actor or the target", async () => {
    appendAudit(dir, { action: "user.create", actor, target: { kind: "user", id: "u-bob" } });
    appendAudit(dir, { action: "user.create", actor: { kind: "loopback" }, target: { kind: "user", id: "u-cara" } });
    await flushAuditLog(dir);
    expect(readAudit(dir, 10, { userId: "u-bob" }).map((r) => r.target?.id)).toEqual(["u-bob"]);
    // Ada acted on Bob, so filtering by Ada finds that row through the actor.
    expect(readAudit(dir, 10, { userId: "u-ada" })).toHaveLength(1);
    expect(readAudit(dir, 10, { userId: "nobody" })).toEqual([]);
  });

  it("rotates past the cap and still reads history back across both files", async () => {
    // A tiny cap so a couple of rows trip it.
    for (let i = 0; i < 6; i++) {
      appendAudit(dir, { action: "user.update", actor, target: { kind: "user", id: `u-${i}` } }, { maxBytes: 200 });
      await flushAuditLog(dir);
    }
    const rows = readAudit(dir, 100);
    // Rotation keeps the previous file, so history survives the roll.
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[rows.length - 1].target?.id).toBe("u-5");
    expect(statSync(`${file()}.1`).isFile()).toBe(true);
  });

  it("skips a torn last line rather than losing the whole log", async () => {
    appendAudit(dir, { action: "user.create", actor, target: { kind: "user", id: "u-bob" } });
    await flushAuditLog(dir);
    writeFileSync(file(), readFileSync(file(), "utf8") + '{"at":"2026-01-01T00:00:00Z","action":"user.rem');
    const rows = readAudit(dir, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].target?.id).toBe("u-bob");
  });

  it("never throws when the directory cannot be written", async () => {
    // The whole contract: an audit log must not take down the action it audits.
    expect(() => appendAudit(join(dir, "does", "not", "exist"), { action: "user.create", actor })).not.toThrow();
    await flushAuditLog(join(dir, "does", "not", "exist"));
    expect(readAudit(join(dir, "does", "not", "exist"), 10)).toEqual([]);
  });
});
