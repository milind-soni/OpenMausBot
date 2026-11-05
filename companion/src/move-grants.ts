export const MOVE_ASK_TTL_MS = 300_000;
export const MOVE_GRANT_TTL_MS = 1_800_000;
export const MOVE_MAX_BOTS = 200;

type PendingMove = { state: "pending"; bots: number; expiresAt: number };

export type MoveState =
  | { state: "none" }
  | PendingMove
  | { state: "granted"; expiresAt: number }
  | { state: "refused" }
  | { state: "expired" };

type Entry = { kind: "pending" | "granted" | "refused"; bots: number; expiresAt: number };

/** A restart forgets every ask and grant, which fails closed. */
export class MoveGrants {
  private readonly entries = new Map<string, Entry>();

  /** One dialog per device per window, so a phone cannot wear the owner down
   * by asking again after a No or by asking and ending in a loop. */
  private readonly quietUntil = new Map<string, number>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** created: false while an ask already waits, a grant is live, or the device asked or was refused within MOVE_ASK_TTL_MS. */
  ask(deviceId: string, bots: number): { state: MoveState; created: false } | { state: PendingMove; created: true } {
    const current = this.state(deviceId);
    if (current.state === "pending" || current.state === "granted") return { state: current, created: false };
    if ((this.quietUntil.get(deviceId) ?? 0) > this.now()) return { state: current, created: false };
    const expiresAt = this.now() + MOVE_ASK_TTL_MS;
    this.entries.set(deviceId, { kind: "pending", bots, expiresAt });
    this.quietUntil.set(deviceId, expiresAt);
    return { state: { state: "pending", bots, expiresAt }, created: true };
  }

  /** The owner's yes to the ask expiring at `expiresAt`: a yes to an earlier ask, before a restart too, never grants a newer one. */
  allow(deviceId: string, expiresAt: number): boolean {
    const entry = this.entries.get(deviceId);
    if (entry?.kind !== "pending" || entry.expiresAt !== expiresAt || entry.expiresAt <= this.now()) return false;
    this.entries.set(deviceId, { ...entry, kind: "granted", expiresAt: this.now() + MOVE_GRANT_TTL_MS });
    return true;
  }

  /** The owner's no, a revoke, or unpairing: the ask or grant ends and reads "refused". */
  refuse(deviceId: string): void {
    this.entries.set(deviceId, { kind: "refused", bots: 0, expiresAt: 0 });
    this.quietUntil.set(deviceId, this.now() + MOVE_ASK_TTL_MS);
  }

  /** The phone's own end: reads "none", and the device still waits out its window before asking again. */
  end(deviceId: string): void {
    this.entries.delete(deviceId);
  }

  /** An ask that never reached the owner holds back nothing. */
  withdraw(deviceId: string): void {
    this.entries.delete(deviceId);
    this.quietUntil.delete(deviceId);
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
