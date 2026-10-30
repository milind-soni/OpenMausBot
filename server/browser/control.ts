// Who may act in a bot's browser. A person holding any tab holds the whole profile: every bot call, reads included,
// is refused, because the person may be typing a password. Underneath, each tab keeps T3 Code's SessionControl, so a
// takeover drains running work, interrupts queued bot work and revokes refs.
import { BROWSER_CONTROL_REFUSAL } from "../browser-runtime.ts";
import { BrowserControlInterrupted, type SessionControl } from "./session-control.ts";

export { BROWSER_CONTROL_REFUSAL };

/** The bots' single agent id: one conversation uses a browser at a time, so tabs belong to the profile. */
export const AGENT = "bot";

export interface ControlledTab {
  readonly control: SessionControl;
}

export interface TakeResult {
  /** Bot work was running when the person asked: the page may have changed since they aimed. */
  waited: boolean;
  /** That work outlasted the drain and control was granted anyway; the profile is uncertain. */
  stale: boolean;
}

export class ProfileControl<T extends ControlledTab = ControlledTab> {
  owner: string | null = null;
  /** The owner's takeover has drained: their input may run. */
  ready = false;
  releasing = false;
  stale = false;
  /** A bot call never answered, or a person left with input held: nothing new reaches the browser until a probe. */
  uncertain = false;
  /** The call that never answered; null when only a restart clears the uncertainty. */
  lostCall: string | null = null;
  /** The bot's call running now, which becomes the lost call if a person's takeover outlasts it. */
  call: string | null = null;
  closing = false;
  agents = 0;
  humans = 0;
  readonly #tabs: () => readonly T[];
  readonly #takeoverMs: number;
  readonly #listeners = new Set<() => void>();

  constructor(tabs: () => readonly T[], { takeoverMs = 15_000 }: { takeoverMs?: number } = {}) {
    this.#tabs = tabs;
    this.#takeoverMs = takeoverMs;
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  changed(): void {
    for (const listener of this.#listeners) {
      try { listener(); } catch {}
    }
  }

  /** Bot work, on a tab or the whole browser. A person's takeover during it turns its answer into the refusal. */
  async agent<R>(tab: ControlledTab | null, run: () => Promise<R>): Promise<R> {
    if (this.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
    if (this.closing) throw new Error("The browser is closing. Try again shortly.");
    this.agents++;
    try {
      const result = tab ? await tab.control.agent(AGENT, run) : await run();
      if (this.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
      return result;
    } catch (error) {
      if (error instanceof BrowserControlInterrupted && this.owner !== null) throw new Error(BROWSER_CONTROL_REFUSAL);
      throw error;
    } finally {
      this.agents--;
      this.changed();
    }
  }

  canControl(owner: string): boolean {
    return Boolean(owner) && this.owner === owner && this.ready && !this.releasing && !this.closing;
  }

  /** Reserves the browser at once, then waits up to the drain for running bot work; past it, control is granted anyway. */
  async take(owner: string): Promise<TakeResult> {
    if (!owner) throw new Error("Browser control requires an owner.");
    if (this.closing || this.releasing) throw new Error("Browser control is changing. Try again shortly.");
    if (this.owner !== null && this.owner !== owner) throw new Error("Another person controls this browser.");
    if (this.owner === owner && this.ready) return { waited: false, stale: this.stale };
    const waited = this.agents > 0;
    this.owner = owner;
    this.ready = false;
    this.changed();
    const drained = Promise.all(this.#tabs().map((tab) => tab.control.take(owner).catch(() => undefined)));
    const idle = this.#until(() => this.agents === 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.#takeoverMs); timer.unref?.(); });
    const done = await Promise.race([Promise.all([drained, idle]).then(() => true), late]);
    clearTimeout(timer);
    if (this.owner !== owner || this.closing) throw new Error("Browser control request was cancelled.");
    if (!done) {
      this.stale = true;
      if (!this.uncertain) {
        this.uncertain = true;
        this.lostCall = this.call ?? "browser";
      }
    }
    this.ready = true;
    this.changed();
    return { waited, stale: !done };
  }

  /** A tab that opens while a person holds the browser is theirs too. */
  adopt(tab: ControlledTab): void {
    if (this.owner !== null) void tab.control.take(this.owner).catch(() => undefined);
  }

  /**
   * Lets go of every tab once the person's pending input has run, releasing what they held; bots wait for that. Work
   * that never ends (a hung page) cannot keep the person holding it: past the drain the browser is let go, uncertain.
   */
  async release(owner: string, releaseInput: (tab: T) => Promise<boolean>): Promise<void> {
    if (!owner || this.owner !== owner) return;
    this.ready = false;
    this.releasing = true;
    this.changed();
    let clean = true;
    try {
      clean = await this.#drain((tab) => {
        let released = true;
        return tab.control.disconnect(owner, async () => { released = await releaseInput(tab).catch(() => false); }).then(() => released, () => true);
      });
    } finally {
      if (this.owner === owner) {
        this.owner = null;
        this.stale = false;
        if (!clean && !this.uncertain) {
          this.uncertain = true;
          this.lostCall = null;
        }
      }
      this.releasing = false;
      this.changed();
    }
  }

  /**
   * One of the person's views went while they keep the browser: what it pressed is let go once the input queued on each
   * tab has run, as on a hand-back. A page that never takes it leaves the browser uncertain.
   */
  async letGo(owner: string, releaseInput: (tab: T) => Promise<boolean>): Promise<void> {
    if (!owner || this.owner !== owner) return;
    const clean = await this.#drain((tab) => tab.control.system(() => releaseInput(tab)).catch(() => true));
    if (clean || this.uncertain) return;
    this.uncertain = true;
    this.lostCall = null;
    this.changed();
  }

  /** `work` on every tab, false when one failed or outlasted the drain. */
  async #drain(work: (tab: T) => Promise<boolean>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const drained = Promise.all(this.#tabs().map(work)).then((results) => results.every(Boolean));
      const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.#takeoverMs); timer.unref?.(); });
      return await Promise.race([drained, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  async human<R>(owner: string, tab: ControlledTab, run: () => Promise<R>): Promise<R> {
    if (!this.canControl(owner)) throw new Error("Take control of this browser before interacting.");
    this.humans++;
    try {
      return await tab.control.human(owner, run);
    } finally {
      this.humans--;
      this.changed();
    }
  }

  latch(call: string): void {
    if (this.closing || this.uncertain) return;
    this.uncertain = true;
    this.lostCall = call;
    this.changed();
  }

  settle(): void {
    this.uncertain = false;
    this.lostCall = null;
    this.changed();
  }

  #until(condition: () => boolean): Promise<void> {
    if (condition()) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.onChange(() => {
        if (!condition()) return;
        off();
        resolve();
      });
    });
  }
}
