// A saved app's folder:
//
//   app.json              { "name": "...", "uses": ["data"], "operations": { "<name>": { "kind": "read" | "change" } } }
//   ui/index.html         the sealed page; only ui/ is ever served or published
//   server/operations.js  an ES module exporting `async function <name>(input, ctx)` per declared operation
//   migrations/NNN_*.sql  numbered from 1 with no gaps, applied once each, in order, to the app's own SQLite file
//
// Security: app.json, server/ and migrations/ are the app's server side; see private-files.ts for where a page's files are
// read.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type OperationKind = "read" | "change";
export type AppOperationUse = "data" | "connectors";

export interface AppManifest {
  name: string;
  uses: AppOperationUse[];
  operations: Record<string, { kind: OperationKind }>;
  /** connector name → the tools the app may call, when uses has "connectors". */
  connectors: Record<string, string[]>;
}

export interface AppMigration {
  version: number;
  name: string;
  sql: string;
}

export interface LoadedApp {
  id: string;
  dir: string;
  manifest: AppManifest;
  operationsFile: string;
  migrations: AppMigration[];
  /** Changes when app.json, server/operations.js or a migration changes. */
  signature: string;
}

export class AppManifestError extends Error {}

const OPERATION_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MIGRATION_FILE = /^(\d{1,6})_[A-Za-z0-9_-]{1,80}\.sql$/;
const USES = new Set<AppOperationUse>(["data", "connectors"]);
export const APP_MANIFEST_LIMITS = { operations: 64, migrations: 500, migrationBytes: 256 * 1024, operationsBytes: 1024 * 1024 } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseManifest(value: unknown): AppManifest {
  if (!isRecord(value)) throw new AppManifestError("app.json must be one JSON object.");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 80) throw new AppManifestError("app.json needs a name of 1 to 80 characters.");
  const uses = value.uses === undefined ? [] : value.uses;
  if (!Array.isArray(uses) || uses.some((use) => !USES.has(use as AppOperationUse))) {
    throw new AppManifestError(`app.json uses may list only ${[...USES].map((use) => `"${use}"`).join(" and ")}.`);
  }
  if (!isRecord(value.operations)) throw new AppManifestError('app.json needs operations, e.g. { "list": { "kind": "read" } }.');
  const entries = Object.entries(value.operations);
  if (entries.length > APP_MANIFEST_LIMITS.operations) throw new AppManifestError(`An app can declare at most ${APP_MANIFEST_LIMITS.operations} operations.`);
  const operations: AppManifest["operations"] = {};
  for (const [opName, spec] of entries) {
    if (!OPERATION_NAME.test(opName)) throw new AppManifestError(`"${opName}" is not an operation name: letters, digits and _ only.`);
    const kind = isRecord(spec) ? spec.kind : undefined;
    if (kind !== "read" && kind !== "change") throw new AppManifestError(`Operation ${opName} needs kind "read" or "change".`);
    operations[opName] = { kind };
  }
  const connectors: Record<string, string[]> = {};
  if (isRecord(value.connectors)) {
    for (const [connector, tools] of Object.entries(value.connectors)) {
      if (Array.isArray(tools) && tools.every((tool) => typeof tool === "string")) connectors[connector] = tools as string[];
    }
  }
  return { name, uses: [...new Set(uses as AppOperationUse[])], operations, connectors };
}

export function readMigrations(dir: string): AppMigration[] {
  let names: string[];
  try { names = readdirSync(join(dir, "migrations")); } catch { return []; }
  const migrations: AppMigration[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const match = MIGRATION_FILE.exec(name);
    if (!match) throw new AppManifestError(`migrations/${name} is not named NNN_name.sql.`);
    const file = join(dir, "migrations", name);
    if (statSync(file).size > APP_MANIFEST_LIMITS.migrationBytes) throw new AppManifestError(`migrations/${name} is larger than ${APP_MANIFEST_LIMITS.migrationBytes} bytes.`);
    migrations.push({ version: Number(match[1]), name, sql: readFileSync(file, "utf8") });
  }
  migrations.sort((a, b) => a.version - b.version);
  if (migrations.length > APP_MANIFEST_LIMITS.migrations) throw new AppManifestError(`An app can have at most ${APP_MANIFEST_LIMITS.migrations} migrations.`);
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new AppManifestError(`Migrations are numbered from 1 with no gaps or repeats; ${migration.name} should be number ${index + 1}.`);
  });
  return migrations;
}

/** The app at `dir`, read and checked. Its id is fixed by the folder's real path. */
export function loadApp(dir: string): LoadedApp {
  const real = realpathSync(dir);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(real, "app.json"), "utf8")); } catch (error) {
    throw new AppManifestError(`app.json could not be read: ${(error as Error).message}`);
  }
  const manifest = parseManifest(raw);
  const operationsFile = join(real, "server", "operations.js");
  const info = statSync(operationsFile, { throwIfNoEntry: false });
  if (!info?.isFile()) throw new AppManifestError("server/operations.js is missing.");
  if (info.size > APP_MANIFEST_LIMITS.operationsBytes) throw new AppManifestError(`server/operations.js is larger than ${APP_MANIFEST_LIMITS.operationsBytes} bytes.`);
  const migrations = readMigrations(real);
  const hash = createHash("sha256");
  hash.update(JSON.stringify(manifest)).update(readFileSync(operationsFile));
  for (const migration of migrations) hash.update(migration.name).update(migration.sql);
  return {
    id: createHash("sha256").update(real).digest("hex").slice(0, 16),
    dir: real,
    manifest,
    operationsFile,
    migrations,
    signature: hash.digest("hex"),
  };
}

/** Cheap check of whether the app's server side changed since `signature`, without hashing: sizes and modified times. */
export function appStamp(dir: string): string {
  const parts: string[] = [];
  for (const path of [join(dir, "app.json"), join(dir, "server", "operations.js")]) {
    const info = statSync(path, { throwIfNoEntry: false });
    parts.push(info ? `${info.size}:${info.mtimeMs}` : "-");
  }
  try {
    for (const name of readdirSync(join(dir, "migrations")).sort()) {
      const info = statSync(join(dir, "migrations", name), { throwIfNoEntry: false });
      parts.push(`${name}:${info?.size}:${info?.mtimeMs}`);
    }
  } catch { parts.push("no-migrations"); }
  return parts.join("|");
}
