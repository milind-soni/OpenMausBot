import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { conversationLanguage, serverLine } from "./server-lines.ts";

export type ReplaySite = "computer-continuation" | "direct-quota" | "peer-limit" | "startup-refusal" | "quota-card" | "quick-model" | "saved-steps" | "routine-recovery" | "chief-retry" | "held-request";
export type ReplayRef = { logicalTaskId: string; generation: string };
export type ActionStatus = "reserved" | "dispatched" | "confirmed" | "unknown";
export interface ActionRecord {
  id: string;
  action: string;
  generation: string;
  owner: string;
  scope: string;
  kind: "read" | "effect";
  status: ActionStatus;
  receipt: "completed" | "failed" | null;
  providerReceipt: string | null;
  created: number;
  updated: number;
}
export type ReplayScope = { owner: string; threadId: string; approval: string; tools: unknown; workspace: string; authority: unknown };
type Attempt = { generation: string; owner: string; thread: string; scope: string; evidence: string; outcome: string; next: string | null; predecessor: string | null };
type Attribution = { configuredInstance: string; configuredModel: string; requestId?: string };
export const REPLAY_BLOCKED = serverLine(undefined, "server.replay.blocked");
export const replayBlocked = (threadId?: string | null): string =>
  threadId ? serverLine(conversationLanguage(threadId), "server.replay.blocked") : REPLAY_BLOCKED;
type ReplayDispatch = { replay?: ReplayRef; peerLimitResent?: boolean; automaticRecoveryAttempted?: boolean;
  automaticRecoveryIndex?: number; computerSelectionContinuation?: boolean; recoveringCoordination?: boolean };

/** Three states. A (positive no-dispatch evidence, or a claimed continuation with a full accounting) is admitted;
 * B (a recorded dispatch or action) and C (missing, unknown or inconsistent history) are refused here and in replayGuard. */
export function requireReplayAdmission(dispatch: ReplayDispatch | undefined, reusedRequest = false, priorDispatch = false, threadId?: string, continuationClaimed = false): void {
  // A claimed Auto-VM continuation reuses its request by design; every other recovery flag still needs an admitted replay.
  if (continuationClaimed && dispatch?.computerSelectionContinuation) reusedRequest = priorDispatch = false;
  if (!dispatch?.replay && (reusedRequest || priorDispatch || dispatch?.peerLimitResent || dispatch?.automaticRecoveryAttempted ||
      dispatch?.automaticRecoveryIndex !== undefined || (dispatch?.computerSelectionContinuation && !continuationClaimed) || dispatch?.recoveringCoordination)) {
    throw Object.assign(new Error(replayBlocked(threadId)), { status: 409 });
  }
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createReplayLedger(file: string) {
  if (file !== ":memory:") closeSync(openSync(file, "a", 0o600));
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout=5000;
    PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS replay_tasks (id TEXT PRIMARY KEY, generation TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS replay_attempts (
      id TEXT NOT NULL, generation TEXT NOT NULL, predecessor TEXT, next TEXT,
      owner TEXT NOT NULL, thread TEXT NOT NULL, scope TEXT NOT NULL,
      configuredInstance TEXT NOT NULL, configuredModel TEXT NOT NULL, servingModel TEXT NOT NULL DEFAULT 'unknown',
      requestId TEXT, providerTurnId TEXT,
      evidence TEXT NOT NULL DEFAULT 'preparing', outcome TEXT NOT NULL DEFAULT 'pending', execution TEXT,
      quota TEXT, site TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY (id, generation)
    );
    CREATE INDEX IF NOT EXISTS replay_attempts_thread ON replay_attempts (thread);
    CREATE INDEX IF NOT EXISTS replay_attempts_request ON replay_attempts (thread, requestId);
    CREATE TABLE IF NOT EXISTS replay_actions (
      id TEXT NOT NULL, action TEXT NOT NULL, generation TEXT NOT NULL, owner TEXT NOT NULL, scope TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, receipt TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      dispatchKey TEXT, providerReceipt TEXT,
      PRIMARY KEY (id, action)
    );
    CREATE TABLE IF NOT EXISTS replay_decisions (
      id TEXT NOT NULL, generation TEXT NOT NULL, site TEXT NOT NULL, decision TEXT NOT NULL, at INTEGER NOT NULL
    );
  `);
  function atomic<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const attempt = (id: string, generation: string) => db.prepare("SELECT * FROM replay_attempts WHERE id=? AND generation=?").get(id, generation) as Attempt | undefined;
  const current = (id: string) => db.prepare("SELECT generation FROM replay_tasks WHERE id=?").get(id)?.generation;
  function isAdmitted(ref: ReplayRef, thread: string): boolean {
    const row = attempt(ref.logicalTaskId, ref.generation);
    return row?.thread === thread && row.evidence === "admitted" && row.outcome === "pending" &&
      current(ref.logicalTaskId) === ref.generation && latest(thread)?.logicalTaskId === ref.logicalTaskId;
  }
  function begin(ref: ReplayRef, scope: ReplayScope, model: Attribution, requireAdmission = false): boolean {
    const { logicalTaskId: id, generation } = ref;
    return atomic(() => {
      const existing = current(id);
      const row = existing === generation ? attempt(id, generation) : undefined;
      const now = Date.now();
      if (existing !== undefined) {
        if (!row || !isAdmitted(ref, scope.threadId) || row.scope !== digest(scope)) return false;
        db.prepare("UPDATE replay_attempts SET evidence='preparing', configuredInstance=?, configuredModel=?, requestId=COALESCE(?, requestId), updated=? WHERE id=? AND generation=?")
          .run(model.configuredInstance, model.configuredModel, model.requestId ?? null, now, id, generation);
      } else {
        if (requireAdmission) return false;
        db.prepare("INSERT INTO replay_tasks VALUES (?,?)").run(id, generation);
        db.prepare("INSERT INTO replay_attempts (id,generation,owner,thread,scope,configuredInstance,configuredModel,requestId,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(id, generation, scope.owner, scope.threadId, digest(scope), model.configuredInstance, model.configuredModel, model.requestId ?? null, now, now);
      }
      return true;
    });
  }
  function markSubmitted(ref: ReplayRef, execution: unknown, scope?: ReplayScope): boolean {
    const id = ref.logicalTaskId, fingerprint = digest(execution);
    return atomic(() => {
      const row = attempt(id, ref.generation);
      if (!row || current(id) !== ref.generation || latest(row.thread)?.logicalTaskId !== id || (scope && row.scope !== digest(scope))) return false;
      const previous = row.predecessor && db.prepare("SELECT execution FROM replay_attempts WHERE id=? AND generation=?").get(id, row.predecessor)?.execution;
      if (previous && previous !== fingerprint) return false;
      return db.prepare("UPDATE replay_attempts SET evidence='submitted',execution=?,updated=? WHERE id=? AND generation=? AND evidence='preparing'")
        .run(fingerprint, Date.now(), id, ref.generation).changes === 1;
    });
  }
  function hasAction(id: string): boolean {
    return Boolean(db.prepare("SELECT 1 FROM replay_actions WHERE id=? LIMIT 1").get(id));
  }
  function hasDispatchedForRequest(thread: string, requestId: string, advancesGoal = false): boolean {
    return Boolean(db.prepare(`SELECT 1 FROM replay_attempts AS attempt
      JOIN replay_actions AS action ON action.id=attempt.id
      WHERE attempt.thread=? AND attempt.requestId=? AND (?=0 OR attempt.outcome!='complete')
      AND action.status IN ('dispatched','confirmed','unknown') LIMIT 1`).get(thread, requestId, Number(advancesGoal)));
  }
  function hasRequest(thread: string, requestId: string): boolean {
    return Boolean(db.prepare("SELECT 1 FROM replay_attempts WHERE thread=? AND requestId=? LIMIT 1").get(thread, requestId));
  }
  function finish(ref: ReplayRef, outcome: "failed" | "complete" | "interrupted", evidence: "confirmed:no-dispatch" | "uncertain", quota?: string): boolean {
    return atomic(() => {
      const now = Date.now(), { logicalTaskId: id, generation } = ref;
      const row = attempt(id, generation);
      if (row?.outcome !== "pending") return false;
      if (outcome === "failed" && row.evidence === "preparing") evidence = "confirmed:no-dispatch";
      if (hasAction(id)) evidence = "uncertain";
      if (quota && outcome === "failed" && evidence === "uncertain") outcome = "interrupted";
      if (outcome !== "complete") db.prepare("UPDATE replay_actions SET status='unknown',updated=? WHERE id=? AND generation=? AND status='dispatched'").run(now, id, generation);
      return db.prepare("UPDATE replay_attempts SET outcome=?,evidence=?,quota=?,updated=? WHERE id=? AND generation=? AND outcome='pending'")
        .run(outcome, evidence, quota ?? null, now, id, generation).changes === 1;
    });
  }
  function bindProviderTurn(ref: ReplayRef, turnId: string): void {
    db.prepare("UPDATE replay_attempts SET providerTurnId=? WHERE id=? AND generation=? AND providerTurnId IS NULL")
      .run(digest(turnId), ref.logicalTaskId, ref.generation);
  }
  function servingModel(ref: ReplayRef, model: string): void {
    if (/^[\w./:@-]{1,160}$/.test(model)) db.prepare("UPDATE replay_attempts SET servingModel=?,updated=? WHERE id=? AND generation=? AND outcome='pending'")
      .run(model, Date.now(), ref.logicalTaskId, ref.generation);
  }
  function reserveAction(ref: ReplayRef, actionId: string, kind: "read" | "effect"): boolean {
    return atomic(() => {
      const id = ref.logicalTaskId;
      const row = attempt(id, ref.generation);
      if (current(id) !== ref.generation || row?.outcome !== "pending") return false;
      const now = Date.now();
      return db.prepare("INSERT OR IGNORE INTO replay_actions (id,action,generation,owner,scope,kind,status,created,updated) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, digest(actionId), ref.generation, row.owner, row.scope, kind, "reserved", now, now).changes === 1;
    });
  }
  function actionState(ref: ReplayRef, actionId: string, status: Exclude<ActionStatus, "reserved">, receipt?: "completed" | "failed"): boolean {
    const predecessor = status === "dispatched" ? "reserved" : "dispatched";
    if ((status === "confirmed") !== Boolean(receipt)) return false;
    return db.prepare(`UPDATE replay_actions SET status=?,receipt=?,updated=? WHERE id=? AND action=? AND generation=?
      AND (status=? OR (status='unknown' AND ?='confirmed'))`)
      .run(status, receipt ?? null, Date.now(), ref.logicalTaskId, digest(actionId), ref.generation, predecessor, status).changes === 1;
  }
  function authorizeNativeAction(ref: ReplayRef, actionId: string, kind: "read" | "effect", signature: unknown): boolean {
    return atomic(() => {
      const id = ref.logicalTaskId, action = digest(actionId), key = digest(signature);
      const row = attempt(id, ref.generation);
      if (current(id) !== ref.generation || row?.outcome !== "pending") return false;
      const now = Date.now();
      db.prepare(`INSERT OR IGNORE INTO replay_actions (id,action,generation,owner,scope,kind,status,created,updated)
        VALUES (?,?,?,?,?,?,'reserved',?,?)`).run(id, action, ref.generation, row.owner, row.scope, kind, now, now);
      return db.prepare(`UPDATE replay_actions SET status='dispatched',dispatchKey=?,updated=?
        WHERE id=? AND action=? AND generation=? AND kind=? AND dispatchKey IS NULL AND status IN ('reserved','dispatched')`)
        .run(key, now, id, action, ref.generation, kind).changes === 1;
    });
  }
  function actionReceipt(ref: ReplayRef, actionId: string, outcome: "completed" | "failed", source: "native-hook" | "provider-event" | "bridge-response"): boolean {
    const id = ref.logicalTaskId, action = digest(actionId);
    const changed = db.prepare(`UPDATE replay_actions SET status='confirmed',receipt=?,providerReceipt=?,updated=?
      WHERE id=? AND action=? AND generation=? AND status IN ('dispatched','unknown')`)
      .run(outcome, source, Date.now(), id, action, ref.generation).changes;
    return changed === 1 || Boolean(db.prepare("SELECT 1 FROM replay_actions WHERE id=? AND action=? AND generation=? AND status='confirmed' AND receipt=?")
      .get(id, action, ref.generation, outcome));
  }
  function reconcileInterrupted(): void {
    atomic(() => {
      const now = Date.now();
      db.prepare("UPDATE replay_actions SET status='unknown',updated=? WHERE status='dispatched'").run(now);
      // Every adapter dispatch must first durably leave the preparing state.
      db.prepare(`UPDATE replay_attempts SET outcome='failed',evidence='confirmed:no-dispatch',updated=?
        WHERE outcome='pending' AND evidence='preparing'
        AND NOT EXISTS (SELECT 1 FROM replay_actions WHERE replay_actions.id=replay_attempts.id)`).run(now);
      db.prepare("UPDATE replay_attempts SET outcome='interrupted',evidence='uncertain',updated=? WHERE outcome='pending'").run(now);
    });
  }
  function latest(thread: string): ReplayRef | undefined {
    const row = db.prepare(`SELECT a.id AS logicalTaskId,a.generation FROM replay_attempts a JOIN replay_tasks t
      ON t.id=a.id AND t.generation=a.generation WHERE a.thread=? ORDER BY a.rowid DESC LIMIT 1`).get(thread);
    return row as ReplayRef | undefined;
  }
  function positiveEvidence(ref: ReplayRef): boolean {
    const row = attempt(ref.logicalTaskId, ref.generation);
    return row?.evidence === "confirmed:no-dispatch" && row.outcome === "failed" &&
      !hasAction(ref.logicalTaskId);
  }
  function latestForTask(logicalTaskId: string): ReplayRef | undefined {
    const generation = current(logicalTaskId);
    return typeof generation === "string" ? { logicalTaskId, generation } : undefined;
  }
  function replayGuard(logicalTaskId: string, generation: string, site: ReplaySite, scope: ReplayScope): ReplayRef | undefined {
    return atomic(() => {
      const row = attempt(logicalTaskId, generation);
      const decision = !row ? "missing-evidence" : current(logicalTaskId) !== generation || latest(row.thread)?.logicalTaskId !== logicalTaskId ? "superseded"
        : row.scope !== digest(scope) ? "scope-changed" : hasAction(logicalTaskId) ? "action-requires-reconciliation"
        : row.evidence !== "confirmed:no-dispatch" || row.outcome !== "failed" ? "no-positive-evidence" : "admitted";
      const now = Date.now();
      db.prepare("INSERT INTO replay_decisions VALUES (?,?,?,?,?)").run(logicalTaskId, generation, site, decision, now);
      if (decision !== "admitted") {
        if (row?.outcome === "failed" && decision !== "superseded") db.prepare("UPDATE replay_attempts SET outcome='interrupted',updated=? WHERE id=? AND generation=?").run(now, logicalTaskId, generation);
        return;
      }
      const next = randomUUID();
      db.prepare("UPDATE replay_tasks SET generation=? WHERE id=? AND generation=?").run(next, logicalTaskId, generation);
      db.prepare("UPDATE replay_attempts SET next=?,updated=? WHERE id=? AND generation=?").run(next, now, logicalTaskId, generation);
      db.prepare(`INSERT INTO replay_attempts (id,generation,predecessor,owner,thread,scope,configuredInstance,configuredModel,requestId,evidence,site,created,updated)
        SELECT id,?,generation,owner,thread,scope,configuredInstance,configuredModel,requestId,'admitted',?,?,? FROM replay_attempts WHERE id=? AND generation=?`)
        .run(next, site, now, now, logicalTaskId, generation);
      return { logicalTaskId, generation: next };
    });
  }
  /** Auto-VM continuation is a new turn after a completed one, not a replay: admitted only when that turn completed and
   * every action it recorded has a receipt (no reserved, dispatched or unknown action). The claim is a compare-and-set on
   * `next`, so one completed turn yields at most one continuation, and consumeContinuation spends it exactly once. */
  function claimContinuation(ref: ReplayRef, thread: string): string | undefined {
    return atomic(() => {
      const { logicalTaskId: id, generation } = ref, row = attempt(id, generation), now = Date.now();
      const open = db.prepare("SELECT 1 FROM replay_actions WHERE id=? AND status!='confirmed' LIMIT 1").get(id);
      const decision = !row || row.thread !== thread ? "missing-evidence"
        : current(id) !== generation || latest(thread)?.logicalTaskId !== id || row.next !== null ? "superseded"
        : row.outcome !== "complete" ? "no-positive-evidence" : open ? "action-requires-reconciliation" : "admitted";
      db.prepare("INSERT INTO replay_decisions VALUES (?,?,?,?,?)").run(id, generation, "computer-continuation", decision, now);
      if (decision !== "admitted") return;
      const token = randomUUID();
      return db.prepare("UPDATE replay_attempts SET next=?,updated=? WHERE id=? AND generation=? AND next IS NULL")
        .run(`continuation:${token}`, now, id, generation).changes === 1 ? token : undefined;
    });
  }
  function consumeContinuation(ref: ReplayRef, token: string): boolean {
    return db.prepare("UPDATE replay_attempts SET next=?,updated=? WHERE id=? AND generation=? AND next=?")
      .run(`continued:${token}`, Date.now(), ref.logicalTaskId, ref.generation, `continuation:${token}`).changes === 1;
  }
  return { claimContinuation, consumeContinuation, begin, markSubmitted, finish, bindProviderTurn, servingModel, reserveAction, actionState, authorizeNativeAction, actionReceipt, reconcileInterrupted, replayGuard, latest, latestForTask, positiveEvidence, hasRequest, hasDispatchedForRequest, isAdmitted, close: () => db.close() };
}
