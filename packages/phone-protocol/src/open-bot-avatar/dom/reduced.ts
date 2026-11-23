/** The system's prefers-reduced-motion setting, watched once for the whole page. */
import { requestFrame } from './clock.ts';

const QUERY = '(prefers-reduced-motion: reduce)';
let mql: MediaQueryList | null | undefined;

function media(): MediaQueryList | null {
  if (mql === undefined) {
    mql = typeof matchMedia === 'undefined' ? null : matchMedia(QUERY);
    // Live avatars pick up a change on their next frame; wake the loop so they get one.
    mql?.addEventListener('change', requestFrame);
  }
  return mql;
}

export function prefersReducedMotion(): boolean {
  return media()?.matches ?? false;
}
