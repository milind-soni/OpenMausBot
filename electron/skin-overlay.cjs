// The native chrome CSS cannot reach (the Windows caption-button overlay accepts no alpha, so opaque hex).
// Keep in step with src/styles.css and src/lib/skins.ts.
"use strict";

const SKIN_CHROME = Object.freeze({
  midnight: Object.freeze({ color: "#121212", symbolColor: "#b5b5b5" }),
  atelier: Object.freeze({ color: "#f5f1eb", symbolColor: "#6b6559" }),
  foundry: Object.freeze({ color: "#100e0b", symbolColor: "#b0a696" }),
  lagoon: Object.freeze({ color: "#dfeceb", symbolColor: "#4d5c5b" }),
  graphite: Object.freeze({ color: "#111214", symbolColor: "#b3b8c2" }),
  linen: Object.freeze({ color: "#eceff3", symbolColor: "#59616c" }),
  dusk: Object.freeze({ color: "#121014", symbolColor: "#b9afbd" }),
  daylight: Object.freeze({ color: "#fcfcfc", symbolColor: "#575757" }),
  meadow: Object.freeze({ color: "#ffffff", symbolColor: "#4d5a52" }),
  pop: Object.freeze({ color: "#fdf5ea", symbolColor: "#3a322d" }),
  halloween: Object.freeze({ color: "#110d16", symbolColor: "#c2b3cc" }),
});

const DEFAULT_SKIN = "midnight";

function skinChrome(skin) {
  return Object.hasOwn(SKIN_CHROME, skin) ? SKIN_CHROME[skin] : SKIN_CHROME[DEFAULT_SKIN];
}

function isKnownSkin(skin) {
  return Object.hasOwn(SKIN_CHROME, skin);
}

module.exports = { SKIN_CHROME, DEFAULT_SKIN, skinChrome, isKnownSkin };
