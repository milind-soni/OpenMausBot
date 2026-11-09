import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { AppConfig } from "./config.ts";

export const OPERATOR_SETTINGS = ["language", "computerName"] as const;
export type OperatorSetting = (typeof OPERATOR_SETTINGS)[number];

const settingSchema = z.enum(OPERATOR_SETTINGS);
const grantSchema = z.object({
  id: z.string().uuid(),
  botId: z.string().min(1).max(128),
  identity: z.string().min(1),
  owner: z.string().min(1).max(254),
  read: z.array(settingSchema).max(OPERATOR_SETTINGS.length),
  write: z.array(settingSchema).max(OPERATOR_SETTINGS.length),
  at: z.string().datetime(),
}).strict();
const auditSchema = z.object({
  id: z.string().uuid(), at: z.string().datetime(), actor: z.string().min(1),
  action: z.enum(["appoint", "revoke", "apply", "rollback"]),
  botId: z.string().min(1), owner: z.string().min(1),
  setting: settingSchema.optional(), before: z.string().optional(), after: z.string().optional(),
  state: z.enum(["pending", "applied", "failed"]), reason: z.string().optional(),
  decision: z.enum(["owner-appointed", "owner-revoked", "identity-lost", "scope-allowed"]).optional(), undoOf: z.string().uuid().optional(),
  grantId: z.string().uuid().optional(), revision: z.string().optional(),
}).strict();
const stateSchema = z.object({ grant: grantSchema.nullable(), audit: z.array(auditSchema) }).strict();
type Grant = z.infer<typeof grantSchema>;
type Audit = z.infer<typeof auditSchema>;
type State = z.infer<typeof stateSchema>;
type Preview = { id: string; botId: string; threadId: string; generation: string; grantId: string; setting: OperatorSetting; before: string; after: string; revision: string; expiresAt: number };

const AUDIT_LIMIT = 1_000;
const AUDIT_RESPONSE_LIMIT = 100;
const PENDING_LIMIT = 100;
const PREVIEW_LIMIT = 100;
const PREVIEW_LIFETIME_MS = 10 * 60_000;

export class OperatorRefusal extends Error {
  readonly status: 400 | 403 | 404 | 409 | 503;
  constructor(status: 400 | 403 | 404 | 409 | 503, message: string) { super(message); this.status = status; }
}

function validValue(setting: OperatorSetting, value: unknown): string {
  if (typeof value !== "string") throw new OperatorRefusal(400, `${setting} must be a string`);
  if (setting === "language") {
    if (value && (value.length > 35 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(value))) {
      throw new OperatorRefusal(400, "language must be empty or a lowercase BCP-47 language tag");
    }
  } else if (value.length > 63 || value.trim() !== value || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new OperatorRefusal(400, "computerName must be at most 63 trimmed, printable characters");
  }
  return value;
}

export interface ChiefOperatorDeps {
  dataDir: string;
  config(): AppConfig;
  botIdentity(id: string): string | null;
  ownerActive?(owner: string): boolean;
  writeSetting(setting: OperatorSetting, value: string): void;
  changed(): void;
}

/** A separate owner-appointed platform role. Bot records, exports, templates and Chief rank never carry its grant. */
export class ChiefOperator {
  private readonly deps: ChiefOperatorDeps;
  private readonly file: string;
  private readonly configFile: string;
  private readonly previews = new Map<string, Preview>();

  constructor(deps: ChiefOperatorDeps) {
    this.deps = deps;
    this.file = join(deps.dataDir, "chief-operator.json");
    this.configFile = join(deps.dataDir, "config.json");
  }

  private state(): State {
    if (!existsSync(this.file)) return { grant: null, audit: [] };
    try {
      const state = stateSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
      if (state.audit.filter(row => row.state === "pending").length > PENDING_LIMIT) throw new Error("pending operation limit exceeded");
      return state;
    }
    catch { throw new OperatorRefusal(503, "Chief Operator record is unreadable. Platform administration is disabled until the owner repairs it."); }
  }

  private save(state: State): void {
    mkdirSync(this.deps.dataDir, { recursive: true });
    if (state.audit.filter(row => row.state === "pending").length > PENDING_LIMIT) throw new OperatorRefusal(503, "Too many pending Chief Operator receipts. The owner must reconcile them before new changes.");
    const audit = state.audit.length <= AUDIT_LIMIT ? state.audit : [
      ...state.audit.filter(row => row.state === "pending"),
      ...state.audit.filter(row => row.state !== "pending").slice(-AUDIT_LIMIT),
    ];
    writeFileAtomic(this.file, JSON.stringify({ ...state, audit }), { mode: 0o600 });
  }

  private configStamp(): string {
    try {
      const stat = statSync(this.configFile, { bigint: true });
      return `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
    } catch { return "missing"; }
  }

  private current(setting: OperatorSetting): string { return this.deps.config()[setting] ?? ""; }

  private revision(grant: Grant, setting: OperatorSetting): string {
    return createHash("sha256").update(JSON.stringify([grant.id, setting, this.current(setting), this.configStamp()])).digest("hex");
  }

  private grantFor(botId: string): Grant {
    const grant = this.state().grant;
    if (!grant || grant.botId !== botId || this.deps.botIdentity(botId) !== grant.identity || this.deps.ownerActive?.(grant.owner) === false) throw new OperatorRefusal(403, "This bot is not the appointed Chief Operator.");
    return grant;
  }

  isAppointed(botId: string): boolean {
    try { const grant = this.state().grant; return grant?.botId === botId && this.deps.botIdentity(botId) === grant.identity && this.deps.ownerActive?.(grant.owner) !== false; }
    catch { return false; }
  }

  ownerOf(botId: string): string { return this.grantFor(botId).owner; }

  revokeIfIdentityLost(botId: string): void {
    const state = this.state();
    const grant = state.grant;
    if (!grant || grant.botId !== botId || this.deps.botIdentity(botId) === grant.identity) return;
    this.save({ grant: null, audit: [...state.audit, { id: randomUUID(), at: new Date().toISOString(), actor: "system", action: "revoke", botId, owner: grant.owner, state: "applied", decision: "identity-lost", grantId: grant.id, reason: "The bot was deleted, hidden, moved, or changed ownership or department." }] });
    this.previews.clear();
  }

  private scope(botId: string, setting: OperatorSetting, access: "read" | "write"): Grant {
    const grant = this.grantFor(botId);
    if (!grant[access].includes(setting)) throw new OperatorRefusal(403, `${setting} is outside this bot's ${access} scope.`);
    return grant;
  }

  appointment(): { grant: Grant | null; revision: string; audit: Audit[]; auditHasMore: boolean; pending: Audit[] } {
    const state = this.state();
    return { grant: state.grant, revision: state.grant?.id ?? "none", audit: state.audit.slice(-AUDIT_RESPONSE_LIMIT), auditHasMore: state.audit.length > AUDIT_RESPONSE_LIMIT,
      pending: state.audit.filter(row => row.state === "pending") };
  }

  appoint(input: { botId: string; read: OperatorSetting[]; write: OperatorSetting[]; expectedRevision: string }, owner: string): { grant: Grant; revision: string } {
    const state = this.state();
    if (input.expectedRevision !== (state.grant?.id ?? "none")) throw new OperatorRefusal(409, "Chief Operator appointment changed. Read it again before replacing it.");
    const identity = this.deps.botIdentity(input.botId);
    if (!identity) throw new OperatorRefusal(404, "The selected bot is unavailable or hidden.");
    if (!input.read.length && !input.write.length) throw new OperatorRefusal(400, "Select at least one read or write setting.");
    const grant: Grant = { id: randomUUID(), botId: input.botId, identity, owner, read: [...new Set(input.read)], write: [...new Set(input.write)], at: new Date().toISOString() };
    const next: State = { grant, audit: [...state.audit, { id: randomUUID(), at: grant.at, actor: owner, action: "appoint", botId: grant.botId, owner, state: "applied", decision: "owner-appointed", grantId: grant.id }] };
    this.save(next);
    this.previews.clear();
    return { grant, revision: grant.id };
  }

  revoke(expectedRevision: string, owner: string): { revoked: boolean; revision: "none" } {
    const state = this.state();
    if (expectedRevision !== (state.grant?.id ?? "none")) throw new OperatorRefusal(409, "Chief Operator appointment changed. Read it again before revoking it.");
    if (state.grant) {
      this.save({ grant: null, audit: [...state.audit, { id: randomUUID(), at: new Date().toISOString(), actor: owner, action: "revoke", botId: state.grant.botId, owner, state: "applied", decision: "owner-revoked", grantId: state.grant.id }] });
      this.previews.clear();
    }
    return { revoked: Boolean(state.grant), revision: "none" };
  }

  describe(botId: string): { read: OperatorSetting[]; write: OperatorSetting[]; settings: Array<{ setting: OperatorSetting; value: string; revision: string }> } {
    const grant = this.grantFor(botId);
    return { read: grant.read, write: grant.write, settings: grant.read.map(setting => ({ setting, value: this.current(setting), revision: this.revision(grant, setting) })) };
  }

  preview(input: { botId: string; threadId: string; generation: string; setting: OperatorSetting; value: string }): { previewId: string; setting: OperatorSetting; target: "platform"; after: string; before?: string; revision: string; consequence: string } {
    const grant = this.scope(input.botId, input.setting, "write");
    const after = validValue(input.setting, input.value);
    const before = this.current(input.setting);
    const revision = this.revision(grant, input.setting);
    const previewId = randomUUID();
    for (const [id, preview] of this.previews) if (preview.expiresAt <= Date.now()) this.previews.delete(id);
    if (this.previews.size >= PREVIEW_LIMIT) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(previewId, { id: previewId, botId: input.botId, threadId: input.threadId, generation: input.generation, grantId: grant.id, setting: input.setting, before, after, revision, expiresAt: Date.now() + PREVIEW_LIFETIME_MS });
    return { previewId, setting: input.setting, target: "platform", after, ...(grant.read.includes(input.setting) ? { before } : {}), revision,
      consequence: input.setting === "language" ? "Changes the app's default language for future interface and server text; existing person-specific choices stay separate." : "Changes the name used to identify this computer in the app." };
  }

  apply(input: { botId: string; threadId: string; generation: string; previewId: string; expectedRevision: string; active(): boolean }): { receiptId: string; state: "applied"; setting: OperatorSetting; after: string; before?: string; revision: string } {
    const preview = this.previews.get(input.previewId);
    if (!preview || preview.expiresAt <= Date.now() || preview.botId !== input.botId || preview.threadId !== input.threadId || preview.generation !== input.generation) throw new OperatorRefusal(409, "Preview expired or belongs to a different turn. Preview the change again.");
    this.previews.delete(input.previewId);
    const grant = this.scope(input.botId, preview.setting, "write");
    if (!input.active()) throw new OperatorRefusal(409, "The initiating turn ended. Preview the change in a new turn.");
    if (grant.id !== preview.grantId || input.expectedRevision !== preview.revision || this.revision(grant, preview.setting) !== preview.revision || this.current(preview.setting) !== preview.before) {
      throw new OperatorRefusal(409, "The role, scope or configuration changed. Preview the setting again.");
    }
    const receiptId = this.writeChange("apply", grant, input.botId, preview.setting, preview.before, preview.after, input.active);
    return { receiptId, state: "applied", setting: preview.setting, after: preview.after, ...(grant.read.includes(preview.setting) ? { before: preview.before } : {}), revision: this.revision(grant, preview.setting) };
  }

  rollback(input: { botId: string; receiptId: string; expectedRevision: string; active(): boolean }): { receiptId: string; state: "applied"; setting: OperatorSetting; after: string; revision: string } {
    const grant = this.grantFor(input.botId);
    const original = this.state().audit.find(row => row.id === input.receiptId && row.action === "apply" && row.state === "applied" && row.botId === input.botId && row.grantId === grant.id);
    if (!original?.setting || original.before === undefined || original.after === undefined) throw new OperatorRefusal(404, "No reversible receipt exists for this grant and bot.");
    if (this.state().audit.some(row => row.undoOf === original.id && row.state !== "failed")) throw new OperatorRefusal(409, "This receipt was already rolled back or has a pending rollback.");
    this.scope(input.botId, original.setting, "read");
    this.scope(input.botId, original.setting, "write");
    const revision = this.revision(grant, original.setting);
    if (!input.active() || input.expectedRevision !== revision || this.current(original.setting) !== original.after) throw new OperatorRefusal(409, "The turn or configuration changed. Read the setting again before rollback.");
    const receiptId = this.writeChange("rollback", grant, input.botId, original.setting, original.after, original.before, input.active, original.id);
    return { receiptId, state: "applied", setting: original.setting, after: original.before, revision: this.revision(grant, original.setting) };
  }

  private writeChange(action: "apply" | "rollback", grant: Grant, botId: string, setting: OperatorSetting, before: string, after: string, active: () => boolean, undoOf?: string): string {
    const id = randomUUID();
    const beforeStamp = this.configStamp();
    const row: Audit = { id, at: new Date().toISOString(), actor: botId, action, botId, owner: grant.owner, setting, before, after, state: "pending", decision: "scope-allowed", grantId: grant.id, revision: this.revision(grant, setting), ...(undoOf ? { undoOf } : {}) };
    const state = this.state();
    if (state.grant?.id !== grant.id || !active()) throw new OperatorRefusal(409, "The role or initiating turn was revoked.");
    if (state.audit.some(item => item.state === "pending")) throw new OperatorRefusal(409, "A Chief Operator receipt is still pending. The owner must inspect and reconcile it before another settings change.");
    this.save({ ...state, audit: [...state.audit, row] });
    try {
      if (this.state().grant?.id !== grant.id || !active()) throw new OperatorRefusal(409, "The role or initiating turn was revoked.");
      this.deps.writeSetting(setting, after);
      this.deps.changed();
      const updated = this.state();
      this.save({ ...updated, audit: updated.audit.map(item => item.id === id ? { ...item, state: "applied" } : item) });
    } catch (error) {
      const updated = this.state();
      const changed = this.current(setting) !== before || this.configStamp() !== beforeStamp;
      if (!changed) this.save({ ...updated, audit: updated.audit.map(item => item.id === id ? { ...item, state: "failed", reason: "Configuration was not changed." } : item) });
      if (changed) throw new OperatorRefusal(503, `Setting may have changed, but receipt ${id} was not finalized. The owner must inspect the setting and audit before retrying.`);
      throw error;
    }
    return id;
  }
}

export const appointmentSchema = z.object({ botId: z.string().min(1).max(128), read: z.array(settingSchema).max(OPERATOR_SETTINGS.length), write: z.array(settingSchema).max(OPERATOR_SETTINGS.length), expectedRevision: z.string().min(1) }).strict();
export const revocationSchema = z.object({ expectedRevision: z.string().min(1) }).strict();
export const operatorPreviewSchema = z.object({ action: z.literal("preview"), setting: settingSchema, value: z.string() }).strict();
export const operatorApplySchema = z.object({ action: z.literal("apply"), previewId: z.string().uuid(), expectedRevision: z.string() }).strict();
export const operatorRollbackSchema = z.object({ action: z.literal("rollback"), receiptId: z.string().uuid(), expectedRevision: z.string() }).strict();
