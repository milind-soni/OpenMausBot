/**
 * Window-wide pointer tracking for avatars that follow the cursor. Listeners
 * are installed while at least one avatar asks for them and removed after the
 * last one lets go.
 */
import { setPointer } from './clock.ts';

let users = 0;
let detach: (() => void) | null = null;

function attach(): () => void {
  const move = (e: PointerEvent) => setPointer({ x: e.clientX, y: e.clientY });
  const leave = () => setPointer(null);
  // Leaving the window shows up as an `out` with no related target.
  const out = (e: PointerEvent) => !e.relatedTarget && leave();
  // A lifted finger or pen has no position any more.
  const lift = (e: PointerEvent) => e.pointerType !== 'mouse' && leave();
  const hidden = () => document.hidden && leave();
  window.addEventListener('pointermove', move, { passive: true });
  window.addEventListener('pointerdown', move, { passive: true });
  window.addEventListener('pointerout', out);
  window.addEventListener('pointerup', lift);
  window.addEventListener('pointercancel', lift);
  window.addEventListener('blur', leave);
  document.addEventListener('visibilitychange', hidden);
  return () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerdown', move);
    window.removeEventListener('pointerout', out);
    window.removeEventListener('pointerup', lift);
    window.removeEventListener('pointercancel', lift);
    window.removeEventListener('blur', leave);
    document.removeEventListener('visibilitychange', hidden);
    setPointer(null);
  };
}

/** Start tracking the pointer; call the returned function to stop. Safe to call many times. */
export function trackPointer(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (users++ === 0) detach = attach();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users === 0) {
      detach?.();
      detach = null;
    }
  };
}
