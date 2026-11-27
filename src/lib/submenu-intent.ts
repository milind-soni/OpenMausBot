export const SUBMENU_DWELL_MS = 250;
export const SUBMENU_GRACE_MS = 300;

export type Point = { x: number; y: number };
export type Box = { left: number; right: number; top: number; bottom: number };

function side(p: Point, a: Point, b: Point): number {
  return (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
}

export function towardSubmenu(from: Point, point: Point, submenu: Box): boolean {
  const edge = from.x <= submenu.left ? submenu.left : submenu.right;
  const top = { x: edge, y: submenu.top }, bottom = { x: edge, y: submenu.bottom };
  const d1 = side(point, from, top), d2 = side(point, top, bottom), d3 = side(point, bottom, from);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

export interface SubmenuIntent {
  enterRow(key: string, hasSubmenu: boolean, point: Point): void;
  leaveRow(key: string): void;
  move(point: Point, onOpenRow: boolean): void;
  leaveMenu(): void;
  enterSubmenu(): void;
  openNow(key: string): void;
  closeNow(): void;
  reset(): void;
  readonly openKey: string | null;
}

const WINDOW_TIMERS = { set: (run: () => void, ms: number) => setTimeout(run, ms), clear: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle) };

export function submenuIntent({ open, close, submenuBox, timers = WINDOW_TIMERS }: {
  open: (key: string) => void;
  close: () => void;
  submenuBox: () => Box | null;
  timers?: { set: (run: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (handle: ReturnType<typeof setTimeout>) => void };
}): SubmenuIntent {
  let openKey: string | null = null;
  let dwell: { key: string; handle: ReturnType<typeof setTimeout> } | null = null;
  let grace: ReturnType<typeof setTimeout> | null = null;
  let anchor: Point | null = null;

  const cancelDwell = () => {
    if (dwell) timers.clear(dwell.handle);
    dwell = null;
  };
  const cancelGrace = () => {
    if (grace) timers.clear(grace);
    grace = null;
  };
  const closeNow = () => {
    cancelGrace();
    if (openKey === null) return;
    openKey = null;
    anchor = null;
    close();
  };
  const openNow = (key: string) => {
    cancelDwell();
    cancelGrace();
    if (openKey === key) return;
    openKey = key;
    open(key);
  };
  const heading = (point: Point) => {
    const box = submenuBox();
    return Boolean(anchor && box && towardSubmenu(anchor, point, box));
  };

  return {
    enterRow(key, hasSubmenu, point) {
      cancelDwell();
      if (openKey !== null && key === openKey) {
        cancelGrace();
        anchor = point;
        return;
      }
      if (openKey !== null) {
        if (heading(point)) grace ??= timers.set(closeNow, SUBMENU_GRACE_MS);
        else closeNow();
      }
      if (hasSubmenu) dwell = { key, handle: timers.set(() => openNow(key), SUBMENU_DWELL_MS) };
    },
    leaveRow(key) {
      if (dwell?.key === key) cancelDwell();
    },
    move(point, onOpenRow) {
      if (onOpenRow) {
        anchor = point;
        return;
      }
      if (grace && !heading(point)) closeNow();
    },
    leaveMenu() {
      cancelDwell();
      if (openKey !== null) grace ??= timers.set(closeNow, SUBMENU_GRACE_MS);
    },
    enterSubmenu() {
      cancelGrace();
    },
    openNow,
    closeNow,
    reset() {
      cancelDwell();
      cancelGrace();
      openKey = null;
      anchor = null;
    },
    get openKey() {
      return openKey;
    },
  };
}
