/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- SQLite returns unknown rows; the local row readers validate every column before constructing a domain object. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "./config.ts";
import type { JsonValue } from "./schema.ts";

export const ACTION_POLICY_EFFECTS = ["allow", "ask", "deny", "draft-only"] as const;
export type ActionPolicyEffect = (typeof ACTION_POLICY_EFFECTS)[number];

export const ACTION_POLICY_RULE_STATES = ["active", "revoked"] as const;
export type ActionPolicyRuleState = (typeof ACTION_POLICY_RULE_STATES)[number];
export const ACTION_RULE_CANDIDATE_STATUSES = ["pending", "promoted", "rejected"] as const;
export type ActionRuleCandidateStatus = (typeof ACTION_RULE_CANDIDATE_STATUSES)[number];
export const ACTION_AUTHORIZATION_STATES = ["active", "consumed", "revoked"] as const;
export type ActionAuthorizationState = (typeof ACTION_AUTHORIZATION_STATES)[number];

function isActionAuthorizationState(value: string): value is ActionAuthorizationState {
  return ACTION_AUTHORIZATION_STATES.some((candidate) => candidate === value);
}
export interface ActionProposalInput {
  operation: string;
  accountId: string;
  payload: JsonValue;
  ownerId?: string;
  evidence?: readonly string[];
}

/** The immutable, hash-addressed description of one proposed tool action. */
export interface ActionProposal {
  id: string;
  operation: string;
  accountId: string;
  accountHash: string;
  payload: JsonValue;
  payloadHash: string;
  proposalHash: string;
  ownerId: string;
  evidence: string[];
  createdAt: number;
}

export interface ActionRuleCandidateInput {
  proposal: ActionProposal;
  effect: ActionPolicyEffect;
  ownerId?: string;
  expiresAt?: number | null;
  reason?: string;
}

/** Durable proof that a human (or an explicitly named policy actor) decided
 * to activate a candidate. The evidence should point at the Work approval
 * or other durable decision record; it is never inferred from the candidate
 * itself. */
export interface ActionApprovalEvidence {
  approvedBy: string;
  approvalEvidence: string;
  approvedAt: number;
}

export interface ActionRuleCandidate {
  id: string;
  proposalId: string;
  operation: string;
  accountHash: string;
  payloadHash: string;
  proposalHash: string;
  effect: ActionPolicyEffect;
  ownerId: string;
  expiresAt: number | null;
  reason: string;
  status: ActionRuleCandidateStatus;
  createdAt: number;
  approvedBy: string | null;
  approvalEvidence: string | null;
  approvedAt: number | null;
}

export interface ActionRule {
  id: string;
  version: number;
  operation: string;
  accountHash: string;
  payloadHash: string;
  effect: ActionPolicyEffect;
  ownerId: string;
  expiresAt: number | null;
  state: ActionPolicyRuleState;
  createdAt: number;
  revokedAt: number | null;
  approvedBy: string | null;
  approvalEvidence: string | null;
  approvedAt: number | null;
}

/** A single-use authorization for one immutable proposal. Unlike a rule, this
 * can never authorize a later action, even when every byte is identical. */
export interface ActionAuthorization {
  id: string;
  proposalId: string;
  proposalHash: string;
  ownerId: string;
  state: ActionAuthorizationState;
  approvedBy: string;
  approvalEvidence: string;
  approvedAt: number;
  createdAt: number;
  consumedAt: number | null;
  revokedAt: number | null;
}

export interface ActionPolicyDecision {
  effect: ActionPolicyEffect;
  /** Alias for callers that use decision terminology. */
  decision: ActionPolicyEffect;
  allowed: boolean;
  requiresApproval: boolean;
  proposalHash: string;
  ruleId: string | null;
  ruleVersion: number | null;
  reason: string;
}

export type ActionExecutionInput = ActionProposalInput | ActionProposal;

export interface ActionPolicyOptions {
  file?: string;
  now?: () => number;
  defaultOwnerId?: string;
}

export interface ActionPolicyInterface {
  prepareProposal(input: ActionProposalInput): ActionProposal;
  prepare(input: ActionProposalInput): ActionProposal;
  getProposal(id: string): ActionProposal | null;
  prepareCandidate(input: ActionRuleCandidateInput): ActionRuleCandidate;
  prepareCandidate(proposal: ActionProposal, effect: ActionPolicyEffect, options?: Omit<ActionRuleCandidateInput, "proposal" | "effect">): ActionRuleCandidate;
  getCandidate(id: string): ActionRuleCandidate | null;
  listCandidates(options?: { status?: ActionRuleCandidateStatus }): ActionRuleCandidate[];
  rejectCandidate(candidateId: string): ActionRuleCandidate;
  promoteCandidate(candidateId: string, approval: ActionApprovalEvidence): ActionRule;
  promote(candidate: ActionRuleCandidate | string, approval: ActionApprovalEvidence): ActionRule;
  authorizeOnce(proposal: ActionProposal, approval: ActionApprovalEvidence): ActionAuthorization;
  getAuthorization(id: string): ActionAuthorization | null;
  consumeAuthorization(id: string, actual: ActionExecutionInput, options?: { now?: number }): ActionPolicyDecision;
  revokeAuthorization(id: string): boolean;
  evaluate(proposal: ActionProposal, options?: { now?: number }): ActionPolicyDecision;
  revalidate(approved: ActionProposal, actual: ActionExecutionInput, options?: { now?: number }): ActionPolicyDecision;
  revokeRule(ruleId: string): boolean;
  revoke(ruleId: string): boolean;
  listRules(options?: { includeRevoked?: boolean }): ActionRule[];
  close(): void;
}

/**
 * Durable authorization for exact actions.
 *
 * The module's seam is intentionally narrow: callers prepare an immutable
 * proposal, turn that proposal into a candidate, promote it after a human
 * decision, and ask the module to evaluate/revalidate immediately before the
 * connector executes. Rules cannot be authored independently of a proposal;
 * every rule therefore carries an operation, account hash, and payload hash.
 */
export class ActionPolicy implements ActionPolicyInterface {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly defaultOwnerId: string;

  constructor(options: ActionPolicyOptions = {}) {
    const file = options.file ?? join(DATA_DIR, "action-policy.db");
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.now = options.now ?? Date.now;
    this.defaultOwnerId = normalizeRequired(options.defaultOwnerId ?? "user", "ownerId", 120);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS action_proposals (
        id TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        proposal_hash TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS action_rule_candidates (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL REFERENCES action_proposals(id),
        operation TEXT NOT NULL,
        account_hash TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        proposal_hash TEXT NOT NULL,
        effect TEXT NOT NULL CHECK (effect IN ('allow', 'ask', 'deny', 'draft-only')),
        owner_id TEXT NOT NULL,
        expires_at INTEGER,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'promoted', 'rejected')),
        created_at INTEGER NOT NULL,
        approved_by TEXT,
        approval_evidence TEXT,
        approved_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS action_rules (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        operation TEXT NOT NULL,
        account_hash TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        effect TEXT NOT NULL CHECK (effect IN ('allow', 'ask', 'deny', 'draft-only')),
        owner_id TEXT NOT NULL,
        expires_at INTEGER,
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        approved_by TEXT,
        approval_evidence TEXT,
        approved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS action_rules_match
        ON action_rules (operation, account_hash, payload_hash, state);
      CREATE INDEX IF NOT EXISTS action_rules_scope_version
        ON action_rules (operation, account_hash, payload_hash, version DESC);
      CREATE TABLE IF NOT EXISTS action_authorizations (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL REFERENCES action_proposals(id),
        proposal_hash TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'consumed', 'revoked')),
        approved_by TEXT NOT NULL,
        approval_evidence TEXT NOT NULL,
        approved_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS action_authorizations_proposal_state
        ON action_authorizations (proposal_id, state);
    `);
    // Existing installs may have created these tables before approval
    // binding existed. Nullable columns are migration-safe for old rows;
    // promotion still requires non-null evidence and writes all three values
    // atomically for new rules.
    ensureColumn(this.db, "action_rule_candidates", "approved_by", "TEXT");
    ensureColumn(this.db, "action_rule_candidates", "approval_evidence", "TEXT");
    ensureColumn(this.db, "action_rule_candidates", "approved_at", "INTEGER");
    ensureColumn(this.db, "action_rules", "approved_by", "TEXT");
    ensureColumn(this.db, "action_rules", "approval_evidence", "TEXT");
    ensureColumn(this.db, "action_rules", "approved_at", "INTEGER");
  }

  prepareProposal(input: ActionProposalInput): ActionProposal {
    const operation = normalizeRequired(input.operation, "operation", 240);
    const accountId = normalizeRequired(input.accountId, "accountId", 240);
    if (isBroadToken(operation) || isBroadToken(accountId)) {
      throw new Error("Action proposals require an exact operation and account");
    }
    if (!isJsonValue(input.payload)) throw new Error("Action payload must be JSON-compatible");
    const payload = input.payload;
    const accountHash = hashActionAccount(accountId);
    const payloadHash = hashActionPayload(payload);
    const proposalHash = hashActionProposal(operation, accountId, payload);
    const ownerId = normalizeRequired(input.ownerId ?? this.defaultOwnerId, "ownerId", 120);
    const evidence = (input.evidence ?? []).map((item) => normalizeRequired(item, "evidence", 2_000));
    const proposal: ActionProposal = {
      id: randomUUID(), operation, accountId, accountHash, payload,
      payloadHash, proposalHash, ownerId, evidence, createdAt: this.now(),
    };
    this.db.prepare(`
      INSERT INTO action_proposals
        (id, operation, account_id, account_hash, payload_json, payload_hash, proposal_hash, owner_id, evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.id, proposal.operation, proposal.accountId, proposal.accountHash,
      canonicalJson(proposal.payload), proposal.payloadHash, proposal.proposalHash,
      proposal.ownerId, JSON.stringify(proposal.evidence), proposal.createdAt,
    );
    return proposal;
  }

  /** Short alias for the proposal seam. */
  prepare(input: ActionProposalInput): ActionProposal {
    return this.prepareProposal(input);
  }

  getProposal(id: string): ActionProposal | null {
    const row = this.db.prepare(`SELECT * FROM action_proposals WHERE id = ?`).get(id);
    return row === undefined ? null : proposalFromRow(row);
  }

  prepareCandidate(input: ActionRuleCandidateInput): ActionRuleCandidate;
  prepareCandidate(proposal: ActionProposal, effect: ActionPolicyEffect, options?: Omit<ActionRuleCandidateInput, "proposal" | "effect">): ActionRuleCandidate;
  prepareCandidate(
    inputOrProposal: ActionRuleCandidateInput | ActionProposal,
    requestedEffect?: ActionPolicyEffect,
    requestedOptions: Omit<ActionRuleCandidateInput, "proposal" | "effect"> = {},
  ): ActionRuleCandidate {
    const input: ActionRuleCandidateInput = isActionProposal(inputOrProposal)
      ? { ...requestedOptions, proposal: inputOrProposal, effect: requestedEffect ?? "ask" }
      : inputOrProposal;
    if (!ACTION_POLICY_EFFECTS.includes(input.effect)) throw new Error("Unknown action policy effect");
    const proposal = this.assertStoredProposal(input.proposal);
    const candidate: ActionRuleCandidate = {
      id: randomUUID(), proposalId: proposal.id, operation: proposal.operation,
      accountHash: proposal.accountHash, payloadHash: proposal.payloadHash,
      proposalHash: proposal.proposalHash, effect: input.effect,
      ownerId: normalizeRequired(input.ownerId ?? proposal.ownerId, "ownerId", 120),
      expiresAt: normalizeExpiry(input.expiresAt),
      reason: normalizeRequired(input.reason ?? "Explicit action policy candidate", "reason", 2_000),
      status: "pending", createdAt: this.now(), approvedBy: null, approvalEvidence: null, approvedAt: null,
    };
    this.db.prepare(`
      INSERT INTO action_rule_candidates
        (id, proposal_id, operation, account_hash, payload_hash, proposal_hash, effect, owner_id, expires_at, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      candidate.id, candidate.proposalId, candidate.operation, candidate.accountHash,
      candidate.payloadHash, candidate.proposalHash, candidate.effect, candidate.ownerId,
      candidate.expiresAt, candidate.reason, candidate.createdAt,
    );
    return candidate;
  }

  getCandidate(id: string): ActionRuleCandidate | null {
    const row = this.db.prepare(`SELECT * FROM action_rule_candidates WHERE id = ?`).get(id);
    return row === undefined ? null : candidateFromRow(row);
  }

  listCandidates(options: { status?: ActionRuleCandidateStatus } = {}): ActionRuleCandidate[] {
    const status = options.status;
    if (status !== undefined && !ACTION_RULE_CANDIDATE_STATUSES.includes(status)) {
      throw new Error("Unknown action policy candidate status");
    }
    const rows = status === undefined
      ? this.db.prepare(`SELECT * FROM action_rule_candidates ORDER BY created_at ASC, id ASC`).all()
      : this.db.prepare(`SELECT * FROM action_rule_candidates WHERE status = ? ORDER BY created_at ASC, id ASC`).all(status);
    return rows.map(candidateFromRow);
  }

  rejectCandidate(candidateId: string): ActionRuleCandidate {
    return this.transaction(() => {
      const candidate = this.getCandidate(candidateId);
      if (candidate === null) throw new Error("Action policy candidate was not found");
      if (candidate.status !== "pending") throw new Error("Action policy candidate is no longer pending");
      this.db.prepare(`UPDATE action_rule_candidates SET status = 'rejected' WHERE id = ? AND status = 'pending'`).run(candidate.id);
      return this.getCandidate(candidate.id) ?? (() => { throw new Error("Action policy candidate disappeared"); })();
    });
  }

  promoteCandidate(candidateId: string, approval: ActionApprovalEvidence): ActionRule {
    const binding = normalizeApprovalEvidence(approval);
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM action_rule_candidates WHERE id = ?`).get(candidateId);
      if (row === undefined) throw new Error("Action policy candidate was not found");
      const candidate = candidateFromRow(row);
      if (candidate.status !== "pending") throw new Error("Action policy candidate is no longer pending");
      const proposal = this.assertStoredProposal(candidate.proposalId);
      if (proposal.proposalHash !== candidate.proposalHash || proposal.payloadHash !== candidate.payloadHash) {
        throw new Error("Action policy candidate no longer matches its proposal");
      }
      const latest = this.db.prepare(`
        SELECT MAX(version) AS version FROM action_rules
        WHERE operation = ? AND account_hash = ? AND payload_hash = ? AND owner_id = ?
      `).get(candidate.operation, candidate.accountHash, candidate.payloadHash, candidate.ownerId);
      const version = numberFromRow(latest, "version", 0) + 1;
      const rule: ActionRule = {
        id: randomUUID(), version, operation: candidate.operation,
        accountHash: candidate.accountHash, payloadHash: candidate.payloadHash,
        effect: candidate.effect, ownerId: candidate.ownerId, expiresAt: candidate.expiresAt,
        state: "active", createdAt: this.now(), revokedAt: null,
        approvedBy: binding.approvedBy, approvalEvidence: binding.approvalEvidence, approvedAt: binding.approvedAt,
      };
      this.db.prepare(`
        INSERT INTO action_rules
          (id, version, operation, account_hash, payload_hash, effect, owner_id, expires_at, state, created_at, revoked_at, approved_by, approval_evidence, approved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, ?)
      `).run(
        rule.id, rule.version, rule.operation, rule.accountHash, rule.payloadHash,
        rule.effect, rule.ownerId, rule.expiresAt, rule.createdAt,
        rule.approvedBy, rule.approvalEvidence, rule.approvedAt,
      );
      this.db.prepare(`
        UPDATE action_rule_candidates
        SET status = 'promoted', approved_by = ?, approval_evidence = ?, approved_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(binding.approvedBy, binding.approvalEvidence, binding.approvedAt, candidate.id);
      return rule;
    });
  }

  /** Promote a candidate returned by prepareCandidate. */
  promote(candidate: ActionRuleCandidate | string, approval: ActionApprovalEvidence): ActionRule {
    return this.promoteCandidate(typeof candidate === "string" ? candidate : candidate.id, approval);
  }

  authorizeOnce(proposal: ActionProposal, approval: ActionApprovalEvidence): ActionAuthorization {
    const stored = this.assertStoredProposal(proposal);
    const binding = normalizeApprovalEvidence(approval);
    const authorization: ActionAuthorization = {
      id: randomUUID(),
      proposalId: stored.id,
      proposalHash: stored.proposalHash,
      ownerId: stored.ownerId,
      state: "active",
      approvedBy: binding.approvedBy,
      approvalEvidence: binding.approvalEvidence,
      approvedAt: binding.approvedAt,
      createdAt: this.now(),
      consumedAt: null,
      revokedAt: null,
    };
    this.db.prepare(`
      INSERT INTO action_authorizations
        (id, proposal_id, proposal_hash, owner_id, state, approved_by, approval_evidence, approved_at, created_at, consumed_at, revoked_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, NULL)
    `).run(
      authorization.id, authorization.proposalId, authorization.proposalHash,
      authorization.ownerId, authorization.approvedBy, authorization.approvalEvidence,
      authorization.approvedAt, authorization.createdAt,
    );
    return authorization;
  }

  getAuthorization(id: string): ActionAuthorization | null {
    const row = this.db.prepare(`SELECT * FROM action_authorizations WHERE id = ?`).get(id);
    return row === undefined ? null : authorizationFromRow(row);
  }

  consumeAuthorization(
    id: string,
    actual: ActionExecutionInput,
    options: { now?: number } = {},
  ): ActionPolicyDecision {
    return this.transaction(() => {
      const authorization = this.getAuthorization(id);
      if (authorization === null) return decision("", "deny", null, null, "One-time authorization was not found");
      if (authorization.state !== "active") {
        return decision(authorization.proposalHash, "deny", null, null, "One-time authorization is no longer active");
      }
      const stored = this.assertStoredProposal(authorization.proposalId);
      let candidate: ActionProposal;
      try {
        candidate = isActionProposal(actual) ? actual : this.materializeWithoutPersist(actual, stored.id);
      } catch {
        return decision(stored.proposalHash, "deny", null, null, "Execution payload is not valid JSON");
      }
      const actualIsProposal = isActionProposal(actual);
      if (
        !isSelfConsistentProposal(candidate) ||
        (actualIsProposal && candidate.id !== stored.id) ||
        candidate.operation !== stored.operation ||
        candidate.accountHash !== stored.accountHash ||
        candidate.payloadHash !== stored.payloadHash ||
        candidate.proposalHash !== stored.proposalHash ||
        (actualIsProposal && candidate.ownerId !== stored.ownerId)
      ) {
        return decision(stored.proposalHash, "deny", null, null, "Execution does not match the one-time authorization");
      }
      const result = this.db.prepare(`
        UPDATE action_authorizations SET state = 'consumed', consumed_at = ?
        WHERE id = ? AND state = 'active'
      `).run(options.now ?? this.now(), authorization.id);
      if (result.changes !== 1) {
        return decision(stored.proposalHash, "deny", null, null, "One-time authorization was already consumed");
      }
      return decision(stored.proposalHash, "allow", null, null, "Exact one-time authorization consumed");
    });
  }

  revokeAuthorization(id: string): boolean {
    const result = this.db.prepare(`
      UPDATE action_authorizations SET state = 'revoked', revoked_at = ?
      WHERE id = ? AND state = 'active'
    `).run(this.now(), id);
    return result.changes === 1;
  }

  evaluate(proposal: ActionProposal, options: { now?: number } = {}): ActionPolicyDecision {
    const current = this.assertStoredProposal(proposal);
    const now = options.now ?? this.now();
    const rules = this.db.prepare(`
      SELECT * FROM action_rules
      WHERE operation = ? AND account_hash = ? AND payload_hash = ?
        AND owner_id = ?
        AND state = 'active' AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY version DESC
    `).all(current.operation, current.accountHash, current.payloadHash, current.ownerId, now).map(ruleFromRow);
    const selected = rules.sort((left, right) => {
      const precedence = effectPrecedence(right.effect) - effectPrecedence(left.effect);
      return precedence || right.version - left.version;
    })[0];
    if (selected === undefined) {
      return decision(current.proposalHash, "ask", null, null, "No exact active rule matched this action");
    }
    return decision(
      current.proposalHash, selected.effect, selected.id, selected.version,
      selected.effect === "deny" ? "An exact deny rule dominates this action" : `Matched exact rule v${selected.version}`,
    );
  }

  /**
   * Re-check an approved proposal against the bytes/account/operation that
   * are about to execute. This is the execution seam: a changed payload,
   * account, operation, revoked rule, or expired rule fails closed.
   */
  revalidate(approved: ActionProposal, actual: ActionExecutionInput, options: { now?: number } = {}): ActionPolicyDecision {
    const stored = this.assertStoredProposal(approved);
    const actualIsProposal = isActionProposal(actual);
    let actualProposal: ActionProposal;
    try {
      actualProposal = actualIsProposal
        ? actual
        : this.materializeWithoutPersist(actual, stored.id);
    } catch {
      return decision(stored.proposalHash, "deny", null, null, "Execution payload is not valid JSON");
    }
    if (
      !isSelfConsistentProposal(actualProposal) ||
      (actualIsProposal && actualProposal.id !== stored.id) ||
      actualProposal.operation !== stored.operation ||
      actualProposal.accountHash !== stored.accountHash ||
      actualProposal.payloadHash !== stored.payloadHash ||
      actualProposal.proposalHash !== stored.proposalHash ||
      (actualIsProposal && actualProposal.ownerId !== stored.ownerId)
    ) {
      return decision(stored.proposalHash, "deny", null, null, "Execution does not match the approved proposal");
    }
    const result = this.evaluate(stored, options);
    if (result.effect !== "allow") return result;
    return { ...result, reason: "Approved proposal matches execution exactly" };
  }

  revokeRule(ruleId: string): boolean {
    const result = this.db.prepare(`
      UPDATE action_rules SET state = 'revoked', revoked_at = ?
      WHERE id = ? AND state = 'active'
    `).run(this.now(), ruleId);
    return result.changes === 1;
  }

  revoke(ruleId: string): boolean {
    return this.revokeRule(ruleId);
  }

  listRules(options: { includeRevoked?: boolean } = {}): ActionRule[] {
    const rows = options.includeRevoked
      ? this.db.prepare(`SELECT * FROM action_rules ORDER BY operation, account_hash, payload_hash, version DESC`).all()
      : this.db.prepare(`SELECT * FROM action_rules WHERE state = 'active' ORDER BY operation, account_hash, payload_hash, version DESC`).all();
    return rows.map(ruleFromRow);
  }

  close(): void {
    this.db.close();
  }

  private assertStoredProposal(proposal: ActionProposal | string): ActionProposal {
    const found = typeof proposal === "string" ? this.getProposal(proposal) : this.getProposal(proposal.id);
    if (found === null) throw new Error("Action proposal was not found");
    if (
      typeof proposal !== "string" &&
      (found.operation !== proposal.operation || found.accountHash !== proposal.accountHash ||
        found.proposalHash !== proposal.proposalHash || found.payloadHash !== proposal.payloadHash ||
        !isSelfConsistentProposal(proposal))
    ) throw new Error("Action proposal hash does not match durable proposal");
    if (!isSelfConsistentProposal(found)) throw new Error("Stored action proposal failed integrity verification");
    return found;
  }

  private materializeWithoutPersist(input: ActionProposalInput, id: string): ActionProposal {
    const operation = normalizeRequired(input.operation, "operation", 240);
    const accountId = normalizeRequired(input.accountId, "accountId", 240);
    if (!isJsonValue(input.payload)) throw new Error("Action payload must be JSON-compatible");
    return {
      id, operation, accountId, accountHash: hashActionAccount(accountId), payload: input.payload,
      payloadHash: hashActionPayload(input.payload), proposalHash: hashActionProposal(operation, accountId, input.payload),
      ownerId: "execution", evidence: [], createdAt: 0,
    };
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function createActionPolicy(options: ActionPolicyOptions = {}): ActionPolicy {
  return new ActionPolicy(options);
}

export function canonicalizeActionPayload(value: JsonValue): string {
  if (!isJsonValue(value)) throw new Error("Action payload must be JSON-compatible");
  return canonicalJson(value);
}

export function hashActionPayload(value: JsonValue): string {
  return sha256(canonicalizeActionPayload(value));
}

export function hashActionAccount(accountId: string): string {
  return sha256(canonicalString(normalizeRequired(accountId, "accountId", 240)));
}

export function hashActionOperation(operation: string): string {
  return sha256(canonicalString(normalizeRequired(operation, "operation", 240)));
}

export function hashActionProposal(operation: string, accountId: string, payload: JsonValue): string {
  const normalizedOperation = normalizeRequired(operation, "operation", 240);
  const normalizedAccount = normalizeRequired(accountId, "accountId", 240);
  if (!isJsonValue(payload)) throw new Error("Action payload must be JSON-compatible");
  return sha256(canonicalJson({ operation: normalizedOperation, accountId: normalizedAccount, payload }));
}

function decision(
  proposalHash: string,
  effect: ActionPolicyEffect,
  ruleId: string | null,
  ruleVersion: number | null,
  reason: string,
): ActionPolicyDecision {
  return {
    effect, decision: effect, allowed: effect === "allow", requiresApproval: effect === "ask",
    proposalHash, ruleId, ruleVersion, reason,
  };
}

function effectPrecedence(effect: ActionPolicyEffect): number {
  switch (effect) {
    case "deny": return 4;
    case "draft-only": return 3;
    case "ask": return 2;
    case "allow": return 1;
    default: return assertNever(effect);
  }
}

function isActionProposal(value: unknown): value is ActionProposal {
  return typeof value === "object" && value !== null && "proposalHash" in value && "payloadHash" in value && "accountHash" in value;
}

function proposalFromRow(value: unknown): ActionProposal {
  const row = rowObject(value);
  const payload = parseStoredPayload(row.payload_json);
  return {
    id: textColumn(row, "id"), operation: textColumn(row, "operation"), accountId: textColumn(row, "account_id"),
    accountHash: textColumn(row, "account_hash"), payload, payloadHash: textColumn(row, "payload_hash"),
    proposalHash: textColumn(row, "proposal_hash"), ownerId: textColumn(row, "owner_id"),
    evidence: parseEvidence(row.evidence_json), createdAt: numberColumn(row, "created_at"),
  };
}

function candidateFromRow(value: unknown): ActionRuleCandidate {
  const row = rowObject(value);
  const effect = effectColumn(row.effect);
  const status = statusColumn(row.status);
  return {
    id: textColumn(row, "id"), proposalId: textColumn(row, "proposal_id"), operation: textColumn(row, "operation"),
    accountHash: textColumn(row, "account_hash"), payloadHash: textColumn(row, "payload_hash"), proposalHash: textColumn(row, "proposal_hash"),
    effect, ownerId: textColumn(row, "owner_id"), expiresAt: nullableNumber(row.expires_at), reason: textColumn(row, "reason"),
    status, createdAt: numberColumn(row, "created_at"), approvedBy: nullableText(row.approved_by, "approved_by"),
    approvalEvidence: nullableText(row.approval_evidence, "approval_evidence"), approvedAt: nullableNumber(row.approved_at),
  };
}

function authorizationFromRow(value: unknown): ActionAuthorization {
  const row = rowObject(value);
  const state = textColumn(row, "state");
  if (!isActionAuthorizationState(state)) {
    throw new Error("Invalid action authorization state");
  }
  return {
    id: textColumn(row, "id"),
    proposalId: textColumn(row, "proposal_id"),
    proposalHash: textColumn(row, "proposal_hash"),
    ownerId: textColumn(row, "owner_id"),
    state,
    approvedBy: textColumn(row, "approved_by"),
    approvalEvidence: textColumn(row, "approval_evidence"),
    approvedAt: numberColumn(row, "approved_at"),
    createdAt: numberColumn(row, "created_at"),
    consumedAt: nullableNumber(row.consumed_at),
    revokedAt: nullableNumber(row.revoked_at),
  };
}

function ruleFromRow(value: unknown): ActionRule {
  const row = rowObject(value);
  return {
    id: textColumn(row, "id"), version: numberColumn(row, "version"), operation: textColumn(row, "operation"),
    accountHash: textColumn(row, "account_hash"), payloadHash: textColumn(row, "payload_hash"), effect: effectColumn(row.effect),
    ownerId: textColumn(row, "owner_id"), expiresAt: nullableNumber(row.expires_at), state: ruleStateColumn(row.state),
    createdAt: numberColumn(row, "created_at"), revokedAt: nullableNumber(row.revoked_at),
    approvedBy: nullableText(row.approved_by, "approved_by"), approvalEvidence: nullableText(row.approval_evidence, "approval_evidence"),
    approvedAt: nullableNumber(row.approved_at),
  };
}

function rowObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid action policy row");
  return Object.fromEntries(Object.entries(value));
}

function textColumn(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`Invalid action policy ${name}`);
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`Invalid action policy ${name}`);
  return value;
}

function numberColumn(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid action policy ${name}`);
  return value;
}

function numberFromRow(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const row = rowObject(value);
  const candidate = row[name];
  return candidate === null || candidate === undefined ? fallback : numberColumn(row, name);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : typeof value === "number" && Number.isFinite(value) ? value : (() => { throw new Error("Invalid action policy timestamp"); })();
}

function parseStoredPayload(value: unknown): JsonValue {
  if (typeof value !== "string") throw new Error("Invalid stored action payload");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Invalid stored action payload"); }
  if (!isJsonValue(parsed)) throw new Error("Invalid stored action payload");
  return parsed;
}

function parseEvidence(value: unknown): string[] {
  if (typeof value !== "string") throw new Error("Invalid stored action evidence");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Invalid stored action evidence"); }
  if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === "string")) throw new Error("Invalid stored action evidence");
  return [...parsed];
}

function effectColumn(value: unknown): ActionPolicyEffect {
  if (!isActionPolicyEffect(value)) throw new Error("Invalid action policy effect");
  return value;
}

function isActionPolicyEffect(value: unknown): value is ActionPolicyEffect {
  return value === "allow" || value === "ask" || value === "deny" || value === "draft-only";
}

function statusColumn(value: unknown): ActionRuleCandidate["status"] {
  if (value === "pending" || value === "promoted" || value === "rejected") return value;
  throw new Error("Invalid action policy candidate status");
}

function ruleStateColumn(value: unknown): ActionPolicyRuleState {
  if (value === "active" || value === "revoked") return value;
  throw new Error("Invalid action policy rule state");
}

function normalizeRequired(value: string, name: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > max) throw new Error(`${name} must be non-empty and at most ${max} characters`);
  return normalized;
}

function normalizeExpiry(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value <= 0) throw new Error("expiresAt must be a positive timestamp");
  return Math.round(value);
}

function normalizeApprovalEvidence(value: ActionApprovalEvidence): ActionApprovalEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Action policy promotion requires explicit approval evidence");
  }
  return {
    approvedBy: normalizeRequired(value.approvedBy, "approvedBy", 300),
    approvalEvidence: normalizeRequired(value.approvalEvidence, "approvalEvidence", 2_000),
    approvedAt: normalizeTimestamp(value.approvedAt, "approvedAt"),
  };
}

function normalizeTimestamp(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive timestamp`);
  return Math.round(value);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = columns.some((value) => rowObject(value).name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function isBroadToken(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.toLowerCase() === "any";
}

function canonicalString(value: string): string {
  return JSON.stringify(value);
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Action payload numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
      ? Object.values(value).every((item) => isJsonValue(item, seen))
      : false;
  seen.delete(value);
  return valid;
}

function isSelfConsistentProposal(value: ActionProposal): boolean {
  try {
    return hashActionPayload(value.payload) === value.payloadHash &&
      hashActionProposal(value.operation, value.accountId, value.payload) === value.proposalHash &&
      hashActionAccount(value.accountId) === value.accountHash;
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertNever(value: never): never {
  throw new Error(`Unexpected action policy effect: ${String(value)}`);
}
