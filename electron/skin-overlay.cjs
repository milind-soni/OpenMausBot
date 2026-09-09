// The native window chrome that CSS cannot reach, per skin. Everything the
// renderer paints follows `[data-skin]` in src/styles.css; the Windows
// caption-button overlay and the window's own background are drawn by the
// main process and have to be told the same colours. The values mirror each
// skin's `--color-app` (the header strip is `bg-app`) and, for the symbols,
// its `--color-ink-secondary` — flattened to opaque hex because the overlay
// accepts no alpha. Keep in step with src/styles.css and src/lib/skins.ts.
"use strict";

const SKIN_CHROME = Object.freeze({
  midnight: Object.freeze({ color: "#070707", symbolColor: "#b5b5b5" }),
  atelier: Object.freeze({ color: "#f5f1eb", symbolColor: "#6b6559" }),
  foundry: Object.freeze({ color: "#100e0b", symbolColor: "#b0a696" }),
  lagoon: Object.freeze({ color: "#dfeceb", symbolColor: "#4d5c5b" }),
  graphite: Object.freeze({ color: "#111214", symbolColor: "#b3b8c2" }),
  linen: Object.freeze({ color: "#eceff3", symbolColor: "#59616c" }),
  dusk: Object.freeze({ color: "#121014", symbolColor: "#b9afbd" }),
  daylight: Object.freeze({ color: "#fcfcfc", symbolColor: "#575757" }),
});

const DEFAULT_SKIN = "midnight";

/** The chrome colours for a skin id sent by the renderer. Anything that is
 * not a known skin — a renamed skin, a stale value, a non-string — falls
 * back to Midnight rather than throwing, because the renderer has already
 * painted and a wrong overlay is recoverable while a broken IPC is not. */
function skinChrome(skin) {
  return Object.hasOwn(SKIN_CHROME, skin) ? SKIN_CHROME[skin] : SKIN_CHROME[DEFAULT_SKIN];
}

/** True when the id names a skin this module knows. A non-string coerces to a
 * property key that cannot match a skin id, so it answers false without a
 * separate type guard. */
function isKnownSkin(skin) {
  return Object.hasOwn(SKIN_CHROME, skin);
}

module.exports = { SKIN_CHROME, DEFAULT_SKIN, skinChrome, isKnownSkin };
