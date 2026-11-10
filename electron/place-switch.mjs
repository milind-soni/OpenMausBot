// A click on the window's rail is taken at once and the place asked for last is the one that opens. A click while a
// switch is under way replaces it straight away, whether it goes to another place or back to the one on screen:
// main stops what can be stopped (`stop`) and a server restart that can't be stopped leaves the window alone when it
// ends (`turn`). The rail's page marks the place from its own click; this list says what only main knows (`waking`).

/** The longest a switch stays listed once its work is done, waiting for the new page to finish loading. */
export const PAGE_SETTLE_MS = 30_000;

/**
 * @param {{
 *   changed?(): void,
 *   stop?(): void,
 *   kept?(): unknown,
 *   pageSettled?(): Promise<unknown> | undefined,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 * }} deps `stop()`: ends what the last click had under way, before the new one runs. `kept()`: what the next launch would
 * open, read before a switch starts so going back to the place on screen can put it back. `pageSettled()`: settles once
 * the window's page has finished loading (undefined while it isn't loading).
 */
export function createPlaceSwitch({ changed = () => {}, stop = () => {}, kept = () => null, pageSettled = () => undefined, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let turn = 0, target = null, replacing = false, before = null;
  const tell = () => { try { changed(); } catch {} };
  async function settled() {
    const loading = pageSettled();
    if (!loading) return;
    let timer = null;
    await Promise.race([loading, new Promise((done) => { timer = setTimer(done, PAGE_SETTLE_MS); timer?.unref?.(); })]);
    clearTimer(timer);
  }
  return {
    /** The place the rail's last click asked for, while it opens: `{ id, waking? }`, else null. */
    target: () => target,
    /** Moves with every click. Work that was under way when it moved was replaced. */
    turn: () => turn,
    /** The running click replaced one still under way, so going back to the place on screen has something to undo. */
    replacing: () => replacing,
    /** What the next launch would open from before the switch under way. */
    before: () => before,
    /** My Cloud is being woken for the place asked for, or no longer. */
    waking(on) {
      if (!target || Boolean(target.waking) === on) return;
      target = on ? { ...target, waking: true } : { id: target.id };
      tell();
    },
    /** The rail's click: listed at once, whatever `open` still has to do (it gets `stale()`, true once a newer click came); finished once its page has loaded. */
    async ask(id, open) {
      const mine = ++turn;
      replacing = target !== null;
      if (!target) before = kept();
      target = { id };
      try { stop(); } catch {}
      tell();
      try {
        return await open(() => mine !== turn);
      } finally {
        if (mine === turn) {
          await settled();
          if (mine === turn) { target = null; replacing = false; before = null; tell(); }
        }
      }
    },
  };
}
