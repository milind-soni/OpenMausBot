// An in-progress login belongs to the admin session that started it: never put its device code on global SSE.
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

  /** A sign-in under way, until it expires: one whose provider call never returns stops counting then too. */
  get active(): boolean {
    return [...this.flows.values()].some((flow) => flow.expiresAt > Date.now() && (flow.busy || !flow.revoked));
  }

  async start(instance: LoginInstance, owner: string): Promise<ProviderAuthenticationStart> {
    if (!instance.startAuthentication) throw failure("Account setup is unavailable for this provider.", 404);
    const existing = this.flows.get(instance.instanceId);
    if (existing && (existing.busy || (existing.owner !== owner && existing.expiresAt > Date.now()))) {
      throw failure("A sign-in is already in progress. Finish or cancel it in the browser that started it, or wait for it to expire.", 409);
    }
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

  /** Never pulls a login another admin is completing, and no one may start one while the credential is being removed. */
  async signOut(instance: LoginInstance, owner: string): Promise<void> {
    if (!instance.signOut) throw failure("Sign-out is unavailable for this provider.", 404);
    const existing = this.flows.get(instance.instanceId);
    if (existing && (existing.busy || (existing.owner !== owner && existing.expiresAt > Date.now() && !existing.revoked))) {
      throw failure("A sign-in is in progress. Finish or cancel it in the browser that started it, or wait for it to expire.", 409);
    }
    const flow: Flow = { instance, owner, flowId: null, expiresAt: Date.now() + 60_000, busy: true, starting: false, revoked: false };
    this.flows.set(instance.instanceId, flow);
    try {
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
      // A pending start owns its eventual cancellation: keep the reservation so another browser cannot race into this auth home.
      if (flow.starting) continue;
      flow.busy = true;
      void Promise.resolve().then(() => flow.instance.cancelAuthentication?.()).catch(() => {}).finally(() => {
        if (this.flows.get(id) === flow) this.flows.delete(id);
      });
    }
  }

  clear(): void {
    for (const flow of this.flows.values()) flow.revoked = true;
    this.flows.clear();
  }

  clearInstance(instanceId: string): void {
    const flow = this.flows.get(instanceId);
    if (flow) flow.revoked = true;
    this.flows.delete(instanceId);
  }
}
