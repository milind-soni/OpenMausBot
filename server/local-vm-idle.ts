/** Renewable idle deadline for one Local VM.
 *
 * Activity resets the full window. The caller decides how to suspend or
 * recycle the disposable VM, and an active turn or lifecycle operation defers
 * that work for another full window instead of racing current work.
 */
export class LocalVmIdleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleMs: number;
  private readonly isBusy: () => boolean;
  private readonly suspend: () => Promise<void>;

  constructor(idleMs: number, isBusy: () => boolean, suspend: () => Promise<void>) {
    if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error("Local VM idle timeout must be positive");
    this.idleMs = idleMs;
    this.isBusy = isBusy;
    this.suspend = suspend;
  }

  touch(): void {
    this.cancel();
    this.timer = setTimeout(() => void this.expire(), this.idleMs);
    this.timer.unref?.();
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
