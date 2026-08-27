import type { DatabaseSync } from "node:sqlite";

import { OPENMAUSBOT_SOURCE_BASELINE } from "./config.ts";

export const COLLABORATION_SCHEMA_VERSION = 1;

interface Migration {
  version: number;
  name: string;
  checksum: string;
  apply(database: DatabaseSync): void;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initialize-collaboration-ledger",
    checksum: "v1:collaboration-ledger-metadata",
    apply(database) {
      database.exec(`
        CREATE TABLE collaboration_ledger_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          format TEXT NOT NULL,
          source_baseline TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ) STRICT;
      `);
      database
        .prepare(
          "INSERT INTO collaboration_ledger_metadata " +
            "(singleton, format, source_baseline, created_at) VALUES (1, ?, ?, ?)",
        )
        .run("openmausbot-collaboration", OPENMAUSBOT_SOURCE_BASELINE, Date.now());
    },
  },
];

export interface MigrationState {
  schemaVersion: number;
  appliedMigrations: number;
}

function userVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

export function applyCollaborationMigrations(database: DatabaseSync): MigrationState {
  database.exec(`
    CREATE TABLE IF NOT EXISTS collaboration_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const applied = database
    .prepare("SELECT version, name, checksum FROM collaboration_schema_migrations ORDER BY version")
    .all() as Array<{ version: number; name: string; checksum: string }>;

  for (const row of applied) {
    const known = migrations.find((migration) => migration.version === row.version);
    if (!known || known.name !== row.name || known.checksum !== row.checksum) {
      throw new Error(`Collaboration migration ${row.version} does not match this service build`);
    }
  }

  for (const migration of migrations) {
    if (applied.some((row) => row.version === migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      migration.apply(database);
      database
        .prepare(
          "INSERT INTO collaboration_schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        )
        .run(migration.version, migration.name, migration.checksum, Date.now());
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  const schemaVersion = userVersion(database);
  const countRow = database.prepare("SELECT count(*) AS count FROM collaboration_schema_migrations").get() as {
    count: number;
  };
  if (schemaVersion !== COLLABORATION_SCHEMA_VERSION || countRow.count !== migrations.length) {
    throw new Error(
      `Collaboration schema is inconsistent (user_version=${schemaVersion}, migrations=${countRow.count})`,
    );
  }
  return { schemaVersion, appliedMigrations: countRow.count };
}
