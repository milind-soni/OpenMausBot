import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const migrationIndex = (prefix: string) => env.TEST_MIGRATIONS.findIndex((migration) => migration.name.startsWith(prefix));

async function schemaNames(db: D1Database, pattern: string) {
  const rows = await db.prepare(
    "SELECT type, name FROM sqlite_master WHERE name LIKE ? ORDER BY type, name",
  ).bind(pattern).all<{ type: string; name: string }>();
  return rows.results;
}

describe("migration 0013", () => {
  it("drops the retired OAuth relay's tables, rows and indexes included, after 0010", async () => {
    const db = env.MIGRATION_DB;
    const drop = migrationIndex("0013_");
    expect(drop).toBeGreaterThan(migrationIndex("0010_"));
    expect(migrationIndex("0010_")).toBeGreaterThan(migrationIndex("0009_"));
    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, drop));
    // What the relay left behind on a database that had 0009 and 0010.
    await db.batch([
      db.prepare(
        "INSERT INTO highlevel_flows (lookup, ciphertext, created_at, callback_at) VALUES (?, 'sealed', 1, 2)",
      ).bind("a".repeat(64)),
      db.prepare(
        `INSERT INTO highlevel_ip_rate_limits (ip_key, action, window_started_at, attempts, updated_at)
         VALUES (?, 'start', 1, 1, 1)`,
      ).bind("b".repeat(64)),
    ]);
    expect(await schemaNames(db, "highlevel%")).not.toEqual([]);

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    expect(await schemaNames(db, "highlevel%")).toEqual([]);
    // The rest of the schema is untouched.
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'installations'").first())
      .toEqual({ name: "installations" });
    // Running it again, on a database where the tables are already gone, is harmless.
    for (const query of env.TEST_MIGRATIONS[drop]!.queries) await db.prepare(query).run();
    expect(await schemaNames(db, "highlevel%")).toEqual([]);
  });

  it("leaves no relay table in the fully migrated database", async () => {
    expect(await schemaNames(env.DB, "highlevel%")).toEqual([]);
  });
});

describe("migration 0017", () => {
  it("rebuilds the push table for FCM tokens and keeps every APNs registration as one", async () => {
    const db = env.PUSH_MIGRATION_DB;
    const rebuild = migrationIndex("0017_");
    expect(rebuild).toBeGreaterThan(migrationIndex("0016_"));
    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, rebuild));
    await db.batch([
      db.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('user_1', 'Owner', 'owner@example.test', 1, 1, 1)`),
      db.prepare("INSERT INTO installations (id, owner_user_id, client_instance_id, display_name, platform, created_at, updated_at) VALUES ('inst_1', 'user_1', 'client_1', 'Mac', 'darwin', 1, 1)"),
      db.prepare(
        `INSERT INTO installation_push_devices (installation_id, token_hash, token, environment, created_at, updated_at, last_sent_at)
         VALUES ('inst_1', ?, ?, 'sandbox', 10, 20, 30)`,
      ).bind("c".repeat(64), "ab".repeat(32)),
    ]);

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    expect(await db.prepare("SELECT * FROM installation_push_devices").all()).toMatchObject({
      results: [{ installation_id: "inst_1", token_hash: "c".repeat(64), platform: "apns", token: "ab".repeat(32), environment: "sandbox", created_at: 10, updated_at: 20, last_sent_at: 30 }],
    });
    expect(await schemaNames(db, "installation_push_devices%")).toEqual([
      { type: "index", name: "installation_push_devices_token_idx" },
      { type: "table", name: "installation_push_devices" },
    ]);
    const long = `fcm:${"x".repeat(300)}`;
    await db.prepare(
      `INSERT INTO installation_push_devices (installation_id, token_hash, platform, token, environment, created_at, updated_at)
       VALUES ('inst_1', ?, 'fcm', ?, 'production', 1, 1)`,
    ).bind("d".repeat(64), long).run();
    await expect(db.prepare(
      `INSERT INTO installation_push_devices (installation_id, token_hash, platform, token, environment, created_at, updated_at)
       VALUES ('inst_1', ?, 'webpush', ?, 'production', 1, 1)`,
    ).bind("e".repeat(64), long).run()).rejects.toThrow();
  });
});

describe("migration 0018", () => {
  it("gives every existing push token the alert purpose and refuses an unknown one", async () => {
    const rows = await env.DB.prepare("SELECT purpose FROM installation_push_devices LIMIT 1").all();
    expect(rows.success).toBe(true);
    const db = env.PUSH_MIGRATION_DB;
    // 0017's test left one apns row in this database, written before 0018 existed.
    const kept = await db.prepare("SELECT purpose FROM installation_push_devices WHERE token_hash = ?").bind("c".repeat(64)).first<{ purpose: string }>();
    expect(kept?.purpose).toBe("alert");
    await expect(db.prepare(
      `INSERT INTO installation_push_devices (installation_id, token_hash, platform, token, environment, purpose, created_at, updated_at)
       VALUES ('inst_1', ?, 'apns', ?, 'production', 'banner', 1, 1)`,
    ).bind("f".repeat(64), "ab".repeat(32)).run()).rejects.toThrow();
  });
});
