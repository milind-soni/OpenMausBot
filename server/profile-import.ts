/* oxlint-disable anti-slop/no-runtime-typeof -- profile JSON is an untrusted migration boundary. */
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

import {
  AccountDirectory,
  InMemoryAccountDirectoryStore,
  JsonFileAccountDirectoryStore,
  type ExplicitAccountBinding,
} from "./account-directory.ts";
import { ActionPolicy } from "./action-policy.ts";
import { writeFileAtomic } from "./atomic.ts";
import { AutonomyTelemetry } from "./autonomy-telemetry.ts";
import { parseJson, type JsonValue } from "./schema.ts";
import {
  createWorkOrchestrator,
  profileEventHash,
  type ProfileWorkEvent,
  type WorkActionExecutor,
  type WorkActionVerifier,
} from "./work-orchestrator.ts";
import { WorkLockStore } from "./work-lock-store.ts";

const exactText = (max: number) => z.string().min(1).max(max).refine((value) => value === value.trim(), {
  message: "must not have surrounding whitespace",
});
const opaqueId = exactText(300).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const profileId = exactText(64).regex(/^[a-z0-9][a-z0-9._:-]*$/);
const workIdentity = exactText(500).regex(/^[a-z0-9][a-z0-9._:/-]*$/);
const accountSchema = z.object({
  identity: exactText(100),
  provider: exactText(64).regex(/^[a-z][a-z0-9._-]{1,63}$/),
  accountId: exactText(203).regex(/^ca_[A-Za-z0-9_-]{2,200}$/),
  source: z.literal("local"),
  sourceId: exactText(200).regex(/^\S+$/),
  observedAt: z.string().datetime(),
  evidenceRef: exactText(500),
}).strict();
const evidenceSchema = z.object({
  reference: exactText(2_000),
  summary: exactText(4_000),
  observedAt: z.number().finite().nonnegative(),
}).strict();
const deadlineSchema = z.object({
  key: exactText(300),
  label: exactText(500),
  dueAt: z.number().finite().nonnegative(),
}).strict();
const approvalSchema = z.object({
  key: exactText(300),
  prompt: exactText(4_000),
  requestedBy: opaqueId.optional(),
}).strict();
const liveLockSchema = z.object({
  externalId: workIdentity,
  title: exactText(1_000),
  description: z.string().max(20_000).optional(),
  ownerId: opaqueId,
  ownerLabel: exactText(500).optional(),
  evidence: evidenceSchema,
  deadline: deadlineSchema.optional(),
  approval: approvalSchema.optional(),
  guards: z.array(exactText(120)).max(30).refine((guards) => new Set(guards).size === guards.length, {
    message: "guards must be unique",
  }),
}).strict();
const legacyProfileSchema = z.object({
  format: z.literal("openmaus.legacy-profile"),
  version: z.literal(1),
  profile: z.object({
    id: profileId,
    ownerId: opaqueId,
    exportedAt: z.string().datetime(),
    accounts: z.array(accountSchema).max(500),
    liveLocks: z.array(liveLockSchema).max(1_000),
  }).strict(),
}).strict();

const postconditionsSchema = z.object({
  accounts: z.number().int().nonnegative(),
  work: z.number().int().nonnegative(),
  pendingApprovals: z.number().int().nonnegative(),
  deadlines: z.number().int().nonnegative(),
  actionRules: z.number().int().nonnegative(),
  actionRuleCandidates: z.number().int().nonnegative(),
}).strict();
const receiptSchema = z.object({
  format: z.literal("openmaus.profile-import-receipt"),
  version: z.literal(1),
  profileId,
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  completedAt: z.string().datetime(),
  workIds: z.array(z.string().min(1)),
  postconditions: postconditionsSchema,
}).strict();

type LegacyProfile = z.infer<typeof legacyProfileSchema>;
type Postconditions = z.infer<typeof postconditionsSchema>;

interface ProfileWorkEventDraft {
  type: "profile-import";
  source: string;
  profileId: string;
  externalId: string;
  title: string;
  ownerId: string;
  evidence: z.infer<typeof evidenceSchema>;
  guards: string[];
  description?: string;
  ownerLabel?: string;
  deadline?: z.infer<typeof deadlineSchema>;
  approval?: z.infer<typeof approvalSchema>;
}

interface ProfileImportHashMaterial {
  format: "openmaus.legacy-profile";
  version: 1;
  profileId: string;
  ownerId: string;
  exportedAt: string;
  accounts: ExplicitAccountBinding[];
  events: ProfileWorkEvent[];
}

type CanonicalInput = JsonValue | ProfileImportHashMaterial | Postconditions | ExplicitAccountBinding | ProfileWorkEvent;

export interface ProfileImportPlan {
  readonly profileId: string;
  readonly ownerId: string;
  readonly exportedAt: string;
  readonly planHash: string;
  readonly accounts: readonly ExplicitAccountBinding[];
  readonly events: readonly ProfileWorkEvent[];
}

export interface ProfileImportCommandResult {
  readonly status: "dry-run" | "applied" | "unchanged";
  readonly planHash: string;
  readonly profileId: string;
  readonly accounts: number;
  readonly liveLocks: number;
  readonly accountIdentities: readonly string[];
  readonly workExternalIds: readonly string[];
  readonly postconditions?: Postconditions;
}

const forbiddenEvidence = /(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)=/i;

function stableJsonValue(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJsonValue).join(",")}]`;
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Profile contains a non-finite number");
    return JSON.stringify(value);
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonValue(entry)}`).join(",")}}`;
}

function stableJson(value: CanonicalInput | readonly CanonicalInput[]): string {
  const parsed = z.json().safeParse(value);
  if (!parsed.success) throw new Error("Profile canonicalization received a non-JSON value");
  return stableJsonValue(parsed.data);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseProfile(text: string): LegacyProfile {
  let value: unknown;
  try {
    value = parseJson(text);
  } catch {
    throw new Error("invalid legacy profile: source is not valid JSON");
  }
  const parsed = legacyProfileSchema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid legacy profile: ${z.prettifyError(parsed.error)}`);
  for (const account of parsed.data.profile.accounts) {
    if (forbiddenEvidence.test(account.evidenceRef)) {
      throw new Error("invalid legacy profile: credential-bearing evidence is forbidden");
    }
  }
  return parsed.data;
}

function assertUnambiguousAccounts(profile: LegacyProfile["profile"]): void {
  const directory = new AccountDirectory({
    ownerId: profile.ownerId,
    store: new InMemoryAccountDirectoryStore(),
  });
  const observations = new Set<string>();
  for (const account of profile.accounts) {
    const observation = stableJson(account);
    if (observations.has(observation)) throw new Error(`invalid legacy profile: duplicate account observation for ${account.identity}`);
    observations.add(observation);
    const registered = directory.register({ ownerId: profile.ownerId, ...account });
    if (registered.status !== "accepted") throw new Error(`invalid legacy profile: duplicate account observation for ${account.identity}`);
  }
  for (const account of profile.accounts) {
    const resolution = directory.resolve({ ownerId: profile.ownerId, identity: account.identity, provider: account.provider });
    if (resolution.status === "ambiguous") {
      throw new Error(`invalid legacy profile: ambiguous account identity ${account.identity} for ${account.provider}`);
    }
    if (resolution.status !== "resolved" || resolution.accountId !== account.accountId) {
      throw new Error(`invalid legacy profile: conflicting account identity ${account.identity} for ${account.provider}`);
    }
  }
}

function eventFromLock(profile: LegacyProfile["profile"], lock: LegacyProfile["profile"]["liveLocks"][number]): ProfileWorkEvent {
  const base: ProfileWorkEventDraft = {
    type: "profile-import" as const,
    source: "legacy-profile",
    profileId: profile.id,
    externalId: lock.externalId,
    title: lock.title,
    ownerId: lock.ownerId,
    evidence: lock.evidence,
    guards: [...lock.guards].sort(),
  };
  if (lock.description !== undefined) base.description = lock.description;
  if (lock.ownerLabel !== undefined) base.ownerLabel = lock.ownerLabel;
  if (lock.deadline !== undefined) base.deadline = lock.deadline;
  if (lock.approval !== undefined) base.approval = lock.approval;
  return { ...base, contentHash: profileEventHash(base) };
}

export function createProfileImportPlan(text: string): ProfileImportPlan {
  const document = parseProfile(text);
  assertUnambiguousAccounts(document.profile);
  const externalIds = new Set<string>();
  for (const lock of document.profile.liveLocks) {
    if (externalIds.has(lock.externalId)) {
      throw new Error(`invalid legacy profile: duplicate work identity ${lock.externalId}`);
    }
    externalIds.add(lock.externalId);
  }
  const accounts = [...document.profile.accounts]
    .sort((left, right) => left.identity.localeCompare(right.identity) || left.provider.localeCompare(right.provider) || left.accountId.localeCompare(right.accountId))
    .map((account): ExplicitAccountBinding => ({ ...account }));
  const events = document.profile.liveLocks
    .map((lock) => eventFromLock(document.profile, lock))
    .sort((left, right) => left.externalId.localeCompare(right.externalId));
  const material: ProfileImportHashMaterial = {
    format: document.format,
    version: document.version,
    profileId: document.profile.id,
    ownerId: document.profile.ownerId,
    exportedAt: document.profile.exportedAt,
    accounts,
    events,
  };
  return {
    profileId: document.profile.id,
    ownerId: document.profile.ownerId,
    exportedAt: document.profile.exportedAt,
    planHash: sha256(stableJson(material)),
    accounts,
    events,
  };
}

function commandResult(
  status: ProfileImportCommandResult["status"],
  plan: ProfileImportPlan,
  postconditions?: Postconditions,
): ProfileImportCommandResult {
  const result = {
    status,
    planHash: plan.planHash,
    profileId: plan.profileId,
    accounts: plan.accounts.length,
    liveLocks: plan.events.length,
    accountIdentities: plan.accounts.map((account) => account.identity),
    workExternalIds: plan.events.map((event) => event.externalId),
  };
  return postconditions === undefined ? result : { ...result, postconditions };
}

const inertExecutor = {
  async execute() {
    throw new Error("Profile imports cannot execute provider actions");
  },
} satisfies WorkActionExecutor;
const inertVerifier = {
  async verify() {
    return { status: "not_verified" as const, reason: "Profile imports do not execute provider actions" };
  },
} satisfies WorkActionVerifier;

function requiredTargetFiles(targetRoot: string): string[] {
  return [
    "account-directory.json",
    "action-policy.db",
    "autonomy-telemetry.db",
    "profile-import.json",
    "work-lock-store.db",
    "work-orchestrator.json",
  ].map((file) => join(targetRoot, file));
}

function readReceipt(targetRoot: string) {
  try {
    const value: unknown = parseJson(readFileSync(join(targetRoot, "profile-import.json"), "utf8"));
    return receiptSchema.parse(value);
  } catch {
    throw new Error("incomplete target: a valid completed profile-import receipt is required");
  }
}

function verifyCanonicalTarget(targetRoot: string, plan: ProfileImportPlan): Postconditions {
  if (requiredTargetFiles(targetRoot).some((file) => !existsSync(file))) {
    throw new Error("incomplete target: canonical profile-import files are missing");
  }
  const receipt = readReceipt(targetRoot);
  if (receipt.profileId !== plan.profileId || receipt.planHash !== plan.planHash) {
    throw new Error("profile replay contains different content from the completed import");
  }

  const now = Date.parse(plan.exportedAt);
  const accounts = new AccountDirectory({
    ownerId: plan.ownerId,
    store: new JsonFileAccountDirectoryStore(join(targetRoot, "account-directory.json")),
  });
  const snapshot = accounts.snapshot();
  if (snapshot.length !== plan.accounts.length) throw new Error("incomplete target: account count does not match the import receipt");
  for (const expected of plan.accounts) {
    const resolution = accounts.resolveExact({
      ownerId: plan.ownerId,
      identity: expected.identity,
      provider: expected.provider,
      accountId: expected.accountId,
    });
    if (resolution.status !== "resolved") {
      throw new Error(`incomplete target: account identity ${expected.identity} does not resolve exactly`);
    }
    if (!resolution.sources.some((source) => source.kind === expected.source && source.sourceId === expected.sourceId)) {
      throw new Error(`incomplete target: account provenance for ${expected.identity} does not match`);
    }
    if (expected.evidenceRef && !resolution.evidenceRefs.includes(expected.evidenceRef)) {
      throw new Error(`incomplete target: account evidence for ${expected.identity} does not match`);
    }
  }

  const work = new WorkLockStore({ file: join(targetRoot, "work-lock-store.db"), now: () => now });
  const policy = new ActionPolicy({ file: join(targetRoot, "action-policy.db"), now: () => now, defaultOwnerId: plan.ownerId });
  const telemetry = new AutonomyTelemetry({ file: join(targetRoot, "autonomy-telemetry.db"), now: () => now });
  try {
    const orchestrator = createWorkOrchestrator({
      work,
      accounts,
      policy,
      telemetry,
      executor: inertExecutor,
      verifier: inertVerifier,
      journalFile: join(targetRoot, "work-orchestrator.json"),
      accountOwnerId: plan.ownerId,
      now: () => now,
    });
    const workIds: string[] = [];
    let pendingApprovals = 0;
    let deadlines = 0;
    for (const event of plan.events) {
      const replay = orchestrator.ingest(event);
      if (replay.status !== "unchanged" || !("workId" in replay)) {
        throw new Error(`incomplete target: work replay failed for ${event.externalId}`);
      }
      workIds.push(replay.workId);
      const obligation = work.getObligation(replay.workId);
      if (!obligation || obligation.externalIdentity.id !== event.externalId || obligation.title !== event.title ||
          obligation.description !== (event.description ?? null) || obligation.owner?.id !== event.ownerId ||
          obligation.owner.label !== event.ownerLabel) {
        throw new Error(`incomplete target: work identity ${event.externalId} does not match`);
      }
      const metadata = z.object({
        kind: z.literal("profile-import"),
        source: z.literal(event.source),
        profileId: z.literal(event.profileId),
        externalId: z.literal(event.externalId),
        contentHash: z.literal(event.contentHash),
        guards: z.array(z.string()),
      }).strict().safeParse(obligation.metadata);
      if (!metadata.success || stableJson(metadata.data.guards) !== stableJson([...event.guards])) {
        throw new Error(`incomplete target: guards for ${event.externalId} do not match`);
      }
      if (obligation.evidence.length !== 1 || obligation.evidence[0]?.reference !== event.evidence.reference ||
          obligation.evidence[0].summary !== event.evidence.summary || obligation.evidence[0].recordedAt !== event.evidence.observedAt) {
        throw new Error(`incomplete target: evidence for ${event.externalId} does not match`);
      }
      const expectedApprovalCount = event.approval ? 1 : 0;
      if (obligation.approvals.length !== expectedApprovalCount || obligation.approvals.some((approval) => approval.status !== "pending" || approval.payload !== null)) {
        throw new Error(`incomplete target: approval state for ${event.externalId} is not pending-only`);
      }
      const expectedDeadlineCount = event.deadline ? 1 : 0;
      if (obligation.deadlines.length !== expectedDeadlineCount || obligation.deadlines.some((deadline) => deadline.status !== "active")) {
        throw new Error(`incomplete target: deadline state for ${event.externalId} does not match`);
      }
      const preparation = orchestrator.prepare(replay.workId);
      if (preparation.status !== "not_ready" || preparation.reason !== "work_not_found_or_not_action") {
        throw new Error(`incomplete target: imported work unexpectedly prepared an executable action for ${event.externalId}`);
      }
      pendingApprovals += obligation.approvals.length;
      deadlines += obligation.deadlines.length;
    }
    workIds.sort();
    if (stableJson(workIds) !== stableJson([...receipt.workIds].sort())) {
      throw new Error("incomplete target: canonical work IDs do not match the import receipt");
    }
    const projection = work.listOpenWork({ asOf: now, limit: 1_000 });
    if (projection.obligations.length !== plan.events.length) {
      throw new Error("incomplete target: canonical work projection count does not match");
    }
    const postconditions = {
      accounts: snapshot.length,
      work: projection.obligations.length,
      pendingApprovals,
      deadlines,
      actionRules: policy.listRules({ includeRevoked: true }).length,
      actionRuleCandidates: policy.listCandidates().length,
    } satisfies Postconditions;
    if (stableJson(postconditions) !== stableJson(receipt.postconditions)) {
      throw new Error("incomplete target: canonical postconditions do not match the import receipt");
    }
    return postconditions;
  } finally {
    telemetry.close();
    policy.close();
    work.close();
  }
}

function applyToStaging(stagingRoot: string, plan: ProfileImportPlan): Postconditions {
  const now = Date.parse(plan.exportedAt);
  const accounts = new AccountDirectory({
    ownerId: plan.ownerId,
    store: new JsonFileAccountDirectoryStore(join(stagingRoot, "account-directory.json")),
  });
  for (const binding of plan.accounts) {
    const result = accounts.register({ ownerId: plan.ownerId, ...binding });
    if (result.status !== "accepted") throw new Error(`Profile account import was not new: ${binding.identity}`);
  }
  const work = new WorkLockStore({ file: join(stagingRoot, "work-lock-store.db"), now: () => now });
  const policy = new ActionPolicy({ file: join(stagingRoot, "action-policy.db"), now: () => now, defaultOwnerId: plan.ownerId });
  const telemetry = new AutonomyTelemetry({ file: join(stagingRoot, "autonomy-telemetry.db"), now: () => now });
  const workIds: string[] = [];
  try {
    const orchestrator = createWorkOrchestrator({
      work,
      accounts,
      policy,
      telemetry,
      executor: inertExecutor,
      verifier: inertVerifier,
      journalFile: join(stagingRoot, "work-orchestrator.json"),
      accountOwnerId: plan.ownerId,
      now: () => now,
    });
    for (const event of plan.events) {
      const result = orchestrator.ingest(event);
      if (result.status !== "created" || !("workId" in result)) {
        throw new Error(`Profile work import was denied for ${event.externalId}`);
      }
      workIds.push(result.workId);
    }
    const projection = work.listOpenWork({ asOf: now, limit: 1_000 });
    const postconditions = {
      accounts: accounts.snapshot().length,
      work: projection.obligations.length,
      pendingApprovals: projection.pendingApprovals.length,
      deadlines: projection.deadlines.length,
      actionRules: policy.listRules({ includeRevoked: true }).length,
      actionRuleCandidates: policy.listCandidates().length,
    } satisfies Postconditions;
    const receipt = {
      format: "openmaus.profile-import-receipt",
      version: 1,
      profileId: plan.profileId,
      planHash: plan.planHash,
      completedAt: plan.exportedAt,
      workIds: workIds.sort(),
      postconditions,
    } satisfies z.infer<typeof receiptSchema>;
    writeFileAtomic(join(stagingRoot, "profile-import.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    return postconditions;
  } finally {
    telemetry.close();
    policy.close();
    work.close();
  }
}

export function runProfileImport(options: {
  readonly sourceFile: string;
  readonly targetRoot: string;
  readonly mode: "dry-run" | "apply";
  readonly reviewedPlanHash?: string;
}): ProfileImportCommandResult {
  const sourceFile = resolve(options.sourceFile);
  const targetRoot = resolve(options.targetRoot);
  if (!options.sourceFile.trim() || !options.targetRoot.trim()) throw new Error("Explicit source and target paths are required");
  const plan = createProfileImportPlan(readFileSync(sourceFile, "utf8"));
  if (options.mode === "dry-run") return commandResult("dry-run", plan);
  if (!options.reviewedPlanHash || options.reviewedPlanHash !== plan.planHash) {
    throw new Error("Apply requires the exact --plan-hash returned by dry-run for this content");
  }

  if (existsSync(targetRoot)) {
    if (lstatSync(targetRoot).isSymbolicLink()) throw new Error("incomplete target: symbolic-link targets are refused");
    const receipt = readReceipt(targetRoot);
    if (receipt.profileId !== plan.profileId || receipt.planHash !== plan.planHash) {
      throw new Error("profile replay contains different content from the completed import");
    }
    return commandResult("unchanged", plan, verifyCanonicalTarget(targetRoot, plan));
  }

  const parent = dirname(targetRoot);
  mkdirSync(parent, { recursive: true });
  const stagingRoot = mkdtempSync(join(parent, `.${basename(targetRoot)}.profile-import-`));
  let promoted = false;
  try {
    applyToStaging(stagingRoot, plan);
    const postconditions = verifyCanonicalTarget(stagingRoot, plan);
    renameSync(stagingRoot, targetRoot);
    promoted = true;
    return commandResult("applied", plan, postconditions);
  } finally {
    if (!promoted && existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: true });
  }
}
