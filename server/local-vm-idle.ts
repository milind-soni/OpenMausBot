/** Renewable idle deadline for one Local VM.
 *
 * Activity resets the full window. The caller decides how to suspend or
 * recycle the disposable VM, and an active turn or lifecycle operation defers
 * that work for another full window instead of racing current work.
 */
export class LocalVmIdleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastActivityAt = 0;
  private idleMs: number;
  private readonly isBusy: () => boolean;
  private readonly suspend: () => Promise<void>;

  constructor(idleMs: number, isBusy: () => boolean, suspend: () => Promise<void>) {
    this.idleMs = checkedIdleMs(idleMs);
    this.isBusy = isBusy;
    this.suspend = suspend;
  }

  touch(): void {
    this.lastActivityAt = Date.now();
    this.arm(this.idleMs);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Apply a new idle window. A pending deadline is re-armed against the
   * last activity, so a shorter window takes effect without waiting out the
   * old one and a longer window extends the current one. A cancelled timer
   * stays cancelled. */
  setIdleMs(idleMs: number): void {
    this.idleMs = checkedIdleMs(idleMs);
    if (!this.timer) return;
    this.arm(Math.max(0, this.lastActivityAt + this.idleMs - Date.now()));
  }

  private arm(delayMs: number): void {
    this.cancel();
    this.timer = setTimeout(() => void this.expire(), delayMs);
    this.timer.unref?.();
  }

  private async expire(): Promise<void> {
    this.timer = null;
    if (this.isBusy()) {
      this.touch();
      return;
    }
    try {
      await this.suspend();
    } catch {
      // A transient runtime failure must not disable the cost/resource
      // backstop forever. Retry after a fresh full idle window.
      this.touch();
    }
  }
}

function checkedIdleMs(idleMs: number): number {
  if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error("Local VM idle timeout must be positive");
  return idleMs;
}
