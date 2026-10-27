// A sign-in: the relay mints a state and a HighLevel link; the person's browser does the rest; this server polls the
// relay's claim every 2 s for up to 10 minutes and stores the tokens once. One live flow at a time, in memory only.
import { randomUUID } from "node:crypto";

import type { HighLevelSignInPhase } from "../../shared/highlevel.ts";
import { HighLevelRelayError, type HighLevelRelay, type RelayTokens } from "./relay.ts";
import type { HighLevelStore } from "./store.ts";

export const SIGN_IN_POLL_MS = 2_000;
export const SIGN_IN_MAX_MS = 10 * 60_000;

export interface HighLevelSignInFlow {
  flowId: string;
  authorizationUrl: string;
  expiresAt: number;
  phase: HighLevelSignInPhase;
  message?: string;
}

export interface HighLevelSignInOptions {
  relay: HighLevelRelay;
  store: HighLevelStore;
  /** The location's name for the card; a failure here never fails the connection. */
  lookupLocationName(accessToken: string, locationId: string): Promise<string | undefined>;
  pollMs?: number;
  maxMs?: number;
  now?: () => number;
  onChange?(): void;
}

export class HighLevelSignIn {
  private readonly options: HighLevelSignInOptions;
  private readonly now: () => number;
  private flow: (HighLevelSignInFlow & { state: string; timer?: NodeJS.Timeout; cancelled?: boolean }) | null = null;
  /** Finished flows stay readable for a while so the app's last poll gets its answer. */
  private readonly finished = new Map<string, HighLevelSignInFlow>();

  constructor(options: HighLevelSignInOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Starts a new flow; a flow already waiting is cancelled first. */
  async start(): Promise<{ flowId: string; authorizationUrl: string; expiresAt: number }> {
    this.cancelActive("A newer sign-in replaced this one.");
    const started = await this.options.relay.start();
    const expiresAt = Math.min(started.expiresAt, this.now() + (this.options.maxMs ?? SIGN_IN_MAX_MS));
    const flow = { flowId: randomUUID(), state: started.state, authorizationUrl: started.authorizationUrl, expiresAt, phase: "waiting" as const };
    this.flow = flow;
    this.schedule(this.options.pollMs ?? SIGN_IN_POLL_MS);
    this.options.onChange?.();
    return { flowId: flow.flowId, authorizationUrl: flow.authorizationUrl, expiresAt: flow.expiresAt };
  }

  /** The live flow, for GET /api/highlevel. */
  active(): HighLevelSignInFlow | null {
    return this.flow ? { flowId: this.flow.flowId, authorizationUrl: this.flow.authorizationUrl, expiresAt: this.flow.expiresAt, phase: this.flow.phase } : null;
  }

  status(flowId: string): { phase: HighLevelSignInPhase; message?: string } | null {
    if (this.flow?.flowId === flowId) return { phase: this.flow.phase };
    const done = this.finished.get(flowId);
    return done ? { phase: done.phase, ...(done.message ? { message: done.message } : {}) } : null;
  }

  cancel(flowId: string): boolean {
    if (this.flow?.flowId !== flowId) return this.finished.delete(flowId);
    this.cancelActive("Cancelled.");
    return true;
  }

  close(): void {
    this.cancelActive("OpenMausBot stopped.");
  }

  private cancelActive(message: string): void {
    const flow = this.flow;
    if (!flow) return;
    flow.cancelled = true;
    if (flow.timer) clearTimeout(flow.timer);
    this.flow = null;
    this.remember({ ...flow, phase: "failed", message });
    this.options.onChange?.();
  }

  private remember(flow: HighLevelSignInFlow): void {
    this.finished.set(flow.flowId, { flowId: flow.flowId, authorizationUrl: flow.authorizationUrl, expiresAt: flow.expiresAt, phase: flow.phase, ...(flow.message ? { message: flow.message } : {}) });
    while (this.finished.size > 8) this.finished.delete(this.finished.keys().next().value!);
  }

  private finish(phase: HighLevelSignInPhase, message?: string): void {
    const flow = this.flow;
    if (!flow) return;
    if (flow.timer) clearTimeout(flow.timer);
    this.flow = null;
    this.remember({ ...flow, phase, message });
    this.options.onChange?.();
  }

  private schedule(ms: number): void {
    const flow = this.flow;
    if (!flow) return;
    flow.timer = setTimeout(() => { void this.poll(); }, ms);
    flow.timer.unref?.();
  }

  private async poll(): Promise<void> {
    const flow = this.flow;
    if (!flow || flow.cancelled) return;
    const live = () => this.flow === flow && !flow.cancelled;
    if (this.now() >= flow.expiresAt) return this.finish("expired", "The sign-in took longer than 10 minutes. Start again.");
    let claimed: RelayTokens | "pending" | "claimed";
    try {
      claimed = await this.options.relay.claim(flow.state);
    } catch (error) {
      if (!live()) return;
      // A relay hiccup is not a failed sign-in; keep polling until the flow expires.
      if (error instanceof HighLevelRelayError && error.status < 500 && error.status !== 503) return this.finish("failed", error.message);
      return this.schedule(this.options.pollMs ?? SIGN_IN_POLL_MS);
    }
    if (!live()) return;
    if (claimed === "pending") return this.schedule(this.options.pollMs ?? SIGN_IN_POLL_MS);
    if (claimed === "claimed") return this.finish("failed", "This sign-in was already used. Start again.");
    const locationName = await this.options.lookupLocationName(claimed.accessToken, claimed.locationId).catch(() => undefined);
    if (!live()) return;
    this.options.store.put({
      kind: "oauth", accessToken: claimed.accessToken, refreshToken: claimed.refreshToken, expiresAt: this.now() + claimed.expiresIn * 1000,
      locationId: claimed.locationId, ...(claimed.companyId ? { companyId: claimed.companyId } : {}), ...(claimed.userId ? { userId: claimed.userId } : {}),
      ...(locationName ? { locationName } : {}), scopes: claimed.scope,
    });
    this.finish("connected");
  }
}
