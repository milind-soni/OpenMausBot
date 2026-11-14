// A person's hold of a bot's browser as its viewers share it on the new engine. The hold is the person's: every view of
// theirs sees it, any of them may take it over or hand it back, and their next view carries on with it when the view it
// was used from went. Input runs only from that one view. How long it lasts unasked is in ../hold.ts.
import { HoldClock } from "../hold.ts";
import type { HubHost, Viewer } from "./core.ts";

export class ViewerHold {
  readonly #host: HubHost;
  readonly #viewers: ReadonlySet<Viewer>;
  readonly #changed: () => void;
  readonly #clock: HoldClock;
  /** The view the hold is used from. */
  #driver: Viewer | null = null;
  /** What the view it was used from pressed, being let go after that view went. */
  #letGo: Promise<void> = Promise.resolve();

  constructor(host: HubHost, viewers: ReadonlySet<Viewer>, changed: () => void) {
    this.#host = host;
    this.#viewers = viewers;
    this.#changed = changed;
    this.#clock = new HoldClock(() => void this.handBack(), host.holdLimits);
    // A hold that ended, whichever way, leaves nothing behind for the next one.
    host.control.onChange(() => {
      if (host.control.owner !== null) return;
      this.#driver = null;
      this.#clock.stop();
    });
  }

  /** The viewer's person holds the browser, from this view or another of theirs. */
  owns(viewer: Viewer): boolean {
    const owner = this.#host.control.owner;
    return owner !== null && owner === viewer.options.person;
  }

  /** Another person holds the browser: the viewer sees none of it. Every view of the holder, their picture in picture
   * too, sees it all. */
  hides(viewer: Viewer): boolean {
    return this.#host.control.owner !== null && !this.owns(viewer);
  }

  /** The viewer is the one its person's hold is used from. */
  drives(viewer: Viewer): boolean {
    return this.#driver === viewer && this.owns(viewer);
  }

  /** It drives the hold, and its person's input runs now. */
  controls(viewer: Viewer): boolean {
    return this.drives(viewer) && this.#host.control.canControl(viewer.options.person);
  }

  /** The open view the hold is used from: the one a page's file picker or sign-in prompt goes to. */
  get driver(): Viewer | null {
    const driver = this.#driver;
    return driver && this.drives(driver) && !driver.closed ? driver : null;
  }

  /** The person took control or sent input. */
  used(): void {
    this.#clock.used();
  }

  opened(viewer: Viewer): void {
    if (this.owns(viewer)) this.#clock.watched(true);
  }

  /** Their view carries on with their hold when no view of theirs uses it, once what the last one pressed is let go. */
  async carryOn(viewer: Viewer): Promise<void> {
    const free = () => !viewer.closed && viewer.options.canOperate && this.owns(viewer) && (this.#driver === null || !this.#viewers.has(this.#driver));
    if (!free()) return;
    await this.#letGo;
    if (free()) this.#driver = viewer;
  }

  /** The person's take was granted: their hold is used from this view now, never with what the view before it pressed. */
  async took(viewer: Viewer): Promise<void> {
    const person = viewer.options.person;
    const before = this.#driver;
    if (before && before !== viewer && this.#viewers.has(before)) await this.#host.control.letGo(person, () => before.releaseInput());
    await this.#letGo;
    if (viewer.closed || !this.owns(viewer)) return;
    this.#driver = viewer;
    this.#clock.used();
    this.#clock.watched(true);
  }

  /** Any view of the person hands their hold back, whichever of their views it is used from. */
  async release(viewer: Viewer): Promise<void> {
    if (this.owns(viewer)) await this.#end(viewer.options.person);
  }

  /**
   * A view went. What it pressed is let go once the input it queued has run. The hold carries on in the person's other
   * views; with none left, a dropped stream's hold waits the grace for their next view, and any other ends now.
   */
  async left(viewer: Viewer, dropped: boolean): Promise<void> {
    const person = viewer.options.person;
    if (this.drives(viewer)) {
      const letGo = this.#host.control.letGo(person, () => viewer.releaseInput());
      this.#letGo = letGo;
      await letGo;
      if (this.#driver === viewer) this.#driver = null;
    } else {
      await viewer.releaseInput();
    }
    if (!this.owns(viewer) || [...this.#viewers].some((other) => other.options.person === person)) return;
    if (dropped) this.#clock.watched(false);
    else await this.#end(person).catch(() => undefined);
  }

  /** Done on a sign-in card, from any window or device, or when a limit passed: whoever holds the browser hands it back. */
  async handBack(): Promise<void> {
    const person = this.#host.control.owner;
    if (person !== null) await this.#end(person).catch(() => undefined);
    this.#changed();
  }

  /** The person's hold ends as a hand-back does: what their views pressed is let go once their queued input has run. */
  async #end(person: string): Promise<void> {
    const views = [...this.#viewers].filter((viewer) => viewer.options.person === person);
    await this.#host.release(person, async () => (await Promise.all(views.map((viewer) => viewer.releaseInput()))).every(Boolean));
  }
}
