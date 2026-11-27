/** A backup owns one quiet workspace. Never interrupt a turn to obtain it. */
export class WorkspaceBackupMaintenance {
  active = false;
  pendingRestore = false;
  private requests = 0;

  assertAvailable(): void {
    if (this.active) throw Object.assign(new Error(this.pendingRestore
      ? "A workspace restore is ready. Fully quit and reopen OpenMausBot (or restart the hosted server) to finish."
      : "A workspace backup is in progress. Try again when it finishes."), { status: 503 });
  }

  request(): () => void {
    this.assertAvailable();
    this.requests++;
    return () => { this.requests--; };
  }

  async run<T>(work: () => Promise<T>, hooks: { idle: () => boolean; pause: () => void; resume: () => void; flush: () => Promise<void> }, keepLocked = false): Promise<T> {
    this.assertAvailable();
    if (this.requests || !hooks.idle()) throw Object.assign(new Error("Wait for bot turns, approvals, sign-ins, and computer actions to finish before backing up or restoring."), { status: 409 });
    this.active = true;
    let committed = false;
    try {
      hooks.pause();
      await hooks.flush();
      if (!hooks.idle()) throw Object.assign(new Error("The workspace is still finishing background work. Try again shortly."), { status: 409 });
      const result = await work();
      committed = keepLocked;
      this.pendingRestore = keepLocked;
      return result;
    } finally {
      if (!committed) {
        this.active = false;
        hooks.resume();
      }
    }
  }
}
