import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { applyCollaborationMigrations, type MigrationState } from "./migrations.ts";

export const COLLABORATION_DATABASE_NAME = "collaboration.sqlite";

export interface CollaborationLedger {
  readonly filePath: string;
  readonly migrationState: MigrationState;
  databaseHealth(): DatabaseHealth;
  close(): void;
}

export interface DatabaseHealth {
  file: typeof COLLABORATION_DATABASE_NAME;
  schemaVersion: number;
  appliedMigrations: number;
  journalMode: "wal";
  foreignKeys: true;
}

export function openCollaborationLedger(dataDirectory: string): CollaborationLedger {
  const directory = resolve(dataDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {}

  const filePath = join(directory, COLLABORATION_DATABASE_NAME);
  closeSync(openSync(filePath, "a", 0o600));
  try {
    chmodSync(filePath, 0o600);
  } catch {}

  const database = new DatabaseSync(filePath);
  try {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    const migrationState = applyCollaborationMigrations(database);

    return {
      filePath,
      migrationState,
      databaseHealth() {
        const journal = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
        const foreignKeys = database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
        if (journal.journal_mode.toLowerCase() !== "wal" || foreignKeys.foreign_keys !== 1) {
          throw new Error("Collaboration ledger safety pragmas are not active");
        }
        return {
          file: basename(filePath) as typeof COLLABORATION_DATABASE_NAME,
          schemaVersion: migrationState.schemaVersion,
          appliedMigrations: migrationState.appliedMigrations,
          journalMode: "wal",
          foreignKeys: true,
        };
      },
      close() {
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
