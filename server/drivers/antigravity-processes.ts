// The runtime processes each Antigravity account has running, so a sign-out can wait for them to end.
import type { ChildProcess } from "node:child_process";

import { killCliTree } from "../procs.ts";

const EXIT_WAIT_MS = 7_000;

export class AntigravityProcesses {
  readonly #running = new Map<string, Set<ChildProcess>>();

  track(instanceId: string, child: ChildProcess): void {
    const children = this.#running.get(instanceId) ?? new Set<ChildProcess>();
    this.#running.set(instanceId, children);
    children.add(child);
    const forget = () => {
      children.delete(child);
      if (!children.size && this.#running.get(instanceId) === children) this.#running.delete(instanceId);
    };
    child.once("close", forget);
    child.once("error", () => { if (child.pid === undefined) forget(); });
  }

  count(instanceId: string): number {
    return this.#running.get(instanceId)?.size ?? 0;
  }

  /** Each of this account's processes was asked to exit and gets `waitMs` before it is killed, then `waitMs` more to go.
   * Resolves false when one is still there. */
  async stopped(instanceId: string, waitMs = EXIT_WAIT_MS): Promise<boolean> {
    const children = [...this.#running.get(instanceId) ?? []];
    const gone = await Promise.all(children.map((child) => new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const finish = (gone: boolean) => {
        clearTimeout(timer);
        clearTimeout(giveUp);
        child.off("close", closed);
        resolve(gone);
      };
      const closed = () => finish(true);
      const timer = setTimeout(() => {
        void killCliTree(child).catch(() => false);
        giveUp = setTimeout(() => finish(false), waitMs);
        giveUp.unref?.();
      }, waitMs);
      timer.unref?.();
      child.once("close", closed);
    })));
    return gone.every(Boolean);
  }
}
