import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { ApprovalMode } from "../shared/approval-mode.ts";
import type { EffortLevel } from "../shared/wire.ts";
import type { ToolScope } from "../shared/tool-scope.ts";

import type { RuntimeStore } from "./runtime/store.ts";
import type { Assignment, OfficeAttempt } from "./runtime/types.ts";
import { terminal } from "./runtime/types.ts";

export const OFFICE_WORK_MS = 30 * 60_000;
export const OFFICE_START_MS = 30_000;
export const OFFICE_REPORT_MS = 60_000;

export interface OfficePrepareInput {
  botId: string;
  threadId: string;
  cwd: string;
  instanceId: string;
  driverKind: string;
  signal: AbortSignal;
  model?: string;
  effort?: EffortLevel;
  variant?: string;
  approvalMode?: ApprovalMode;
  toolScope?: ToolScope;
}

export interface OfficeBinding {
  assignmentId: string;
  generation: string;
  profileDigest: string;
}

export interface OfficeDirectiveRequest {
  version: 1;
  attemptId: string;
  capability: string;
  workerId: string;
}

export interface OfficeControlLease {
  readonly attemptId: string;
  readonly signal: AbortSignal;
  readonly rootDeadline: number;
  readonly expiresAt: number;
  readonly kind: "work" | "report";
  assert(stage: "process" | "prompt" | "steer"): void;
  finish(outcome?: "completed" | "failed" | "cancelled" | "uncertain"): void;
}

export interface OfficeControlOptions {
  store: RuntimeStore;
  workerId: string;
  controllerHost?: string;
  resolve(input: OfficePrepareInput): OfficeBinding | undefined;
  requestDirective(request: OfficeDirectiveRequest, signal: AbortSignal): Promise<void>;
  cancelAssignment(assignmentId: string, reason: string): void;
  cancelNative(binding: OfficeBinding & { botId: string; threadId: string }, reason: string): void | Promise<void>;
  now?: () => number;
}

export type OfficeAttemptReceipt = Omit<OfficeAttempt, "capabilityHash">;
export type OfficeDirective = z.infer<typeof directiveSchema>;

const directiveSchema = z.strictObject({
  version: z.literal(1), attemptId: z.string(), generation: z.string(), digest: z.string(), workerId: z.string(),
  profileDigest: z.string(), cwd: z.string(), rootDeadline: z.number().finite(), startBefore: z.number().finite(),
  kind: z.enum(["work", "report"]), decision: z.enum(["allow", "deny"]),
  controllerHost: z.string(), controllerDecisionId: z.string().uuid(), policyVersion: z.literal("office-control-v1"),
});
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const assignmentDigest = (node: Assignment): string => sha256(JSON.stringify({ brief: node.brief, doneWhen: node.doneWhen,
  mode: node.mode, level: node.level, executions: node.executions }));
export const officeCwdMatches = (pinned: string | null | undefined, actual: string): boolean =>
  typeof pinned === "string" && isAbsolute(pinned) && isAbsolute(actual) && resolvePath(pinned) === resolvePath(actual);
export const officeProfileMatches = (actual: Pick<OfficePrepareInput, "instanceId" | "model" | "effort" | "variant" | "approvalMode" | "toolScope">,
  expected: Pick<OfficePrepareInput, "instanceId" | "model" | "effort" | "variant" | "approvalMode" | "toolScope">): boolean =>
  actual.instanceId === expected.instanceId && actual.model === expected.model && actual.effort === expected.effort
  && actual.variant === expected.variant && actual.approvalMode === expected.approvalMode
  && (actual.toolScope === undefined) === (expected.toolScope === undefined)
  && JSON.stringify(actual.toolScope?.allow) === JSON.stringify(expected.toolScope?.allow)
  && JSON.stringify(actual.toolScope?.deny) === JSON.stringify(expected.toolScope?.deny);
const receipt = ({ capabilityHash: _hash, ...attempt }: OfficeAttempt): OfficeAttemptReceipt => attempt;
const sameSecret = (capability: string, hash: string): boolean => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability) || !/^[a-f0-9]{64}$/.test(hash)) return false;
  return timingSafeEqual(Buffer.from(sha256(capability), "hex"), Buffer.from(hash, "hex"));
};

interface LiveAttempt {
  binding: OfficeBinding;
  input: OfficePrepareInput;
  controller: AbortController;
  cleanup(): void;
}

export class OfficeControl {
  private readonly options: OfficeControlOptions;
  private readonly now: () => number;
  private readonly live = new Map<string, LiveAttempt>();
  private closed = false;

  constructor(options: OfficeControlOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async prepare(input: OfficePrepareInput): Promise<OfficeControlLease> {
    input = { ...input, ...(input.toolScope ? { toolScope: structuredClone(input.toolScope) } : {}) };
    if (this.closed || input.signal.aborted) throw new Error("Office execution was stopped");
    if (input.driverKind !== "codex") throw new Error("Office execution requires the selected Codex driver");
    if (!isAbsolute(input.cwd)) throw new Error("Office execution requires an absolute working directory");
    const binding = this.options.resolve(input);
    if (!binding || !/^[a-f0-9]{64}$/.test(binding.profileDigest)) throw new Error("Office execution has no current native assignment or selected profile");
    const capability = randomBytes(32).toString("base64url");
    const attempt = this.options.store.transaction(() => {
      const node = this.options.store.get(binding.assignmentId);
      if (!node || node.status !== "running" || node.assignee.botId !== input.botId || node.assignee.destination.threadId !== input.threadId) {
        throw new Error("Office execution does not match the running native assignment");
      }
      if (this.options.store.all({ assignee: { botId: input.botId, threadId: input.threadId } }).some(row =>
        row.office?.attempts.some(value => value.state === "uncertain"
          || ((value.state === "consumed" || value.consumedAt !== undefined) && value.finishedAt === undefined)))) {
        throw new Error("An earlier native execution is uncertain; replacement remains closed");
      }
      const root = this.options.store.root(node.id);
      if (!root?.office || !node.office || node.office.rootDeadline !== root.office.rootDeadline) throw new Error("Office execution has no fixed native deadline");
      const now = this.now();
      const kind = now >= root.office.rootDeadline ? "report" as const : "work" as const;
      if (kind === "report" && (node.id !== root.id || !root.office.reportUntil || now >= root.office.reportUntil || root.office.reportStarted)) {
        throw new Error("The fixed office work deadline expired");
      }
      if (node.office.attempts.some(value => ["prepared", "issued", "uncertain"].includes(value.state) || (value.state === "consumed" && value.finishedAt === undefined))) {
        throw new Error("A native office attempt already exists or has uncertain execution");
      }
      const immutable = {
        version: 1 as const, attemptId: randomUUID(), assignmentId: node.id, rootId: root.id, botId: input.botId,
        threadId: input.threadId, generation: binding.generation, workerId: this.options.workerId, profileDigest: binding.profileDigest,
        instanceId: input.instanceId, driverKind: input.driverKind, profileId: input.botId,
        assignmentDigest: assignmentDigest(node),
        cwd: resolvePath(input.cwd), rootDeadline: root.office.rootDeadline,
        startBefore: Math.min(now + OFFICE_START_MS, kind === "work" ? root.office.rootDeadline : root.office.reportUntil!), kind,
      };
      const prepared: OfficeAttempt = { ...immutable, digest: sha256(JSON.stringify(immutable)), capabilityHash: sha256(capability), state: "prepared", preparedAt: now };
      node.office.attempts.push(prepared);
      if (kind === "report") node.office.reportStarted = true;
      this.options.store.update(node);
      return prepared;
    });
    const controller = new AbortController();
    const abort = () => this.invalidate({ attemptId: attempt.attemptId }, "Office execution was stopped");
    input.signal.addEventListener("abort", abort, { once: true });
    const expiresAt = attempt.kind === "report" ? this.options.store.root(attempt.assignmentId)!.office!.reportUntil! : attempt.rootDeadline;
    const timer = setTimeout(() => this.invalidate({ attemptId: attempt.attemptId }, "The fixed office execution deadline expired"), Math.max(0, expiresAt - this.now()));
    timer.unref?.();
    const live: LiveAttempt = { binding, input, controller, cleanup: () => { clearTimeout(timer); input.signal.removeEventListener("abort", abort); } };
    this.live.set(attempt.attemptId, live);
    const finish = (outcome?: "completed" | "failed" | "cancelled" | "uncertain") => {
      const assignmentId = attempt.assignmentId;
      if (this.live.get(attempt.attemptId) === live) { live.cleanup(); this.live.delete(attempt.attemptId); }
      this.options.store.transaction(() => {
        const stored = this.find(attempt.attemptId, assignmentId);
        if (!stored) return;
        if (outcome === "uncertain") {
          stored.attempt.state = "uncertain"; delete stored.attempt.finishedAt;
        } else if (outcome === "cancelled") {
          stored.attempt.state = "cancelled"; stored.attempt.cancelledAt = this.now(); stored.attempt.finishedAt = this.now();
        } else if (stored.attempt.state === "consumed" || (stored.attempt.state === "uncertain" && outcome === "completed")) {
          stored.attempt.state = "consumed"; stored.attempt.finishedAt = this.now();
        }
        else if (stored.attempt.state === "prepared" || stored.attempt.state === "issued") {
          stored.attempt.state = "cancelled"; stored.attempt.cancelledAt = this.now();
        }
        this.options.store.update(stored.node);
      });
      if (outcome === "cancelled") controller.abort(new Error("Office execution was stopped"));
    };
    try {
      await this.options.requestDirective({ version: 1, attemptId: attempt.attemptId, capability, workerId: attempt.workerId }, controller.signal);
      const stored = this.find(attempt.attemptId);
      if (controller.signal.aborted || !stored || stored.attempt.state !== "issued") throw new Error("The office directive was denied, expired, or not committed");
      this.check(stored.node, stored.attempt, live, expiresAt);
      let promptStarted = false;
      return {
        attemptId: attempt.attemptId, signal: controller.signal, rootDeadline: attempt.rootDeadline, expiresAt, kind: attempt.kind,
        assert: stage => {
          this.options.store.transaction(() => {
            const current = this.find(attempt.attemptId);
            if (!current) throw new Error("The office attempt no longer exists");
            this.check(current.node, current.attempt, live, expiresAt);
            if (stage === "process" && current.attempt.state !== "issued") throw new Error("The office directive was already consumed for a process start");
            if (stage === "prompt" && promptStarted) throw new Error("The office directive was already consumed for a prompt start");
            if (stage === "steer" && current.attempt.state !== "consumed") throw new Error("Office steering requires a started native turn");
            if (current.attempt.state === "issued") {
              if (current.attempt.controllerDecision?.decision !== "allow"
                || current.attempt.controllerDecision.controllerHost !== (this.options.controllerHost ?? "orch-hel1")
                || current.attempt.controllerDecision.policyVersion !== "office-control-v1") throw new Error("The office directive has no controller decision receipt");
              if (this.now() >= current.attempt.startBefore) throw new Error("The office directive start window expired");
              current.attempt.state = "consumed"; current.attempt.consumedAt = this.now();
              this.options.store.update(current.node);
            } else if (current.attempt.state !== "consumed" || current.attempt.finishedAt !== undefined) {
              throw new Error("The office directive is not available for consumption");
            }
            if (stage === "prompt") promptStarted = true;
          });
        },
        finish,
      };
    } catch {
      finish("cancelled");
      throw new Error("The office directive was denied, expired, cancelled, or not committed");
    }
  }

  readAttempt(attemptId: string, capability: string): OfficeAttemptReceipt | undefined {
    const stored = this.find(attemptId);
    if (!stored || !sameSecret(capability, stored.attempt.capabilityHash)) return undefined;
    return receipt(stored.attempt);
  }

  commitDirective(attemptId: string, capability: string, body: unknown): boolean {
    const parsed = directiveSchema.safeParse(body);
    if (!parsed.success) return false;
    return this.options.store.transaction(() => {
      const stored = this.find(attemptId);
      const live = this.live.get(attemptId);
      if (!stored || !live || !sameSecret(capability, stored.attempt.capabilityHash)) return false;
      const { attempt, node } = stored;
      const directive = parsed.data;
      if (attempt.state !== "prepared" || directive.attemptId !== attemptId || this.now() >= attempt.startBefore) return false;
      if (directive.controllerHost !== (this.options.controllerHost ?? "orch-hel1")) return false;
      for (const key of ["version", "generation", "digest", "workerId", "profileDigest", "cwd", "rootDeadline", "startBefore", "kind"] as const) {
        if (directive[key] !== attempt[key]) return false;
      }
      try { this.check(node, attempt, live, attempt.kind === "work" ? attempt.rootDeadline : node.office!.reportUntil!); }
      catch { return false; }
      if (directive.decision === "deny") { attempt.state = "cancelled"; attempt.cancelledAt = this.now(); }
      else { attempt.state = "issued"; attempt.issuedAt = this.now(); }
      attempt.controllerDecision = { controllerHost: directive.controllerHost, controllerDecisionId: directive.controllerDecisionId,
        policyVersion: directive.policyVersion, decision: directive.decision, at: this.now() };
      this.options.store.update(node);
      return true;
    });
  }

  invalidate(filter: { botId?: string; threadId?: string; generation?: string; attemptId?: string }, reason = "Office execution was stopped", shutdown = false): void {
    for (const [id, live] of this.live) {
      if ((filter.attemptId && filter.attemptId !== id) || (filter.botId && filter.botId !== live.input.botId)
        || (filter.threadId && filter.threadId !== live.input.threadId) || (filter.generation && filter.generation !== live.binding.generation)) continue;
      this.options.store.transaction(() => {
        const stored = this.find(id);
        if (stored && stored.attempt.state !== "uncertain") {
          stored.attempt.state = stored.attempt.state === "consumed" && stored.attempt.finishedAt === undefined ? "uncertain" : "cancelled";
          stored.attempt.cancelledAt = this.now(); this.options.store.update(stored.node);
        }
      });
      live.cleanup(); this.live.delete(id); live.controller.abort(new Error(reason));
      if (!shutdown) this.options.cancelAssignment(live.binding.assignmentId, reason);
      try { void Promise.resolve(this.options.cancelNative({ ...live.binding, botId: live.input.botId, threadId: live.input.threadId }, reason)).catch(() => {}); } catch {}
    }
  }

  close(): void { this.closed = true; this.invalidate({}, "Office control shut down for restart", true); }

  private check(node: Assignment, attempt: OfficeAttempt, live: LiveAttempt, expiresAt: number): void {
    if (this.closed || live.controller.signal.aborted || live.input.signal.aborted || terminal(node.status) || node.status !== "running") throw new Error("Office execution was stopped");
    if (this.now() >= expiresAt) throw new Error("The fixed office execution deadline expired");
    const current = this.options.resolve(live.input);
    if (!current || current.assignmentId !== attempt.assignmentId || current.generation !== attempt.generation || current.profileDigest !== attempt.profileDigest) {
      throw new Error("The native assignment generation or selected profile changed");
    }
    if (node.office?.rootDeadline !== attempt.rootDeadline || resolvePath(live.input.cwd) !== attempt.cwd) throw new Error("The immutable office attempt changed");
    const root = this.options.store.root(node.id);
    if (!root || terminal(root.status) || root.office?.rootDeadline !== attempt.rootDeadline || assignmentDigest(node) !== attempt.assignmentDigest) {
      throw new Error("The native assignment or its root changed");
    }
  }

  private find(attemptId: string, assignmentId?: string): { node: Assignment; attempt: OfficeAttempt } | undefined {
    const id = assignmentId ?? this.live.get(attemptId)?.binding.assignmentId;
    if (!id) return undefined;
    const node = this.options.store.get(id);
    const attempt = node?.office?.attempts.find(value => value.attemptId === attemptId);
    return node && attempt ? { node, attempt } : undefined;
  }
}

/** This namespace accepts only a worker-issued attempt capability, never the general API session. */
export async function handleOfficeControlRequest(control: OfficeControl | undefined, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith("/api/office-control/")) return false;
  const answer = (status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value));
  };
  const match = /^\/api\/office-control\/attempts\/([a-f0-9-]{36})(\/directive)?$/.exec(pathname);
  const auth = req.headers.authorization;
  const capability = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const attempt = match && control?.readAttempt(match[1]!, capability);
  if (!match || !attempt) { answer(401, { error: "Office attempt authorization required" }); return true; }
  if (req.method === "GET" && !match[2]) { answer(200, { ok: true, attempt }); return true; }
  if (req.method !== "POST" || !match[2]) { answer(405, { error: "Office attempt method not allowed" }); return true; }
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 4096) { answer(413, { error: "Office directive is too large" }); return true; }
    chunks.push(data);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { answer(400, { error: "Invalid office directive" }); return true; }
  const committed = control!.commitDirective(match[1]!, capability, body);
  answer(committed ? 200 : 409, committed ? { ok: true, attempt: control!.readAttempt(match[1]!, capability) } : { error: "Office directive precondition changed" });
  return true;
}
