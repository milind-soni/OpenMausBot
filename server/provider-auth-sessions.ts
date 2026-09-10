// Provider credentials are server-wide, but an in-progress login belongs to
// the admin session that started it. Never put its device code on global SSE.
import type { ProviderAuthenticationStart, ProviderInstance } from "./contracts.ts";

type LoginInstance = Pick<ProviderInstance, "instanceId" | "startAuthentication" | "getAuthentication" | "completeAuthentication" | "cancelAuthentication" | "signOut">;
type Flow = {
  instance: LoginInstance;
  owner: string;
  flowId: string | null;
  expiresAt: number;
  busy: boolean;
  starting: boolean;
  revoked: boolean;
};

const failure = (message: string, status: number) => Object.assign(new Error(message), { status });

export class ProviderAuthSessions {
  private readonly flows = new Map<string, Flow>();

  async start(instance: LoginInstance, owner: string): Promise<ProviderAuthenticationStart> {
    if (!instance.startAuthentication) throw failure("Account setup is unavailable for this provider.", 404);
    const existing = this.flows.get(instance.instanceId);
    if (existing && (existing.busy || (existing.owner !== owner && existing.expiresAt > Date.now()))) {
      throw failure("A sign-in is already in progress. Finish or cancel it in the browser that started it, or wait for it to expire.", 409);
    }
    // Reopening Settings may resume the same owner's flow. Keep its ownership
    // if the driver's retry fails, rather than orphaning a still-running CLI.
    const resuming = existing && existing.owner === owner && existing.expiresAt > Date.now() && !existing.revoked;
    const flow: Flow = resuming ? existing : { instance, owner, flowId: null, expiresAt: Date.now() + 15 * 60_000, busy: false, starting: false, revoked: false };
    flow.busy = true;
    flow.starting = true;
    this.flows.set(instance.instanceId, flow);
    try {
      const result = await instance.startAuthentication();
      if (flow.revoked || this.flows.get(instance.instanceId) !== flow) {
        await instance.cancelAuthentication?.();
        throw failure("Sign-in cancelled because the session or provider changed.", 409);
      }
      flow.flowId = result.flowId;
      const expiry = Date.parse(result.expiresAt ?? "");
      if (Number.isFinite(expiry)) flow.expiresAt = expiry;
      if (result.phase === "succeeded") this.flows.delete(instance.instanceId);
      return result;
    } catch (error) {
      if ((!resuming || flow.revoked) && this.flows.get(instance.instanceId) === flow) this.flows.delete(instance.instanceId);
      throw error;
    } finally {
      flow.busy = false;
      flow.starting = false;
    }
  }

  private owned(instanceId: string, owner: string, flowId: string): Flow {
    const flow = this.flows.get(instanceId);
    if (!flowId || !flow || flow.revoked || flow.owner !== owner || flow.flowId !== flowId) {
      throw failure("This sign-in is no longer available in this browser. Start a new sign-in.", 404);
    }
    if (flow.busy) throw failure("The sign-in is still being updated. Try again shortly.", 409);
    return flow;
  }

  async status(instanceId: string, owner: string, flowId: string) {
    const flow = this.owned(instanceId, owner, flowId);
    if (!flow.instance.getAuthentication) throw failure("Sign-in status is unavailable for this provider.", 404);
    const status = await flow.instance.getAuthentication(flowId);
    if (flow.revoked) throw failure("This sign-in session ended.", 404);
    // Keep the terminal result available to its owner, but release the slot so
    // another admin need not wait fifteen minutes after success or cancellation.
    if (status.phase !== "waiting") flow.expiresAt = 0;
    return status;
  }

  async complete(instanceId: string, owner: string, flowId: string, callbackUrl: string) {
    const flow = this.owned(instanceId, owner, flowId);
    if (!flow.instance.completeAuthentication) throw failure("This provider does not use a callback URL.", 400);
    flow.busy = true;
    try {
      await flow.instance.completeAuthentication(flowId, callbackUrl);
      if (this.flows.get(instanceId) === flow) this.flows.delete(instanceId);
    } finally { flow.busy = false; }
  }

  async cancel(instanceId: string, owner: string, flowId: string) {
    const flow = this.owned(instanceId, owner, flowId);
    flow.busy = true;
    try { await flow.instance.cancelAuthentication?.(); }
    finally { flow.busy = false; flow.expiresAt = 0; }
  }

  /** Remove the server's stored sign-in for this provider. A login another
   * admin is still completing must not be pulled away underneath them, and
   * nobody may start one while the credential is being removed. */
  async signOut(instance: LoginInstance, owner: string): Promise<void> {
    if (!instance.signOut) throw failure("Sign-out is unavailable for this provider.", 404);
    const existing = this.flows.get(instance.instanceId);
    if (existing && (existing.busy || (existing.owner !== owner && existing.expiresAt > Date.now() && !existing.revoked))) {
      throw failure("A sign-in is in progress. Finish or cancel it in the browser that started it, or wait for it to expire.", 409);
    }
    // Reserve the slot like a starting flow: start() answers 409 until we finish.
    const flow: Flow = { instance, owner, flowId: null, expiresAt: Date.now() + 60_000, busy: true, starting: false, revoked: false };
    this.flows.set(instance.instanceId, flow);
    try {
      // This owner's own leftover flow is theirs to abandon.
      if (existing) await existing.instance.cancelAuthentication?.();
      await instance.signOut();
    } finally {
      if (this.flows.get(instance.instanceId) === flow) this.flows.delete(instance.instanceId);
    }
  }

  revokeOwner(owner: string): void {
    for (const [id, flow] of this.flows) {
      if (flow.owner !== owner) continue;
      flow.revoked = true;
      // A pending start owns its eventual cancellation. Keep the reservation
      // until it finishes so another browser cannot race into this auth home.
      if (flow.starting) continue;
      flow.busy = true;
      void Promise.resolve().then(() => flow.instance.cancelAuthentication?.()).catch(() => {}).finally(() => {
        if (this.flows.get(id) === flow) this.flows.delete(id);
      });
    }
  }

  clear(): void {
    for (const flow of this.flows.values()) flow.revoked = true;
    // Called when disposing the provider fleet, which owns child teardown.
    this.flows.clear();
  }

  clearInstance(instanceId: string): void {
    const flow = this.flows.get(instanceId);
    if (flow) flow.revoked = true;
    this.flows.delete(instanceId);
    // The registry's per-instance disposal owns child teardown.
  }
}
