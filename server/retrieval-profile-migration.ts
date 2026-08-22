import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

import { retrievalProfileSchema, type RetrievalProfile } from "../shared/retrieval-profile.ts";
import { writeFileAtomic } from "./atomic.ts";
import { parseJson, schemaIssue } from "./schema.ts";

const storedBotSchema = z.object({
  id: z.string(),
  modelSelection: z.object({ instanceId: z.string() }).loose().optional(),
  retrievalProfile: retrievalProfileSchema.optional(),
}).loose();
const storedBotsSchema = z.array(storedBotSchema);
type StoredBot = z.output<typeof storedBotSchema>;

const sourceVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const sourceShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const canaryReceiptSchema = z.discriminatedUnion("phase", [
  z.object({
    schema: z.literal("openmaus.retrieval-profile-canary-receipt.v1"),
    phase: z.literal(1),
    profile: z.literal("task-scoped"),
    source_version: sourceVersionSchema,
    source_sha: sourceShaSchema,
    restart_passed: z.literal(true),
    bots_digest: digestSchema,
    canary_bot_ids: z.object({ qwen: z.string() }).strict(),
  }).strict(),
  z.object({
    schema: z.literal("openmaus.retrieval-profile-canary-receipt.v1"),
    phase: z.literal(2),
    profile: z.literal("task-scoped"),
    source_version: sourceVersionSchema,
    source_sha: sourceShaSchema,
    restart_passed: z.literal(true),
    bots_digest: digestSchema,
    canary_bot_ids: z.object({
      qwen: z.string(),
      claude: z.string(),
      codex: z.string(),
    }).strict(),
  }).strict(),
]);
type CanaryReceipt = z.output<typeof canaryReceiptSchema>;

export type RetrievalCanaryPhase = 1 | 2 | 3;

export interface RetrievalCanaryPrerequisite {
  receipt_path: string;
  receipt_digest: string;
  phase: 1 | 2;
  restart_passed: true;
  bots_digest: string;
  canary_bot_ids: { qwen: string; claude?: string; codex?: string };
}

export interface RetrievalProfileMigrationPreview {
  schema: "openmaus.retrieval-profile-migration-preview.v1";
  data_dir: string;
  bots_path: string;
  bot_ids: string[];
  profile: RetrievalProfile;
  canary_phase: RetrievalCanaryPhase | null;
  source_version: string | null;
  source_sha: string | null;
  prerequisite_canary_receipt: RetrievalCanaryPrerequisite | null;
  before_digest: string;
  after_digest: string;
  changed_bot_ids: string[];
  unchanged_bot_ids: string[];
}

export interface RetrievalProfileMigrationReceipt extends Omit<RetrievalProfileMigrationPreview, "schema"> {
  schema: "openmaus.retrieval-profile-migration-receipt.v1";
  applied: boolean;
  backup_path: string | null;
  receipt_path: string | null;
}

export interface RetrievalProfileRollbackReceipt {
  schema: "openmaus.retrieval-profile-rollback-receipt.v1";
  source_receipt_path: string;
  bots_path: string;
  backup_path: string;
  before_digest: string;
  after_digest: string;
  restored_digest: string;
  rollback_receipt_path: string;
  rolled_back_at: string;
}

const canaryPrerequisiteSchema = z.object({
  receipt_path: z.string(),
  receipt_digest: digestSchema,
  phase: z.union([z.literal(1), z.literal(2)]),
  restart_passed: z.literal(true),
  bots_digest: digestSchema,
  canary_bot_ids: z.object({
    qwen: z.string(),
    claude: z.string().optional(),
    codex: z.string().optional(),
  }).strict(),
}).strict();
const appliedReceiptSchema = z.object({
  schema: z.literal("openmaus.retrieval-profile-migration-receipt.v1"),
  data_dir: z.string(),
  bots_path: z.string(),
  bot_ids: z.array(z.string()),
  profile: retrievalProfileSchema,
  canary_phase: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable().optional(),
  source_version: sourceVersionSchema.nullable().optional(),
  source_sha: sourceShaSchema.nullable().optional(),
  prerequisite_canary_receipt: canaryPrerequisiteSchema.nullable().optional(),
  before_digest: digestSchema,
  after_digest: digestSchema,
  changed_bot_ids: z.array(z.string()),
  unchanged_bot_ids: z.array(z.string()),
  applied: z.literal(true),
  backup_path: z.string(),
  receipt_path: z.string(),
});

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function parsedBots(raw: string): StoredBot[] {
  let parsed;
  try {
    parsed = storedBotsSchema.safeParse(parseJson(raw));
  } catch {
    throw new Error("bots.json is not valid JSON");
  }
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "bots.json must contain bot records"));
  return parsed.data;
}

function exactBotIds(botIds: string[]): string[] {
  const unique = [...new Set(botIds)];
  if (!unique.length || unique.some((id) => !/^[\w-]+$/.test(id))) {
    throw new Error("at least one exact bot id is required");
  }
  if (unique.length !== botIds.length) throw new Error("each exact bot id may be supplied only once");
  return unique;
}

function canonicalExistingPath(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  try {
    return realpathSync(resolve(path));
  } catch {
    throw new Error(`${label} does not exist`);
  }
}

function sameIds(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function instanceId(bot: StoredBot, label: string): string {
  const id = bot.modelSelection?.instanceId;
  if (!id) throw new Error(`${label} has no persisted modelSelection.instanceId`);
  return id;
}

function validateReceiptBotIds(receipt: CanaryReceipt): void {
  const ids = Object.values(receipt.canary_bot_ids);
  if (ids.some((id) => !/^[\w-]+$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error("canary receipt must contain unique exact bot ids");
  }
}

function readCanaryPrerequisite(input: {
  receiptPath: string;
  expectedPhase: 1 | 2;
  sourceVersion: string;
  sourceSha: string;
}) {
  const receiptPath = canonicalExistingPath(input.receiptPath, "canary receipt");
  const raw = readFileSync(receiptPath, "utf8");
  let parsed;
  try {
    parsed = canaryReceiptSchema.safeParse(parseJson(raw));
  } catch {
    throw new Error("canary receipt is not valid JSON");
  }
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "canary receipt is invalid"));
  const receipt = parsed.data;
  validateReceiptBotIds(receipt);
  if (receipt.phase !== input.expectedPhase) {
    throw new Error(`phase ${input.expectedPhase + 1} requires a phase ${input.expectedPhase} canary receipt`);
  }
  if (receipt.source_version !== input.sourceVersion || receipt.source_sha !== input.sourceSha) {
    throw new Error("canary receipt source version/SHA does not match this migration candidate");
  }
  const binding: RetrievalCanaryPrerequisite = {
    receipt_path: receiptPath,
    receipt_digest: digest(raw),
    phase: receipt.phase,
    restart_passed: true,
    bots_digest: receipt.bots_digest,
    canary_bot_ids: receipt.canary_bot_ids,
  };
  return {
    receipt,
    binding,
  };
}

interface MigrationCandidateInput {
  dataDir: string;
  botIds: string[];
  profile: RetrievalProfile;
  canaryPhase?: RetrievalCanaryPhase;
  sourceVersion?: string;
  sourceSha?: string;
  canaryReceiptPath?: string;
}

function activationContract(input: MigrationCandidateInput, bots: StoredBot[], ids: string[], before: string) {
  const activationFields = [input.canaryPhase, input.sourceVersion, input.sourceSha, input.canaryReceiptPath];
  if (input.profile === "off") {
    if (activationFields.some((value) => value !== undefined)) {
      throw new Error("canary phase, source identity, and canary receipts apply only to task-scoped activation");
    }
    return {
      canaryPhase: null,
      sourceVersion: null,
      sourceSha: null,
      prerequisite: null,
    };
  }

  const phase = input.canaryPhase;
  const sourceVersion = sourceVersionSchema.safeParse(input.sourceVersion);
  const sourceSha = sourceShaSchema.safeParse(input.sourceSha);
  if (!phase || !sourceVersion.success || !sourceSha.success) {
    throw new Error("task-scoped activation requires --phase, semantic source version, and full source SHA");
  }
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const scopedIds = bots.filter((bot) => bot.retrievalProfile === "task-scoped").map((bot) => bot.id);
  const engines = ids.map((id) => instanceId(byId.get(id)!, `bot ${id}`));

  if (phase === 1) {
    if (input.canaryReceiptPath) throw new Error("phase 1 does not accept a prerequisite canary receipt");
    if (ids.length !== 1 || engines[0] !== "qwen") {
      throw new Error("phase 1 requires only the exact Ada/Qwen bot id");
    }
    if (!sameIds(scopedIds, []) && !sameIds(scopedIds, ids)) {
      throw new Error("phase 1 requires every non-Ada/Qwen bot retrieval profile to be off");
    }
    return { canaryPhase: phase, sourceVersion: sourceVersion.data, sourceSha: sourceSha.data, prerequisite: null };
  }

  if (!input.canaryReceiptPath) {
    throw new Error(`phase ${phase} requires the prior phase restart-canary receipt`);
  }
  const prerequisite = readCanaryPrerequisite({
    receiptPath: input.canaryReceiptPath,
    expectedPhase: phase === 2 ? 1 : 2,
    sourceVersion: sourceVersion.data,
    sourceSha: sourceSha.data,
  });
  const canaries = prerequisite.receipt.canary_bot_ids;
  const qwen = byId.get(canaries.qwen);
  if (!qwen || instanceId(qwen, `canary bot ${canaries.qwen}`) !== "qwen" || qwen.retrievalProfile !== "task-scoped") {
    throw new Error("the phase 1 Qwen canary is not task-scoped in current bot readback");
  }

  if (phase === 2) {
    if (ids.length !== 2 || !sameIds(engines, ["claude", "codex"])) {
      throw new Error("phase 2 requires exactly one Claude bot id and one Codex bot id");
    }
    const preCanaryIds = [canaries.qwen];
    const postCanaryIds = [...preCanaryIds, ...ids];
    if (!sameIds(scopedIds, preCanaryIds) && !sameIds(scopedIds, postCanaryIds)) {
      throw new Error("phase 2 bot readback contains task-scoped bots outside the approved canary cohort");
    }
    if (sameIds(scopedIds, preCanaryIds) && prerequisite.receipt.bots_digest !== digest(before)) {
      throw new Error("phase 1 restart-canary bots digest does not match current bot readback");
    }
  } else {
    if (prerequisite.receipt.phase !== 2) throw new Error("phase 3 requires a phase 2 canary receipt");
    const phase2Canaries = prerequisite.receipt.canary_bot_ids;
    const validatePhaseTwoCanary = (engine: "qwen" | "claude" | "codex", botId: string) => {
      const bot = byId.get(botId);
      if (!bot || instanceId(bot, `canary bot ${botId}`) !== engine
        || bot.retrievalProfile !== "task-scoped") {
        throw new Error(`the phase 2 ${engine} canary is not task-scoped in current bot readback`);
      }
    };
    validatePhaseTwoCanary("qwen", phase2Canaries.qwen);
    validatePhaseTwoCanary("claude", phase2Canaries.claude);
    validatePhaseTwoCanary("codex", phase2Canaries.codex);
    const canaryIds = Object.values(phase2Canaries);
    const remainingIds = bots.map((bot) => bot.id).filter((id) => !canaryIds.includes(id));
    if (!sameIds(ids, remainingIds)) {
      throw new Error("phase 3 must target every remaining non-canary bot id exactly once");
    }
    const postCanaryIds = bots.map((bot) => bot.id);
    if (!sameIds(scopedIds, canaryIds) && !sameIds(scopedIds, postCanaryIds)) {
      throw new Error("phase 3 bot readback is neither the approved canary state nor the idempotent final state");
    }
    if (sameIds(scopedIds, canaryIds) && prerequisite.receipt.bots_digest !== digest(before)) {
      throw new Error("phase 2 restart-canary bots digest does not match current bot readback");
    }
  }

  return {
    canaryPhase: phase,
    sourceVersion: sourceVersion.data,
    sourceSha: sourceSha.data,
    prerequisite: prerequisite.binding,
  };
}

function candidate(previewInput: MigrationCandidateInput) {
  const ids = exactBotIds(previewInput.botIds);
  const botsPath = join(previewInput.dataDir, "bots.json");
  const before = readFileSync(botsPath, "utf8");
  const bots = parsedBots(before);
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`unknown bot id(s): ${missing.join(", ")}`);
  const activation = activationContract(previewInput, bots, ids, before);

  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const id of ids) {
    const bot = byId.get(id)!;
    if (bot.retrievalProfile === previewInput.profile) unchanged.push(id);
    else {
      bot.retrievalProfile = previewInput.profile;
      changed.push(id);
    }
  }
  const after = changed.length ? JSON.stringify(bots, null, 2) : before;
  return { botsPath, ids, before, after, changed, unchanged, activation };
}

export function previewRetrievalProfileMigration(input: MigrationCandidateInput): RetrievalProfileMigrationPreview {
  const result = candidate(input);
  return {
    schema: "openmaus.retrieval-profile-migration-preview.v1",
    data_dir: input.dataDir,
    bots_path: result.botsPath,
    bot_ids: result.ids,
    profile: input.profile,
    canary_phase: result.activation.canaryPhase,
    source_version: result.activation.sourceVersion,
    source_sha: result.activation.sourceSha,
    prerequisite_canary_receipt: result.activation.prerequisite,
    before_digest: digest(result.before),
    after_digest: digest(result.after),
    changed_bot_ids: result.changed,
    unchanged_bot_ids: result.unchanged,
  };
}

export function applyRetrievalProfileMigration(input: {
  dataDir: string;
  botIds: string[];
  profile: RetrievalProfile;
  expectedDigest: string;
  canaryPhase?: RetrievalCanaryPhase;
  sourceVersion?: string;
  sourceSha?: string;
  canaryReceiptPath?: string;
  expectedCanaryDigest?: string;
  now?: Date;
}): RetrievalProfileMigrationReceipt {
  const result = candidate(input);
  const beforeDigest = digest(result.before);
  const afterDigest = digest(result.after);
  if (input.expectedDigest !== beforeDigest) {
    throw new Error(`bots.json changed after preview: expected ${input.expectedDigest}, found ${beforeDigest}`);
  }
  const prerequisiteDigest = result.activation.prerequisite?.receipt_digest;
  if (prerequisiteDigest && input.expectedCanaryDigest !== prerequisiteDigest) {
    throw new Error("canary receipt changed after preview or its exact digest was not supplied");
  }
  if (!prerequisiteDigest && input.expectedCanaryDigest !== undefined) {
    throw new Error("this migration phase does not accept an expected canary digest");
  }
  const base = {
    data_dir: input.dataDir,
    bots_path: result.botsPath,
    bot_ids: result.ids,
    profile: input.profile,
    canary_phase: result.activation.canaryPhase,
    source_version: result.activation.sourceVersion,
    source_sha: result.activation.sourceSha,
    prerequisite_canary_receipt: result.activation.prerequisite,
    before_digest: beforeDigest,
    after_digest: afterDigest,
    changed_bot_ids: result.changed,
    unchanged_bot_ids: result.unchanged,
  };
  if (!result.changed.length) {
    return {
      schema: "openmaus.retrieval-profile-migration-receipt.v1",
      ...base,
      applied: false,
      backup_path: null,
      receipt_path: null,
    };
  }

  const stamp = (input.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const directory = join(input.dataDir, "migrations", "retrieval-profile", `${stamp}-${beforeDigest.slice(-12)}`);
  const backupPath = join(directory, "bots.json.original");
  const receiptPath = join(directory, "receipt.json");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(backupPath)) {
    const existingBackup = readFileSync(backupPath, "utf8");
    if (digest(existingBackup) !== beforeDigest) throw new Error("migration backup path already contains different state");
  } else {
    writeFileAtomic(backupPath, result.before, { mode: 0o600 });
  }

  // Compare again after the backup write: no edit may slip between preview
  // and the atomic replacement.
  const atApply = readFileSync(result.botsPath, "utf8");
  if (digest(atApply) !== beforeDigest) {
    throw new Error("bots.json changed while the migration backup was being created");
  }
  if (result.activation.prerequisite) {
    const currentCanaryDigest = digest(readFileSync(result.activation.prerequisite.receipt_path, "utf8"));
    if (currentCanaryDigest !== result.activation.prerequisite.receipt_digest) {
      throw new Error("canary receipt changed while the migration backup was being created");
    }
  }

  const receipt: RetrievalProfileMigrationReceipt = {
    schema: "openmaus.retrieval-profile-migration-receipt.v1",
    ...base,
    applied: true,
    backup_path: backupPath,
    receipt_path: receiptPath,
  };
  try {
    writeFileAtomic(result.botsPath, result.after, { mode: 0o600 });
    const readback = readFileSync(result.botsPath, "utf8");
    if (digest(readback) !== afterDigest) throw new Error("migration readback digest did not match the candidate");
    writeFileAtomic(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    return receipt;
  } catch (error) {
    try {
      if (digest(readFileSync(result.botsPath, "utf8")) === afterDigest) {
        writeFileAtomic(result.botsPath, result.before, { mode: 0o600 });
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "retrieval-profile migration and rollback both failed");
    }
    throw error;
  }
}

export function rollbackRetrievalProfileMigration(input: {
  receiptPath: string;
  now?: Date;
}): RetrievalProfileRollbackReceipt {
  const sourceReceiptPath = canonicalExistingPath(input.receiptPath, "migration receipt");
  let parsed;
  try {
    parsed = appliedReceiptSchema.safeParse(parseJson(readFileSync(sourceReceiptPath, "utf8")));
  } catch {
    throw new Error("migration receipt is not valid JSON");
  }
  if (!parsed.success) throw new Error(schemaIssue(parsed.error, "migration receipt is invalid"));
  const source = parsed.data;
  const receiptDirectory = dirname(sourceReceiptPath);
  const dataDir = canonicalExistingPath(source.data_dir, "migration data directory");
  const migrationRoot = canonicalExistingPath(
    join(dataDir, "migrations", "retrieval-profile"),
    "retrieval migration root",
  );
  const botsPath = canonicalExistingPath(source.bots_path, "migration bots path");
  const backupPath = canonicalExistingPath(source.backup_path, "migration backup");
  if (canonicalExistingPath(source.receipt_path, "recorded migration receipt") !== sourceReceiptPath) {
    throw new Error("migration receipt path does not match the canonical source receipt");
  }
  if (botsPath !== canonicalExistingPath(join(dataDir, "bots.json"), "data-directory bots path")) {
    throw new Error("migration receipt points outside its data-directory bots.json");
  }
  if (dirname(receiptDirectory) !== migrationRoot || basename(sourceReceiptPath) !== "receipt.json") {
    throw new Error("migration receipt is outside its data-directory migration root");
  }
  if (backupPath !== canonicalExistingPath(join(receiptDirectory, "bots.json.original"), "receipt-bound backup")) {
    throw new Error("migration backup is not bound to the receipt directory");
  }

  const current = readFileSync(botsPath, "utf8");
  const currentDigest = digest(current);
  if (currentDigest !== source.after_digest) {
    throw new Error(`bots.json drifted after migration: expected ${source.after_digest}, found ${currentDigest}`);
  }
  const original = readFileSync(backupPath, "utf8");
  const originalDigest = digest(original);
  if (originalDigest !== source.before_digest) {
    throw new Error(`migration backup digest mismatch: expected ${source.before_digest}, found ${originalDigest}`);
  }

  writeFileAtomic(botsPath, original, { mode: 0o600 });
  const restoredDigest = digest(readFileSync(botsPath, "utf8"));
  if (restoredDigest !== source.before_digest) {
    throw new Error("retrieval-profile rollback readback did not match the original digest");
  }
  const rollbackReceiptPath = join(receiptDirectory, "rollback-receipt.json");
  const rollback: RetrievalProfileRollbackReceipt = {
    schema: "openmaus.retrieval-profile-rollback-receipt.v1",
    source_receipt_path: sourceReceiptPath,
    bots_path: botsPath,
    backup_path: backupPath,
    before_digest: source.before_digest,
    after_digest: source.after_digest,
    restored_digest: restoredDigest,
    rollback_receipt_path: rollbackReceiptPath,
    rolled_back_at: (input.now ?? new Date()).toISOString(),
  };
  writeFileAtomic(rollbackReceiptPath, JSON.stringify(rollback, null, 2), { mode: 0o600 });
  return rollback;
}
