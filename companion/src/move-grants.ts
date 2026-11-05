export const MOVE_ASK_TTL_MS = 300_000;
export const MOVE_GRANT_TTL_MS = 1_800_000;
export const MOVE_MAX_BOTS = 200;

export type MoveState =
  | { state: "none" }
  | { state: "pending"; bots: number; expiresAt: number }
  | { state: "granted"; expiresAt: number }
  | { state: "refused" }
  | { state: "expired" };

type Entry = { kind: "pending" | "granted" | "refused"; bots: number; expiresAt: number };

/** A restart forgets every ask and grant, which fails closed. */
export class MoveGrants {
  private readonly entries = new Map<string, Entry>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** created: false while an ask already waits or a grant is live, so no second dialog is raised. */
  ask(deviceId: string, bots: number): { state: MoveState; created: boolean } {
    const current = this.state(deviceId);
    if (current.state === "pending" || current.state === "granted") return { state: current, created: false };
    this.entries.set(deviceId, { kind: "pending", bots, expiresAt: this.now() + MOVE_ASK_TTL_MS });
    return { state: this.state(deviceId), created: true };
  }

  /** The owner's yes: only an unexpired pending ask becomes a grant. */
  allow(deviceId: string): boolean {
    const entry = this.entries.get(deviceId);
    if (entry?.kind !== "pending" || entry.expiresAt <= this.now()) return false;
    this.entries.set(deviceId, { ...entry, kind: "granted", expiresAt: this.now() + MOVE_GRANT_TTL_MS });
    return true;
  }

  /** The owner's no, a revoke, or unpairing: the ask or grant ends and reads "refused". */
  refuse(deviceId: string): void {
    this.entries.set(deviceId, { kind: "refused", bots: 0, expiresAt: 0 });
  }

  /** The phone's own end: reads "none". */
  end(deviceId: string): void {
    this.entries.delete(deviceId);
  }

  state(deviceId: string): MoveState {
    const entry = this.entries.get(deviceId);
    if (!entry) return { state: "none" };
    if (entry.kind === "refused") return { state: "refused" };
    if (entry.expiresAt <= this.now()) return { state: "expired" };
    return entry.kind === "pending"
      ? { state: "pending", bots: entry.bots, expiresAt: entry.expiresAt }
      : { state: "granted", expiresAt: entry.expiresAt };
  }

  live(deviceId: string): boolean {
    return this.state(deviceId).state === "granted";
  }
}
