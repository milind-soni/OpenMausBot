// Where an action took the tab. A link, a form or a script asks Chrome for a navigation, and Chrome starts it a moment
// later: a form's submit() and a script's location change run in a task after the click, and the browser learns of a
// link's navigation over its own channel. A page read at once could still be the old one, so a click that opened the
// next page was answered "The visible text of the page did not change" (Chrome 155, measured on macOS and Linux).
import type { CdpSession } from "./connection.ts";
import type { FrameTree } from "./frames.ts";
import type { Lifecycle } from "./wait.ts";

/** The page's own tasks queued by the action run before this one: a page's setTimeout(0) and a form's submission. */
const AFTER_PAGE_TASKS = "new Promise((done) => setTimeout(done, 20))";

export interface NavigationMark {
  requested: number;
  withinDocument: number;
  stopped: number;
  loaderId: string | null;
}

/** The navigations a tab's main frame asked for, moved within, and stopped loading. */
export class Navigations {
  readonly #session: CdpSession;
  readonly #frames: FrameTree;
  readonly #lifecycle: Lifecycle;
  #requested = 0;
  #withinDocument = 0;
  #stopped = 0;

  constructor(session: CdpSession, frames: FrameTree, lifecycle: Lifecycle) {
    this.#session = session;
    this.#frames = frames;
    this.#lifecycle = lifecycle;
    const main = (frameId: unknown) => frameId === frames.mainFrameId;
    session.on("Page.frameRequestedNavigation", (params) => { if (main(params.frameId) && params.disposition === "currentTab") this.#requested++; });
    session.on("Page.navigatedWithinDocument", (params) => { if (main(params.frameId)) this.#withinDocument++; });
    session.on("Page.frameStoppedLoading", (params) => { if (main(params.frameId)) this.#stopped++; });
  }

  mark(): NavigationMark {
    return { requested: this.#requested, withinDocument: this.#withinDocument, stopped: this.#stopped, loaderId: this.#lifecycle.loaderId };
  }

  /** After an action: lets the page's own queued tasks run, and when the page asked for a navigation since `mark`, waits
   * (at most `timeoutMs`) until the tab has a new document with its DOM, moved within this one, or stopped loading. */
  async follow(mark: NavigationMark, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // A navigation the browser already started holds this until the next document commits; that ends it too. Never
    // stopped past its time: that would stop the page's own scripts.
    const yieldMs = Math.max(1, Math.min(2_000, deadline - Date.now()));
    await this.#frames.inWorld(this.#frames.mainFrameId, (session, contextId) =>
      session.send("Runtime.evaluate", { expression: AFTER_PAGE_TASKS, contextId, awaitPromise: true, returnByValue: true }, { timeoutMs: yieldMs })).catch(() => {});
    if (this.#requested === mark.requested && this.#lifecycle.loaderId === mark.loaderId) return;
    const moved = () => this.#lifecycle.loaderId !== mark.loaderId || this.#withinDocument !== mark.withinDocument || this.#stopped !== mark.stopped;
    if (!moved()) {
      await new Promise<void>((resolve) => {
        const check = () => queueMicrotask(() => { if (moved()) finish(); });
        const offs = ["Page.frameNavigated", "Page.navigatedWithinDocument", "Page.frameStoppedLoading"].map((event) => this.#session.on(event, check));
        const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
        function finish() {
          for (const off of offs) off();
          clearTimeout(timer);
          resolve();
        }
      });
    }
    if (this.#lifecycle.loaderId !== mark.loaderId) {
      await this.#lifecycle.waitFor("domcontentloaded", { timeoutMs: Math.max(1, deadline - Date.now()) }).catch(() => {});
    }
  }
}
