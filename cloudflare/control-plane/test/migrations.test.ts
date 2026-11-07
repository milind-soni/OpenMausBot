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
