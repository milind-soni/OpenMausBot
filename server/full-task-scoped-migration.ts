import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

import { FULL_TASK_SCOPED_SYSTEM_PROMPT } from "./access-profile.ts";
import { writeFileAtomic } from "./atomic.ts";

const SCHEMA = "openmaus.full-task-scoped-migration.v1" as const;
const JOURNAL_SCHEMA = "openmaus.full-task-scoped-migration-transaction.v1" as const;
const MIGRATION_TITLE = "Full-task-scoped runtime";
const STATE_FILES = ["bots.json", "routines.json", "webhooks.json"] as const;
const RECEIPT_FILE = "migration-full-task-scoped.v1.json";
const JOURNAL_FILE = ".full-task-scoped-migration.transaction.json";
const LOCK_FILE = ".full-task-scoped-migration.lock";

interface FileSnapshot {
  name: string;
  existed: boolean;
  sha256: string | null;
}

interface MigrationJournal {
  schema: typeof JOURNAL_SCHEMA;
  status: "prepared" | "committed";
  backupDirectory: string;
  files: FileSnapshot[];
  receipt: MigrationReceipt;
}

export interface MigrationReceipt {
  schema: typeof SCHEMA;
  migratedAt: string;
  changed: boolean;
  backupDirectory: string | null;
  bots: {
    finchId: string;
    cogsId: string;
    basilId: string;
    newThreadIds: Record<string, string>;
  };
  changedFiles: string[];
  beforeSha256: Record<string, string | null>;
  afterSha256: Record<string, string | null>;
  basilRoutinesDisabled: number;
  basilRunsCancelled: number;
  basilWebhooksDisabled: number;
}

export interface FullTaskScopedMigrationOptions {
  dataDir: string;
  now?: () => number;
  newId?: () => string;
  /** Focused tests use this to prove every earlier replacement rolls back. */
  beforeWrite?: (name: string, index: number) => void;
}

interface PlannedMigration {
  documents: Map<string, string>;
  changedFiles: string[];
  botIds: { finchId: string; cogsId: string; basilId: string };
  newThreadIds: Record<string, string>;
  basilRoutinesDisabled: number;
  basilRunsCancelled: number;
  basilWebhooksDisabled: number;
}

const resumeCursorSchema = z.record(z.string(), z.json());
const migrationTaskSchema = z.looseObject({
  threadId: z.string().min(1),
  title: z.string().optional(),
  createdAt: z.number().optional(),
  resumeCursors: resumeCursorSchema.optional().default({}),
  lastInstanceId: z.string().optional(),
  cwd: z.string().nullable().optional(),
});
const migrationBotSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  threadId: z.string().min(1),
  description: z.string().optional(),
  createdAt: z.number().optional(),
  resumeCursors: resumeCursorSchema.optional().default({}),
  tasks: z.array(migrationTaskSchema).optional(),
  accessProfile: z.string().optional(),
  autoApprove: z.boolean().optional(),
  computer: z.string().optional(),
  cwd: z.string().optional(),
  busy: z.boolean().optional(),
  activity: z.string().optional(),
  rewound: z.boolean().optional(),
  pinnedMessageId: z.string().optional(),
  hidden: z.boolean().optional(),
  alwaysAllow: z.array(z.string()).optional(),
  chiefOfStaff: z.boolean().optional(),
});
const migrationBotsSchema = z.array(migrationBotSchema);
const migrationRoutineSchema = z.looseObject({
  botId: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.number().nullable().optional(),
  updatedAt: z.number().optional(),
});
const migrationRunSchema = z.looseObject({
  botId: z.string(),
  status: z.string(),
  finishedAt: z.number().optional(),
  error: z.string().optional(),
});
const migrationRoutineFileSchema = z.looseObject({
  routines: z.array(migrationRoutineSchema),
  runs: z.array(migrationRunSchema),
});
const migrationWebhookSchema = z.looseObject({
  botId: z.string(),
  enabled: z.boolean(),
  updatedAt: z.number().optional(),
});
const migrationWebhookFileSchema = z.looseObject({
  webhooks: z.array(migrationWebhookSchema),
});
const fileSnapshotSchema = z.object({
  name: z.string(),
  existed: z.boolean(),
  sha256: z.string().nullable(),
});
const receiptSchema = z.object({
  schema: z.literal(SCHEMA),
  migratedAt: z.string(),
  changed: z.boolean(),
  backupDirectory: z.string().nullable(),
  bots: z.object({
    finchId: z.string(),
    cogsId: z.string(),
    basilId: z.string(),
    newThreadIds: z.record(z.string(), z.string()),
  }),
  changedFiles: z.array(z.string()),
  beforeSha256: z.record(z.string(), z.string().nullable()),
  afterSha256: z.record(z.string(), z.string().nullable()),
  basilRoutinesDisabled: z.number(),
  basilRunsCancelled: z.number(),
  basilWebhooksDisabled: z.number(),
});
const journalSchema = z.object({
  schema: z.literal(JOURNAL_SCHEMA),
  status: z.enum(["prepared", "committed"]),
  backupDirectory: z.string(),
  files: z.array(fileSnapshotSchema),
  receipt: receiptSchema,
});
const errorCodeSchema = z.object({ code: z.string().optional() });

type MigrationTask = z.infer<typeof migrationTaskSchema>;
type MigrationBot = z.infer<typeof migrationBotSchema>;

interface OptionalDocument<T> {
  raw: string | null;
  value: T | null;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function json<T>(value: T): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJsonFile<T>(path: string, label: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertRegularStateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-regular state file: ${path}`);
}

function namedBot(bots: MigrationBot[], name: string): MigrationBot {
  const matches = bots.filter((bot) => bot.name.trim().toLowerCase() === name.toLowerCase());
  if (matches.length !== 1) throw new Error(`Expected exactly one ${name} bot; found ${matches.length}`);
  const bot = matches[0]!;
  return bot;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function uniqueThreadId(used: Set<string>, next: () => string): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = next();
    if (candidate && !used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error("Could not allocate a unique task thread id");
}

function currentTasks(bot: MigrationBot, now: number): MigrationTask[] {
  if (bot.tasks?.length) return bot.tasks;
  return [
    {
      threadId: bot.threadId,
      title: "Previous task",
      createdAt: bot.createdAt ?? now,
      resumeCursors: bot.resumeCursors,
    },
  ];
}

function alreadyFreshFullTask(bot: MigrationBot): boolean {
  if (
    bot.accessProfile !== "full-task-scoped" ||
    bot.autoApprove !== true ||
    bot.computer !== "local" ||
    bot.description !== FULL_TASK_SCOPED_SYSTEM_PROMPT ||
    "cwd" in bot ||
    Object.keys(bot.resumeCursors).length !== 0
  ) {
    return false;
  }
  const active = bot.tasks?.find((task) => task.threadId === bot.threadId);
  return Boolean(
    active &&
      active.title === MIGRATION_TITLE &&
      Object.keys(active.resumeCursors).length === 0 &&
      !("lastInstanceId" in active) &&
      !("cwd" in active),
  );
}

function migrateFullBot(
  bot: MigrationBot,
  usedThreadIds: Set<string>,
  nextId: () => string,
  now: number,
): string | null {
  const wasFresh = alreadyFreshFullTask(bot);
  const tasks = currentTasks(bot, now).map((task) => {
    const copy = { ...task, resumeCursors: {} };
    delete copy.lastInstanceId;
    return copy;
  });

  bot.accessProfile = "full-task-scoped";
  bot.autoApprove = true;
  bot.computer = "local";
  bot.description = FULL_TASK_SCOPED_SYSTEM_PROMPT;
  bot.resumeCursors = {};
  bot.busy = false;
  bot.activity = "idle";
  delete bot.cwd;
  delete bot.rewound;
  delete bot.pinnedMessageId;

  if (wasFresh) {
    bot.tasks = tasks;
    return null;
  }

  const threadId = uniqueThreadId(usedThreadIds, nextId);
  bot.threadId = threadId;
  bot.tasks = [
    {
      threadId,
      title: MIGRATION_TITLE,
      createdAt: now,
      resumeCursors: {},
    },
    ...tasks,
  ];
  return threadId;
}

function quarantineBasil(bot: MigrationBot): void {
  bot.hidden = true;
  bot.autoApprove = false;
  bot.computer = "off";
  bot.alwaysAllow = [];
  bot.chiefOfStaff = false;
  bot.busy = false;
  bot.activity = "idle";
}

function parseOptionalDocument<T>(dataDir: string, name: string, schema: z.ZodType<T>): OptionalDocument<T> {
  const path = join(dataDir, name);
  if (!existsSync(path)) return { raw: null, value: null };
  assertRegularStateFile(path);
  const raw = readFileSync(path, "utf8");
  const value = readJsonFile(path, name, schema);
  return { raw, value };
}

function planMigration(dataDir: string, at: number, nextId: () => string): PlannedMigration {
  const botsPath = join(dataDir, "bots.json");
  if (!existsSync(botsPath)) throw new Error(`No bots.json found in ${dataDir}`);
  assertRegularStateFile(botsPath);
  const botsRaw = readFileSync(botsPath, "utf8");
  const parsedBots = readJsonFile(botsPath, "bots.json", migrationBotsSchema);
  const bots = cloneJson(parsedBots);
  const finch = namedBot(bots, "Finch");
  const cogs = namedBot(bots, "Cogs");
  const basil = namedBot(bots, "Basil");
  const usedThreadIds = new Set<string>();
  for (const bot of bots) {
    usedThreadIds.add(bot.threadId);
    for (const task of bot.tasks ?? []) usedThreadIds.add(task.threadId);
  }
  const newThreadIds: Record<string, string> = {};
  const finchThread = migrateFullBot(finch, usedThreadIds, nextId, at);
  const cogsThread = migrateFullBot(cogs, usedThreadIds, nextId, at);
  if (finchThread) newThreadIds[String(finch.id)] = finchThread;
  if (cogsThread) newThreadIds[String(cogs.id)] = cogsThread;
  quarantineBasil(basil);

  // Parse once more after adding migration-owned keys so their serialized
  // order is canonical on the first run as well as every subsequent run.
  const documents = new Map<string, string>([["bots.json", json(migrationBotsSchema.parse(bots))]]);
  let basilRoutinesDisabled = 0;
  let basilRunsCancelled = 0;
  const routinesDocument = parseOptionalDocument(dataDir, "routines.json", migrationRoutineFileSchema);
  if (routinesDocument.value) {
    const root = cloneJson(routinesDocument.value);
    for (const routine of root.routines) {
      if (routine.botId !== basil.id || routine.enabled !== true) continue;
      routine.enabled = false;
      routine.nextRunAt = null;
      routine.updatedAt = at;
      basilRoutinesDisabled += 1;
    }
    for (const run of root.runs) {
      if (run.botId !== basil.id || !["queued", "running", "waiting"].includes(String(run.status))) continue;
      run.status = "cancelled";
      run.finishedAt = at;
      run.error = "Basil was quarantined during the full-task-scoped runtime migration";
      basilRunsCancelled += 1;
    }
    documents.set("routines.json", json(migrationRoutineFileSchema.parse(root)));
  }

  let basilWebhooksDisabled = 0;
  const webhooksDocument = parseOptionalDocument(dataDir, "webhooks.json", migrationWebhookFileSchema);
  if (webhooksDocument.value) {
    const root = cloneJson(webhooksDocument.value);
    for (const webhook of root.webhooks) {
      if (webhook.botId !== basil.id || webhook.enabled !== true) continue;
      webhook.enabled = false;
      webhook.updatedAt = at;
      basilWebhooksDisabled += 1;
    }
    documents.set("webhooks.json", json(migrationWebhookFileSchema.parse(root)));
  }

  const original = new Map<string, string | null>([
    ["bots.json", botsRaw],
    ["routines.json", routinesDocument.raw],
    ["webhooks.json", webhooksDocument.raw],
  ]);
  const changedFiles = [...documents].filter(([name, value]) => original.get(name) !== value).map(([name]) => name);
  return {
    documents,
    changedFiles,
    botIds: { finchId: String(finch.id), cogsId: String(cogs.id), basilId: String(basil.id) },
    newThreadIds,
    basilRoutinesDisabled,
    basilRunsCancelled,
    basilWebhooksDisabled,
  };
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const parsed = errorCodeSchema.safeParse(error);
    return !parsed.success || parsed.data.code !== "ESRCH";
  }
}

function acquireLock(dataDir: string): () => void {
  const path = join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {}
      };
    } catch (error) {
      const parsed = errorCodeSchema.safeParse(error);
      if (!parsed.success || parsed.data.code !== "EEXIST") throw error;
      const owner = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
      if (processIsAlive(owner)) throw new Error(`Another migration process owns ${path} (pid ${owner})`);
      unlinkSync(path);
    }
  }
  throw new Error(`Could not acquire migration lock ${path}`);
}

function snapshotFiles(dataDir: string, backupDir: string): FileSnapshot[] {
  const names = [...STATE_FILES, RECEIPT_FILE];
  return names.map((name) => {
    const path = join(dataDir, name);
    if (!existsSync(path)) return { name, existed: false, sha256: null };
    assertRegularStateFile(path);
    const contents = readFileSync(path);
    writeFileSync(join(backupDir, name), contents, { mode: 0o600 });
    return { name, existed: true, sha256: sha256(contents) };
  });
}

function restoreSnapshots(dataDir: string, backupDir: string, files: FileSnapshot[]): void {
  for (const file of files) {
    if (!/^[a-z0-9_.-]+$/i.test(file.name)) throw new Error(`Unsafe transaction filename: ${file.name}`);
    const target = join(dataDir, file.name);
    if (!file.existed) {
      try {
        unlinkSync(target);
      } catch (error) {
        const parsed = errorCodeSchema.safeParse(error);
        if (!parsed.success || parsed.data.code !== "ENOENT") throw error;
      }
      continue;
    }
    const source = join(backupDir, file.name);
    const contents = readFileSync(source);
    if (sha256(contents) !== file.sha256) throw new Error(`Backup checksum mismatch for ${file.name}`);
    writeFileAtomic(target, contents.toString("utf8"), { mode: 0o600 });
  }
}

function readJournal(dataDir: string): MigrationJournal | null {
  const path = join(dataDir, JOURNAL_FILE);
  if (!existsSync(path)) return null;
  assertRegularStateFile(path);
  const value = readJsonFile(path, JOURNAL_FILE, journalSchema);
  if (basename(value.backupDirectory) !== value.backupDirectory) {
    throw new Error(`Unsafe migration backup directory in ${path}`);
  }
  return value;
}

/** Recover a process-interrupted prepared transaction before planning another migration. */
export function recoverFullTaskScopedMigration(dataDirInput: string): "none" | "rolled-back" | "committed" {
  const dataDir = resolve(dataDirInput);
  const journal = readJournal(dataDir);
  if (!journal) return "none";
  const backupDir = join(dataDir, "backups", journal.backupDirectory);
  if (!existsSync(backupDir) || !lstatSync(backupDir).isDirectory()) {
    throw new Error(`Migration backup is unavailable: ${backupDir}`);
  }
  if (journal.status === "prepared") {
    restoreSnapshots(dataDir, backupDir, journal.files);
    unlinkSync(join(dataDir, JOURNAL_FILE));
    return "rolled-back";
  }
  writeFileAtomic(join(dataDir, RECEIPT_FILE), json(journal.receipt), { mode: 0o600 });
  unlinkSync(join(dataDir, JOURNAL_FILE));
  return "committed";
}

export function migrateFullTaskScopedData(options: FullTaskScopedMigrationOptions): MigrationReceipt {
  const dataDir = resolve(options.dataDir);
  if (!existsSync(dataDir) || !lstatSync(dataDir).isDirectory() || lstatSync(dataDir).isSymbolicLink()) {
    throw new Error(`Data directory must be a real directory: ${dataDir}`);
  }
  const releaseLock = acquireLock(dataDir);
  try {
    recoverFullTaskScopedMigration(dataDir);
    const at = (options.now ?? Date.now)();
    const planned = planMigration(dataDir, at, options.newId ?? randomUUID);
    const beforeSha256 = Object.fromEntries(
      STATE_FILES.map((name) => {
        const path = join(dataDir, name);
        return [name, existsSync(path) ? sha256(readFileSync(path)) : null];
      }),
    );
    if (planned.changedFiles.length === 0) {
      return {
        schema: SCHEMA,
        migratedAt: new Date(at).toISOString(),
        changed: false,
        backupDirectory: null,
        bots: { ...planned.botIds, newThreadIds: planned.newThreadIds },
        changedFiles: [],
        beforeSha256,
        afterSha256: { ...beforeSha256 },
        basilRoutinesDisabled: 0,
        basilRunsCancelled: 0,
        basilWebhooksDisabled: 0,
      };
    }

    const backupName = `full-task-scoped-${new Date(at).toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const backupsDir = join(dataDir, "backups");
    mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
    const backupDir = join(backupsDir, backupName);
    mkdirSync(backupDir, { recursive: false, mode: 0o700 });
    const files = snapshotFiles(dataDir, backupDir);
    const basil = readJsonFile(join(dataDir, "bots.json"), "bots.json", migrationBotsSchema).find(
      (bot) => bot.id === planned.botIds.basilId,
    );
    writeFileAtomic(join(backupDir, "basil-record.json"), json(basil), { mode: 0o600 });
    writeFileAtomic(join(backupDir, "manifest.json"), json({ schema: SCHEMA, createdAt: new Date(at).toISOString(), files }), {
      mode: 0o600,
    });

    const afterSha256 = Object.fromEntries(
      STATE_FILES.map((name) => [name, planned.documents.has(name) ? sha256(planned.documents.get(name)!) : beforeSha256[name]]),
    );
    const receipt: MigrationReceipt = {
      schema: SCHEMA,
      migratedAt: new Date(at).toISOString(),
      changed: true,
      backupDirectory: backupName,
      bots: { ...planned.botIds, newThreadIds: planned.newThreadIds },
      changedFiles: planned.changedFiles,
      beforeSha256,
      afterSha256,
      basilRoutinesDisabled: planned.basilRoutinesDisabled,
      basilRunsCancelled: planned.basilRunsCancelled,
      basilWebhooksDisabled: planned.basilWebhooksDisabled,
    };
    const journal: MigrationJournal = {
      schema: JOURNAL_SCHEMA,
      status: "prepared",
      backupDirectory: backupName,
      files,
      receipt,
    };
    writeFileAtomic(join(dataDir, JOURNAL_FILE), json(journal), { mode: 0o600 });
    try {
      planned.changedFiles.forEach((name, index) => {
        options.beforeWrite?.(name, index);
        writeFileAtomic(join(dataDir, name), planned.documents.get(name)!, { mode: 0o600 });
      });
      journal.status = "committed";
      writeFileAtomic(join(dataDir, JOURNAL_FILE), json(journal), { mode: 0o600 });
      writeFileAtomic(join(dataDir, RECEIPT_FILE), json(receipt), { mode: 0o600 });
      unlinkSync(join(dataDir, JOURNAL_FILE));
      return receipt;
    } catch (error) {
      restoreSnapshots(dataDir, backupDir, files);
      try {
        unlinkSync(join(dataDir, JOURNAL_FILE));
      } catch {}
      throw error;
    }
  } finally {
    releaseLock();
  }
}

export const FULL_TASK_SCOPED_MIGRATION_TITLE = MIGRATION_TITLE;
