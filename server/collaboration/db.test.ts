import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { OPENMAUSBOT_SOURCE_BASELINE } from "./config.ts";
import { COLLABORATION_DATABASE_NAME, openCollaborationLedger } from "./db.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmausbot-collaboration-ledger-"));
  scratch.push(directory);
  return directory;
}

describe("collaboration ledger", () => {
  it("creates a private, versioned WAL database", () => {
    const directory = temporaryDirectory();
    const ledger = openCollaborationLedger(directory);
    expect(ledger.databaseHealth()).toEqual({
      file: COLLABORATION_DATABASE_NAME,
      schemaVersion: 6,
      appliedMigrations: 6,
      journalMode: "wal",
      foreignKeys: true,
    });
    expect(statSync(ledger.filePath).mode & 0o777).toBe(0o600);
    ledger.close();

    const database = new DatabaseSync(join(directory, COLLABORATION_DATABASE_NAME), { readOnly: true });
    const metadata = database.prepare("SELECT format, source_baseline FROM collaboration_ledger_metadata").get();
    expect(metadata).toEqual({
      format: "openmausbot-collaboration",
      source_baseline: OPENMAUSBOT_SOURCE_BASELINE,
    });
    database.close();
  });

  it("reopens without duplicating or recreating schema state", () => {
    const directory = temporaryDirectory();
    const first = openCollaborationLedger(directory);
    first.close();

    const before = new DatabaseSync(join(directory, COLLABORATION_DATABASE_NAME));
    const initialMigration = before
      .prepare("SELECT version, name, checksum, applied_at FROM collaboration_schema_migrations")
      .all();
    const initialMetadata = before.prepare("SELECT * FROM collaboration_ledger_metadata").get();
    before.close();

    const second = openCollaborationLedger(directory);
    expect(second.migrationState).toEqual({ schemaVersion: 6, appliedMigrations: 6 });
    second.close();

    const after = new DatabaseSync(join(directory, COLLABORATION_DATABASE_NAME));
    expect(after.prepare("SELECT count(*) AS count FROM collaboration_schema_migrations").get()).toEqual({ count: 6 });
    expect(after.prepare("SELECT version, name, checksum, applied_at FROM collaboration_schema_migrations").all()).toEqual(
      initialMigration,
    );
    expect(after.prepare("SELECT * FROM collaboration_ledger_metadata").get()).toEqual(initialMetadata);
    after.close();
  });

  it("refuses a migration record that does not match the running build", () => {
    const directory = temporaryDirectory();
    const ledger = openCollaborationLedger(directory);
    ledger.close();
    const database = new DatabaseSync(join(directory, COLLABORATION_DATABASE_NAME));
    database.prepare("UPDATE collaboration_schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    database.close();

    expect(() => openCollaborationLedger(directory)).toThrow("does not match this service build");
  });
});
