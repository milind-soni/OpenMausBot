import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

import { redactSecretsInText } from "./redact.ts";

type JsonObject = Record<string, unknown>;

export const OBSERVER_BRIDGE_SERVER = "aos-fleet-bridge";
export const OPENMAUS_SURFACE = "openmausbot";
export const OBSERVER_TURN_TTL_MS = 5 * 60_000;

const MAX_PRESENCE_FILES = 512;
const MAX_PRESENCE_FILE_BYTES = 128 * 1024;
const MAX_PROPOSAL_FEED_BYTES = 1024 * 1024;
// The governed feed is produced weekly. Consumers accept it through the next
// scheduled cycle plus one day of launchd/TCC grace, and no longer invent
// shorter surface-specific freshness windows.
export const PROPOSAL_FRESHNESS_MS = 8 * 24 * 60 * 60_000;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

const InterfaceSchema = z.enum([
  "codex-app",
  "codex-cli",
  "claude-ide",
  "claude-cli",
  "opencode-cli",
  "opencode-ide",
  "hermes-cli",
  "hermes-gateway",
  "openmausbot",
  "unclassified",
]);

const SurfaceSchema = z.enum(["codex", "claude", "opencode", "hermes", "openmaus", "unknown"]);
const WorkCategorySchema = z.enum([
  "implementation", "review", "diagnosis", "research", "coordination", "memory", "unknown",
]);
const PhaseSchema = z.enum(["starting", "active", "blocked", "handoff", "completed", "expired", "unknown"]);
const NullableId = z.string().max(160).regex(SAFE_ID).nullable();
const NullableRepositoryId = z.string().regex(/^repo-[0-9a-f]{24}$/).nullable();
const NullableWorktreeId = z.string().regex(/^wt-[0-9a-f]{24}$/).nullable();
const Timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), "invalid timestamp");

const PresenceCoreSchema = z.object({
  schema: z.literal("surface_presence.v1"),
  presence_id: z.string().regex(/^presence-[0-9a-f]{24}$/),
  session_id: z.string().min(1).max(160).regex(SAFE_ID),
  native_session_id: z.string().min(1).max(160).regex(SAFE_ID),
  task_id: z.string().min(1).max(160).regex(SAFE_ID),
  parent_session_id: NullableId,
  surface: SurfaceSchema,
  interface: InterfaceSchema,
  project_id: z.string().min(1).max(160).regex(SAFE_ID),
  repository_id: NullableRepositoryId,
  worktree_id: NullableWorktreeId,
  work_category: WorkCategorySchema,
  phase: PhaseSchema,
  claim_ids: z.array(z.string().uuid()).max(16),
  started_at: Timestamp,
  heartbeat_at: Timestamp,
  heartbeat_interval_seconds: z.literal(60),
  expires_at: Timestamp,
  ttl_seconds: z.literal(300),
}).strict();

const SurfacePresenceSchema = PresenceCoreSchema.extend({
  receipt_hash: z.string().regex(SHA256),
  // Legacy v1 wire name. This is an unkeyed canonical checksum that binds the
  // declared host id to the receipt; it is not a signature or proof of origin.
  host_signature: z.object({
    algorithm: z.literal("sha256-host-bound-v1"),
    host_id: z.string().regex(/^host-[0-9a-f]{24}$/),
    value: z.string().regex(SHA256),
  }).strict(),
}).strict();

export type SurfacePresence = z.infer<typeof SurfacePresenceSchema>;

export interface ObserverToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function verifySurfacePresence(value: unknown): SurfacePresence {
  const presence = SurfacePresenceSchema.parse(value);
  if (new Set(presence.claim_ids).size !== presence.claim_ids.length) {
    throw new Error("surface presence contains duplicate claim ids");
  }
  const startedAt = Date.parse(presence.started_at);
  const heartbeatAt = Date.parse(presence.heartbeat_at);
  const expiresAt = Date.parse(presence.expires_at);
  if (startedAt > heartbeatAt || expiresAt - heartbeatAt !== presence.ttl_seconds * 1000) {
    throw new Error("surface presence timestamps violate the fixed heartbeat lease");
  }
  const {
    receipt_hash: receiptHash,
    host_signature: hostChecksum,
    ...unsignedCore
  } = presence;
  if (sha256(canonicalJson(unsignedCore)) !== receiptHash) {
    throw new Error("surface presence receipt hash mismatch");
  }
  const hostBoundCore = {
    host_id: hostChecksum.host_id,
    receipt_hash: receiptHash,
    presence_id: presence.presence_id,
  };
  if (sha256(canonicalJson(hostBoundCore)) !== hostChecksum.value) {
    throw new Error("surface presence host-bound checksum mismatch");
  }
  return presence;
}

/** Build a canonical, integrity-checked v1 fixture. No origin authentication is implied. */
export function sealSurfacePresenceForTest(
  core: z.input<typeof PresenceCoreSchema>,
  hostId: string,
): SurfacePresence {
  const parsedCore = PresenceCoreSchema.parse(core);
  const receiptHash = sha256(canonicalJson(parsedCore));
  const value = sha256(canonicalJson({
    host_id: hostId,
    receipt_hash: receiptHash,
    presence_id: parsedCore.presence_id,
  }));
  return verifySurfacePresence({
    ...parsedCore,
    receipt_hash: receiptHash,
    host_signature: { algorithm: "sha256-host-bound-v1", host_id: hostId, value },
  });
}

const emptyObjectSchema: JsonObject = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export function observerBridgeToolDefinitions(): ObserverToolDefinition[] {
  return [
    {
      name: "protocol_capabilities",
      description: "Inspect the pinned bridge protocol contract without controlling a session.",
      inputSchema: emptyObjectSchema,
    },
    {
      name: "surface_status",
      description: "Read OpenMaus bridge health and queue counters.",
      inputSchema: emptyObjectSchema,
    },
    {
      name: "inbox_pull",
      description: "Pull addressed OpenMaus inbox entries without acknowledging them.",
      inputSchema: {
        type: "object",
        properties: {
          include_read: { type: "boolean", default: false },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        additionalProperties: false,
      },
    },
    {
      name: "message_ack",
      description: "Acknowledge one addressed OpenMaus inbox entry as read; repeated acknowledgements are suppressed.",
      inputSchema: {
        type: "object",
        properties: {
          entry_id: { type: "string", pattern: "^[0-9a-f]{8,64}$" },
          note: { type: "string", maxLength: 500 },
        },
        required: ["entry_id"],
        additionalProperties: false,
      },
    },
    {
      name: "task_status",
      description: "Read one task envelope and its acknowledgement state.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string", pattern: "^[0-9a-f]{8,64}$" } },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
  ];
}

const InboxPullSchema = z.object({
  include_read: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();
const MessageAckSchema = z.object({
  entry_id: z.string().regex(/^[0-9a-f]{8,64}$/),
  note: z.string().max(500).optional(),
}).strict();
const TaskStatusSchema = z.object({ task_id: z.string().regex(/^[0-9a-f]{8,64}$/) }).strict();

export function observerBridgeCall(
  tool: string,
  args: JsonObject,
): { backendTool: string; arguments: JsonObject; duplicateKey?: string } | null {
  if (tool === "protocol_capabilities") {
    z.object({}).strict().parse(args);
    return { backendTool: tool, arguments: {} };
  }
  if (tool === "surface_status") {
    z.object({}).strict().parse(args);
    return { backendTool: tool, arguments: { surface: OPENMAUS_SURFACE } };
  }
  if (tool === "inbox_pull") {
    const parsed = InboxPullSchema.parse(args);
    return {
      backendTool: "inbox_list",
      arguments: { surface: OPENMAUS_SURFACE, ...parsed },
    };
  }
  if (tool === "message_ack") {
    const parsed = MessageAckSchema.parse(args);
    return {
      backendTool: tool,
      arguments: { ...parsed, surface: OPENMAUS_SURFACE },
      duplicateKey: `message_ack:${parsed.entry_id}`,
    };
  }
  if (tool === "task_status") {
    return { backendTool: tool, arguments: TaskStatusSchema.parse(args) };
  }
  return null;
}

function plainObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function boundedJson(path: string, maximumBytes: number): Promise<unknown> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    throw new Error("observer source is not a bounded regular file");
  }
  return JSON.parse(await readFile(path, "utf8"));
}

async function presenceFiles(rootInput: string): Promise<string[]> {
  let root: string;
  try {
    root = await realpath(resolve(rootInput));
  } catch {
    return [];
  }
  const files: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4 || files.length >= MAX_PRESENCE_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= MAX_PRESENCE_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
    }
  };
  await walk(root, 0);
  return files;
}

interface PresenceSnapshot {
  active: SurfacePresence[];
  expired: SurfacePresence[];
  invalid: number;
  duplicates: number;
  conflicts: string[];
}

export interface ObserverTaskPresenceOptions {
  presenceDir?: string;
  proposalFeedPath?: string;
  now?: () => number;
}

export class ObserverTaskPresenceAdapter {
  private readonly presenceDir: string;
  private readonly proposalFeedPath: string;
  private readonly now: () => number;

  constructor(options: ObserverTaskPresenceOptions = {}) {
    this.presenceDir = options.presenceDir ?? process.env.AOS_SURFACE_PRESENCE_DIR ??
      join(homedir(), ".local", "state", "aos-session-bridge", "presence");
    this.proposalFeedPath = options.proposalFeedPath ?? process.env.AOS_IMPROVEMENT_FEED ??
      join(homedir(), ".local", "state", "self-improve-recs", "latest.json");
    this.now = options.now ?? Date.now;
  }

  toolDefinitions(): ObserverToolDefinition[] {
    return [
      {
        name: "presence_list",
        description: "List canonical, integrity-checked, non-expired surface_presence.v1 leases without prompts or transcripts; origin is not authenticated.",
        inputSchema: {
          type: "object",
          properties: {
            surface: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
            interface: { type: "string", enum: InterfaceSchema.options },
            task_id: { type: "string", minLength: 1, maxLength: 512 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
          additionalProperties: false,
        },
      },
      {
        name: "presence_status",
        description: "Read integrity and expiry status for one presence id; origin is not authenticated.",
        inputSchema: {
          type: "object",
          properties: { presence_id: { type: "string", pattern: "^presence-[0-9a-f]{24}$" } },
          required: ["presence_id"],
          additionalProperties: false,
        },
      },
      {
        name: "improvement_proposals",
        description: "List fresh proposal-only improvement metadata; stale feeds and mutation instructions are withheld.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
            schema_version: { type: "integer", enum: [1, 2], default: 2 },
          },
          additionalProperties: false,
        },
      },
    ];
  }

  handles(tool: string): boolean {
    return this.toolDefinitions().some((definition) => definition.name === tool);
  }

  private async snapshot(): Promise<PresenceSnapshot> {
    const unique = new Map<string, SurfacePresence>();
    const seenReceipts = new Map<string, Set<string>>();
    const conflicts = new Set<string>();
    let invalid = 0;
    let duplicates = 0;
    for (const path of await presenceFiles(this.presenceDir)) {
      try {
        const raw = await boundedJson(path, MAX_PRESENCE_FILE_BYTES);
        const candidates = plainObject(raw) && Array.isArray(raw.presences) ? raw.presences : [raw];
        for (const candidate of candidates) {
          const presence = verifySurfacePresence(candidate);
          const receipts = seenReceipts.get(presence.presence_id) ?? new Set<string>();
          if (receipts.has(presence.receipt_hash)) {
            duplicates += 1;
            continue;
          }
          receipts.add(presence.receipt_hash);
          seenReceipts.set(presence.presence_id, receipts);
          const prior = unique.get(presence.presence_id);
          if (!prior) unique.set(presence.presence_id, presence);
          else {
            conflicts.add(presence.presence_id);
            unique.delete(presence.presence_id);
          }
        }
      } catch {
        invalid += 1;
      }
    }
    const now = this.now();
    const rows = [...unique.values()]
      .filter((presence) => !conflicts.has(presence.presence_id))
      .sort((left, right) => Date.parse(right.heartbeat_at) - Date.parse(left.heartbeat_at));
    return {
      active: rows.filter((presence) => Date.parse(presence.expires_at) > now),
      expired: rows.filter((presence) => Date.parse(presence.expires_at) <= now),
      invalid,
      duplicates,
      conflicts: [...conflicts].sort(),
    };
  }

  private presenceProjection(presence: SurfacePresence, state: "active" | "expired"): JsonObject {
    return {
      schema: presence.schema,
      presence_id: presence.presence_id,
      session_id: presence.session_id,
      native_session_id: presence.native_session_id,
      task_id: presence.task_id,
      parent_session_id: presence.parent_session_id,
      surface: presence.surface,
      interface: presence.interface,
      project_id: presence.project_id,
      repository_id: presence.repository_id,
      worktree_id: presence.worktree_id,
      work_category: presence.work_category,
      phase: presence.phase,
      claim_ids: presence.claim_ids,
      started_at: presence.started_at,
      heartbeat_at: presence.heartbeat_at,
      expires_at: presence.expires_at,
      ttl_seconds: presence.ttl_seconds,
      receipt_hash: presence.receipt_hash,
      host_id: presence.host_signature.host_id,
      integrity_verified: true,
      origin_authenticated: false,
      state,
      instruction_authority: false,
    };
  }

  private async listPresences(args: JsonObject): Promise<JsonObject> {
    const schema = z.object({
      surface: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
      interface: InterfaceSchema.optional(),
      task_id: z.string().min(1).max(512).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }).strict();
    const input = schema.parse(args);
    const snapshot = await this.snapshot();
    const rows = snapshot.active.filter((presence) =>
      (!input.surface || presence.surface === input.surface) &&
      (!input.interface || presence.interface === input.interface) &&
      (!input.task_id || presence.task_id === input.task_id),
    ).slice(0, input.limit ?? 50);
    return {
      schema: "openmaus.observer_presence_list.v1",
      observed_at: new Date(this.now()).toISOString(),
      instruction_authority: false,
      rows: rows.map((presence) => this.presenceProjection(presence, "active")),
      diagnostics: {
        active: snapshot.active.length,
        expired_withheld: snapshot.expired.length,
        invalid_withheld: snapshot.invalid,
        duplicates_suppressed: snapshot.duplicates,
        conflicts_withheld: snapshot.conflicts.length,
      },
    };
  }

  private async presenceStatus(args: JsonObject): Promise<JsonObject> {
    const { presence_id: presenceId } = z.object({
      presence_id: z.string().regex(/^presence-[0-9a-f]{24}$/),
    }).strict().parse(args);
    const snapshot = await this.snapshot();
    if (snapshot.conflicts.includes(presenceId)) {
      return {
        schema: "openmaus.observer_presence_status.v1",
        presence_id: presenceId,
        found: false,
        state: "conflict-withheld",
        instruction_authority: false,
      };
    }
    const active = snapshot.active.find((presence) => presence.presence_id === presenceId);
    const expired = snapshot.expired.find((presence) => presence.presence_id === presenceId);
    return {
      schema: "openmaus.observer_presence_status.v1",
      presence_id: presenceId,
      found: Boolean(active || expired),
      ...(active ? { presence: this.presenceProjection(active, "active") } : {}),
      ...(expired ? { presence: this.presenceProjection(expired, "expired") } : {}),
      instruction_authority: false,
    };
  }

  private async proposals(args: JsonObject): Promise<JsonObject> {
    const { limit = 10, schema_version: schemaVersion = 2 } = z.object({
      limit: z.number().int().min(1).max(20).optional(),
      schema_version: z.union([z.literal(1), z.literal(2)]).optional(),
    }).strict().parse(args);
    const responseSchema = `openmaus.observer_improvement_proposals.v${schemaVersion}`;
    const withheld = (state: string, generatedAt: unknown = null): JsonObject => ({
      schema: responseSchema,
      state,
      generated_at: typeof generatedAt === "string" ? generatedAt : null,
      mutation_authority: "none",
      instruction_authority: false,
      proposals: [],
    });
    let raw: unknown;
    try {
      const metadata = await lstat(this.proposalFeedPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PROPOSAL_FEED_BYTES) {
        return withheld("unsafe-withheld");
      }
      raw = JSON.parse(await readFile(this.proposalFeedPath, "utf8"));
    } catch (error) {
      return withheld((error as NodeJS.ErrnoException).code === "ENOENT" ? "unavailable" : "invalid-withheld");
    }
    if (!plainObject(raw) || !["improvement_proposal_feed.v1", "improvement_proposal_feed.v2"].includes(String(raw.schema))) {
      return withheld("invalid-withheld");
    }
    const generatedAt = typeof raw.generated_at === "string" ? Date.parse(raw.generated_at) : Number.NaN;
    const ageMs = this.now() - generatedAt;
    const explicitExpiry = typeof raw.expires_at === "string" ? Date.parse(raw.expires_at) : null;
    const isV2 = raw.schema === "improvement_proposal_feed.v2";
    const capabilities = raw.action_capabilities ?? [];
    const proposalOnly = raw.proposal_only === true && raw.automatic_mutation === false &&
      (raw.mutation_authority === undefined || raw.mutation_authority === "none") &&
      Array.isArray(capabilities) && capabilities.length === 0;
    const mutationDisabled = raw.automatic_mutation === false && (!isV2 || raw.mutation_authority === "none");
    const stale = ageMs > PROPOSAL_FRESHNESS_MS || (explicitExpiry !== null && Number.isFinite(explicitExpiry) && explicitExpiry <= this.now());
    const invalidExpiry = explicitExpiry !== null && !Number.isFinite(explicitExpiry);
    if (!Number.isFinite(generatedAt) || ageMs < -5 * 60_000 || stale || invalidExpiry || !proposalOnly || !mutationDisabled) {
      return withheld(stale ? "stale-withheld" : "unsafe-withheld", raw.generated_at);
    }
    if (!Array.isArray(raw.proposals)) return withheld("invalid-withheld", raw.generated_at);
    const expectedFeedHash = sha256(canonicalJson(raw.proposals));
    const suppliedFeedHash = typeof raw.feed_hash === "string"
      ? (raw.feed_hash.startsWith("sha256:") ? raw.feed_hash : `sha256:${raw.feed_hash}`)
      : null;
    if (suppliedFeedHash !== expectedFeedHash) return withheld("invalid-withheld", raw.generated_at);

    const projectedRows = raw.proposals.map((candidate): JsonObject | null => {
      if (!plainObject(candidate) || candidate.automatic_mutation !== false) return null;
      const candidateV2 = candidate.schema === "improvement_proposal.v2";
      if (candidateV2) {
        if (candidate.mutation_authority !== "none" || candidate.trust_class !== "untrusted_observation_data") return null;
        if (candidate.state !== "proposed") return null;
      } else if (candidate.schema !== "improvement_proposal.v1" || candidate.approval_required !== true) return null;
      const candidateJson = canonicalJson(candidate);
      if (redactSecretsInText(candidateJson) !== candidateJson) return null;
      const proposalId = typeof candidate.proposal_id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidate.proposal_id)
        ? candidate.proposal_id
        : null;
      const title = typeof candidate.title === "string" ? candidate.title.trim().slice(0, 500) : "";
      if (!proposalId || !title || redactSecretsInText(title) !== title) return null;
      const expiry = typeof candidate.expires_at === "string"
        ? candidate.expires_at
        : typeof candidate.expiry === "string" ? candidate.expiry : null;
      if (
        !expiry || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= this.now() ||
        !Number.isInteger(candidate.recurrence_count) || Number(candidate.recurrence_count) < 2
      ) return null;
      const contentHash = typeof candidate.content_hash === "string" && SHA256.test(candidate.content_hash)
        ? candidate.content_hash
        : null;
      if (!contentHash) return null;
      if (!candidateV2) {
        const { content_hash: _contentHash, ...content } = candidate;
        if (sha256(canonicalJson(content)) !== contentHash) return null;
        if (
          typeof candidate.proposed_diff !== "string" || !candidate.proposed_diff.trim() ||
          typeof candidate.risk !== "string" || !candidate.risk.trim() ||
          !Array.isArray(candidate.tests) || !candidate.tests.some((value) => typeof value === "string" && value.trim()) ||
          typeof candidate.rollback !== "string" || !candidate.rollback.trim()
        ) return null;
      }
      const evidence = [candidate.content_hash, ...(Array.isArray(candidate.evidence_hashes) ? candidate.evidence_hashes : []), ...(Array.isArray(candidate.evidence) ? candidate.evidence : [])]
        .flatMap((value) => typeof value === "string" ? (value.match(/(?:sha256:)?[0-9a-f]{64}/g) ?? []) : [])
        .map((value) => value.startsWith("sha256:") ? value : `sha256:${value}`)
        .filter((value, index, rows) => rows.indexOf(value) === index)
        .slice(0, 20);
      if (evidence.length < 2) return null;
      const displayOnly = {
        proposed_change: typeof candidate.proposed_diff === "string"
          ? candidate.proposed_diff.trim().slice(0, 2_000)
          : null,
        risk: typeof candidate.risk === "string" ? candidate.risk.trim().slice(0, 1_000) : null,
        tests: Array.isArray(candidate.tests)
          ? candidate.tests.filter((value): value is string => typeof value === "string")
            .map((value) => value.trim().slice(0, 500)).filter(Boolean).slice(0, 5)
          : [],
        rollback: typeof candidate.rollback === "string" ? candidate.rollback.trim().slice(0, 1_000) : null,
        trusted_as_instructions: false,
      };
      // Do not project even redacted credential material: a proposal carrying a
      // secret-shaped value is malformed observer input and must be withheld.
      const displayJson = canonicalJson(displayOnly);
      if (redactSecretsInText(displayJson) !== displayJson) return null;
      const projected = {
        proposal_id: proposalId,
        cluster_id: typeof candidate.cluster_id === "string" && SAFE_ID.test(candidate.cluster_id) ? candidate.cluster_id : null,
        title,
        project_id: typeof (candidate.project_id ?? candidate.project) === "string" && SAFE_ID.test(String(candidate.project_id ?? candidate.project))
          ? candidate.project_id ?? candidate.project
          : null,
        category: typeof candidate.category === "string" && SAFE_ID.test(candidate.category) ? candidate.category : null,
        affected_surfaces: Array.isArray(candidate.affected_surfaces)
          ? candidate.affected_surfaces.filter((value) => typeof value === "string" && InterfaceSchema.safeParse(value).success).slice(0, 10)
          : [],
        target_type: typeof candidate.target_type === "string" && SAFE_ID.test(candidate.target_type) ? candidate.target_type : null,
        state: typeof candidate.state === "string" ? candidate.state.slice(0, 32) : "proposed",
        recurrence_count: Number.isInteger(candidate.recurrence_count) ? Math.max(0, Number(candidate.recurrence_count)) : 0,
        expires_at: expiry,
        evidence_hashes: evidence,
        content_hash: contentHash,
        review_required: true,
        mutation_authority: "none",
        instruction_authority: false,
      };
      return schemaVersion === 2 ? { ...projected, display_only: displayOnly } : projected;
    });
    // A feed is one governed, hash-bound unit. Never turn a partially invalid
    // or secret-shaped feed into a seemingly healthy subset.
    if (projectedRows.some((proposal) => proposal === null)) {
      return withheld("unsafe-withheld", raw.generated_at);
    }
    const proposals = projectedRows.slice(0, limit) as JsonObject[];
    return {
      schema: responseSchema,
      state: "fresh",
      generated_at: raw.generated_at,
      feed_hash: expectedFeedHash,
      mutation_authority: "none",
      instruction_authority: false,
      proposals,
    };
  }

  async callTool(tool: string, args: JsonObject): Promise<JsonObject> {
    if (tool === "presence_list") return this.listPresences(args);
    if (tool === "presence_status") return this.presenceStatus(args);
    if (tool === "improvement_proposals") return this.proposals(args);
    throw new Error("unknown observer task-presence tool");
  }
}
