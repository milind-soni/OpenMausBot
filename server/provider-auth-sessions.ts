// An in-progress login belongs to the admin session that started it: never put its device code on global SSE.
// While one is under way (`active`) a Cloud home reports itself busy (`maintenance`, server/cloud-power.ts), so it never
// sleeps under a login process; a flow that is abandoned stops counting at its own expiry (at most 15 minutes for every engine).
// On a Cloud home each attempt and its outcome also go to the sign-in trace (server/sign-in-trace.ts): codes, never secrets.
import { signInOutcome, signInReasonOf, withSignInReason, type SignInOutcome } from "../shared/sign-in-outcome.ts";
import type { ProviderAuthenticationStart, ProviderAuthenticationStatus, ProviderInstance } from "./contracts.ts";
import { signInMethodOf, type SignInAttempt, type SignInInterruption, type SignInTrace } from "./sign-in-trace.ts";

type LoginInstance = Pick<ProviderInstance, "instanceId" | "startAuthentication" | "getAuthentication" | "completeAuthentication" | "cancelAuthentication" | "signOut">
  & Partial<Pick<ProviderInstance, "driverKind" | "authenticationMethod">>;
type Flow = {
  instance: LoginInstance;
  owner: string;
  flowId: string | null;
  expiresAt: number;
  busy: boolean;
  starting: boolean;
  revoked: boolean;
  revision: number;
  /** Its success was told: a client reading the finished flow again is not another sign-in. */
  told?: true;
  /** Its entry in the sign-in trace; null where there is no trace (a desktop). */
  attempt: SignInAttempt | null;
  /** Its expiry was noticed and the engine is being asked how it ended. */
  settling?: true;
};

const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
const INTERRUPTED = "This sign-in was interrupted because the server stopped. Start sign-in again.";
const finished = (phase: ProviderAuthenticationStatus["phase"]) => phase !== "waiting" && phase !== "verifying";
/** How a finished status ended, as a code: the engine's own reason when it gives one. */
function outcomeOf(status: Pick<ProviderAuthenticationStatus, "phase" | "reason">): SignInOutcome {
  if (status.phase === "succeeded") return "completed";
  return signInOutcome(status.reason) ?? (status.phase === "expired" ? "expired" : status.phase === "cancelled" ? "cancelled" : "failed");
}

export class ProviderAuthSessions {
  private readonly flows = new Map<string, Flow>();
  /** A sign-in to this AI finished: whatever waited on it being signed out may use it again. */
  private readonly signedIn: (instanceId: string) => void;
  private readonly trace: SignInTrace | null;
  private readonly now: () => number;

  constructor(options: { signedIn?: (instanceId: string) => void; trace?: SignInTrace | null; now?: () => number } = {}) {
    this.signedIn = options.signedIn ?? (() => {});
    this.trace = options.trace ?? null;
    this.now = options.now ?? Date.now;
  }

  /** A sign-in under way, until it expires: one whose provider call never returns stops counting then too. */
  get active(): boolean {
    const at = this.now();
    if (this.trace) for (const flow of this.flows.values()) if (flow.expiresAt <= at && !flow.busy) this.settleLate(flow);
    return [...this.flows.values()].some((flow) => flow.expiresAt > at && (flow.busy || !flow.revoked));
  }

  /** A flow that ran out without anyone reading it (a pasted-code screen does not poll): its outcome is the engine's, else expired. */
  private settleLate(flow: Flow): void {
    const attempt = flow.attempt;
    if (!attempt || attempt.ended || flow.settling) return;
    flow.settling = true;
    const { flowId, instance } = flow;
    // Read on a later tick and caught either way: this runs inside `active`, the power probe, which must never throw.
    void Promise.resolve()
      .then(() => flowId && instance.getAuthentication ? instance.getAuthentication(flowId) : null)
      .catch(() => null)
      .then((status) => attempt.end(status && finished(status.phase) ? outcomeOf(status) : "expired"))
      .catch(() => {});
  }

  private end(flow: Flow | undefined, outcome: SignInOutcome, by?: SignInInterruption): void {
    flow?.attempt?.end(outcome, by);
  }

  async start(instance: LoginInstance, owner: string): Promise<ProviderAuthenticationStart> {
    if (!instance.startAuthentication) throw failure("Account setup is unavailable for this provider.", 404);
    const existing = this.flows.get(instance.instanceId);
    if (existing && (existing.busy || (existing.owner !== owner && existing.expiresAt > this.now()))) {
      throw failure("A sign-in is already in progress. Finish or cancel it in the browser that started it, or wait for it to expire.", 409);
    }
    const resuming = existing && existing.owner === owner && existing.expiresAt > this.now() && !existing.revoked;
    if (existing && !resuming) this.settleLate(existing);
    const flow: Flow = resuming ? existing : { instance, owner, flowId: null, expiresAt: this.now() + 15 * 60_000, busy: false, starting: false, revoked: false, revision: 0, attempt: null };
    flow.busy = true;
    flow.starting = true;
    this.flows.set(instance.instanceId, flow);
    let begun = false;
    try {
      // The engine's flow behind a resumed one may have ended unread (its login command exited): that attempt is over.
      if (this.trace && resuming && flow.attempt && !flow.attempt.ended && flow.flowId && instance.getAuthentication) {
        const prior = await instance.getAuthentication(flow.flowId).catch(() => null);
        if (!prior || finished(prior.phase)) flow.attempt.end(prior ? outcomeOf(prior) : "failed");
      }
      if (this.trace && (!flow.attempt || flow.attempt.ended)) { flow.attempt = this.trace.begin(instance.driverKind, signInMethodOf(instance)); begun = true; }
      const result = await instance.startAuthentication();
      if (flow.revoked || this.flows.get(instance.instanceId) !== flow) {
        await instance.cancelAuthentication?.();
        throw failure("Sign-in cancelled because the session or provider changed.", 409);
      }
      flow.flowId = result.flowId;
      if (result.flowId) flow.attempt?.opened(instance.instanceId, result.flowId);
      const expiry = Date.parse(result.expiresAt ?? "");
      if (Number.isFinite(expiry)) flow.expiresAt = expiry;
      if (result.phase === "succeeded") {
        this.flows.delete(instance.instanceId);
        this.end(flow, "completed");
        this.signedIn(instance.instanceId);
      }
      return result;
    } catch (error) {
      if ((!resuming || flow.revoked) && this.flows.get(instance.instanceId) === flow) this.flows.delete(instance.instanceId);
      if (begun || !resuming || flow.revoked || this.flows.get(instance.instanceId) !== flow) this.end(flow, flow.revoked ? "interrupted" : signInReasonOf(error) ?? "failed", flow.revoked ? "session" : undefined);
      // A resumed flow whose engine flow had ended, and whose new one did not start: nothing is open any more.
      if (begun && resuming) flow.expiresAt = 0;
      throw error;
    } finally {
      flow.busy = false;
      flow.starting = false;
    }
  }

  private owned(instanceId: string, owner: string, flowId: string): Flow {
    const flow = this.flows.get(instanceId);
    if (!flowId || !flow || flow.revoked || flow.owner !== owner || flow.flowId !== flowId) {
      if (this.cutShort(instanceId, flowId)) throw withSignInReason(failure(INTERRUPTED, 404), "interrupted");
      throw failure("This sign-in is no longer available in this browser. Start a new sign-in.", 404);
    }
    if (flow.busy) throw failure("The sign-in is still being updated. Try again shortly.", 409);
    return flow;
  }

  /** This flow was open when the server last stopped (a restart, a stop for sleep) and is not the one under way now. */
  private cutShort(instanceId: string, flowId: string): boolean {
    return Boolean(this.trace?.interrupted(instanceId, flowId)) && this.flows.get(instanceId)?.flowId !== flowId;
  }

  async status(instanceId: string, owner: string, flowId: string): Promise<ProviderAuthenticationStatus> {
    // The screen polling a flow the server's stop cut short hears why, as a finished status. No `message`: the screen words
    // `reason` in the person's own language.
    if (this.cutShort(instanceId, flowId)) return { phase: "failed", flowId, authorizationUrl: null, expiresAt: null, reason: "interrupted" };
    const flow = this.owned(instanceId, owner, flowId);
    if (!flow.instance.getAuthentication) throw failure("Sign-in status is unavailable for this provider.", 404);
    const revision = flow.revision;
    const status = await flow.instance.getAuthentication(flowId);
    if (flow.revoked || this.flows.get(instanceId) !== flow || flow.flowId !== flowId || flow.revision !== revision) throw failure("This sign-in session ended.", 404);
    if (finished(status.phase)) {
      flow.expiresAt = 0;
      this.end(flow, outcomeOf(status));
    }
    if (status.phase === "succeeded" && !flow.told) {
      flow.told = true;
      this.signedIn(instanceId);
    }
    return status;
  }

  async complete(instanceId: string, owner: string, flowId: string, callbackUrl: string) {
    const flow = this.owned(instanceId, owner, flowId);
    if (!flow.instance.completeAuthentication) throw failure("This provider does not use a callback URL.", 400);
    flow.busy = true;
    try {
      try {
        await flow.instance.completeAuthentication(flowId, callbackUrl);
      } catch (error) {
        if (this.trace && !flow.revoked && this.flows.get(instanceId) === flow) await this.afterRefusedCode(flow, flowId, error);
        throw error;
      }
      if (flow.revoked || this.flows.get(instanceId) !== flow) throw failure("This sign-in session ended.", 404);
      this.flows.delete(instanceId);
      this.end(flow, "completed");
      this.signedIn(instanceId);
    } finally { flow.busy = false; }
  }

  /** A code the engine did not take, on a Cloud home (with a trace): a sign-in it ended (the provider refused it, the command
   * exited) is over and no longer keeps the home awake; one still waiting (a pasted code that is not a code) stays open for
   * another try. A desktop keeps its flow until it is read or expires, as before. */
  private async afterRefusedCode(flow: Flow, flowId: string, error: unknown): Promise<void> {
    const reason = signInReasonOf(error);
    const after = flow.instance.getAuthentication ? await flow.instance.getAuthentication(flowId).catch(() => null) : null;
    if (after && finished(after.phase)) {
      flow.expiresAt = 0;
      this.end(flow, signInOutcome(after.reason) ?? reason ?? outcomeOf(after));
    } else if (reason) flow.attempt?.note(reason);
  }

  async cancel(instanceId: string, owner: string, flowId: string) {
    // Nothing is left to cancel of a flow the server's stop cut short.
    if (this.cutShort(instanceId, flowId)) return;
    const flow = this.owned(instanceId, owner, flowId);
    flow.busy = true;
    // Invalidate polls already in flight, but let a later poll read the provider's cancelled status.
    flow.revision++;
    try { await flow.instance.cancelAuthentication?.(); }
    finally { flow.busy = false; flow.expiresAt = 0; this.end(flow, "cancelled"); }
  }

  /** Never pulls a login another admin is completing, and no one may start one while the credential is being removed. */
  async signOut(instance: LoginInstance, owner: string): Promise<void> {
    if (!instance.signOut) throw failure("Sign-out is unavailable for this provider.", 404);
    const existing = this.flows.get(instance.instanceId);
    if (existing && (existing.busy || (existing.owner !== owner && existing.expiresAt > this.now() && !existing.revoked))) {
      throw failure("A sign-in is in progress. Finish or cancel it in the browser that started it, or wait for it to expire.", 409);
    }
    const flow: Flow = { instance, owner, flowId: null, expiresAt: this.now() + 60_000, busy: true, starting: false, revoked: false, revision: 0, attempt: null };
    this.flows.set(instance.instanceId, flow);
    try {
      if (existing) {
        this.end(existing, "cancelled");
        await existing.instance.cancelAuthentication?.();
      }
      await instance.signOut();
    } finally {
      if (this.flows.get(instance.instanceId) === flow) this.flows.delete(instance.instanceId);
    }
  }

  revokeOwner(owner: string): void {
    for (const [id, flow] of this.flows) {
      if (flow.owner !== owner) continue;
      flow.revoked = true;
      // A pending start owns its eventual cancellation: keep the reservation so another browser cannot race into this auth home.
      if (flow.starting) continue;
      this.end(flow, "interrupted", "session");
      flow.busy = true;
      void Promise.resolve().then(() => flow.instance.cancelAuthentication?.()).catch(() => {}).finally(() => {
        if (this.flows.get(id) === flow) this.flows.delete(id);
      });
    }
  }

  clear(): void {
    for (const flow of this.flows.values()) { flow.revoked = true; this.end(flow, "interrupted", "settings"); }
    this.flows.clear();
  }

  clearInstance(instanceId: string): void {
    const flow = this.flows.get(instanceId);
    if (flow) { flow.revoked = true; this.end(flow, "interrupted", "settings"); }
    this.flows.delete(instanceId);
  }
}
