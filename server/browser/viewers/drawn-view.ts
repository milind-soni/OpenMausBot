// The size a bot's page is drawn at, against the size it is laid out at. An emulated page (a panel taller than the
// screen, a preset narrower than any window, a zoom) is laid out at a size its window does not have. A window whose
// resize lands after the emulation was applied takes the page's view back to the window's size (Chrome 157). The page
// cannot see that: it goes on reporting the emulated layout while every frame shows the window's, until the emulation
// is applied again.
import type { Tab } from "../tabs.ts";

export interface FrameMetadata {
  deviceWidth: number;
  deviceHeight: number;
  offsetTop: number;
  pageScaleFactor: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  timestamp?: number;
}

/** How often one page's emulation is applied again with no frame at its size in between: past that the page is left as it draws. */
const MAX_RESTORES = 5;

export class DrawnView {
  readonly #turn: (tab: Tab, work: () => Promise<void>) => Promise<void>;
  readonly #restores = new WeakMap<Tab, number>();
  readonly #pending = new WeakSet<Tab>();

  /** `turn` runs `work` when no size change or capture of the tab is under way. */
  constructor(turn: (tab: Tab, work: () => Promise<void>) => Promise<void>) {
    this.#turn = turn;
  }

  /** A live frame of `tab` came. Drawn at another size than the page's emulated layout, the emulation is applied again. */
  frame(tab: Tab, metadata: FrameMetadata): void {
    const emulated = tab.page.emulated;
    if (!emulated) return;
    // A zoom's layout is rounded to whole pixels, so a frame may be one off.
    if (Math.abs(metadata.deviceWidth - emulated.width) <= 1 && Math.abs(metadata.deviceHeight - emulated.height) <= 1) {
      this.#restores.delete(tab);
      return;
    }
    const restores = this.#restores.get(tab) ?? 0;
    if (this.#pending.has(tab) || restores >= MAX_RESTORES) return;
    this.#pending.add(tab);
    this.#restores.set(tab, restores + 1);
    const restore = async () => {
      this.#pending.delete(tab);
      const now = tab.page.emulated;
      if (now && !tab.page.closed) await tab.page.emulateSize({ width: now.width, height: now.height }, now.zoom);
    };
    void this.#turn(tab, restore).catch(() => { this.#pending.delete(tab); });
  }
}
