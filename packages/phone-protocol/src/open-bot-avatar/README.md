# open-bot-avatar

Vendored sources of [Open Bot Avatar](https://github.com/DominikScholz/open-bot-avatar)
(MIT, see `LICENSE`) at commit `323ce6ab8bc6b0bc9603a418ee3d91442e4996fc`, which npm publishes as
`open-bot-avatar` 0.4.0:

- `*.ts` ← `packages/core/src/*.ts`, the engine: validation, volume, motion and SVG rendering, with no DOM.
  Upstream's `index.ts` (a re-export barrel) and `seams.ts` (nothing imports it) are left out; import each
  module directly.
- `dom/` ← `packages/core/src/dom/`, the browser mount. Only the desktop app uses it; the protocol's own
  type check and the phone copy (`scripts/sync-phone-protocol.mjs`) leave it out.

## Our changes

`render.ts`, `dom/paint.ts` and the finishes below carry our only code changes, each marked `MausBot:`:

- A smile under the eyes (`mouthMark`), drawn with the eyes in the canvas and SVG renderers. The CSS-3D
  `renderAvatarScene` path has no mouth; `mountAvatar` only falls back to it where canvas is missing
  (never in the desktop app).
- With the fluffy material the coat seats only the two eyes, so `dom/paint.ts` paints the mouth flat on top
  of it.
- Two more materials, `matte` and `metallic`, beside `flat` and `fluffy` (`types.ts`, `dom/mount.ts`,
  `dom/paint.ts`, `dom/fluffy/renderer.ts`, `dom/fluffy/shaders.ts`, `dom/fluffy/marks.ts`). They take the
  fluffy path (same mesh, sockets, eye beads and state marks) but draw only the body pass, lit by
  `bareSurface` in the fragment shader under the `finish` uniform; fluffy itself is unchanged.
- The ribbons of `working` and `done` take our six rainbow comet palettes (`COMET_COLORS`) instead of
  shades of the body colour.

Comments in `motion.ts` and `effects.ts` that pointed at an upstream pull request and a third-party demo
now say "a reference animation"; the numbers are unchanged.

`../object-bodies.ts` holds the starters from `examples.ts` and the definitions in the upstream `gallery/*.json`,
each worn under an `obj-` id.

To refresh, copy `packages/core/src` from a newer commit over these files, reapply the changes above, update the commit above and the
gallery definitions, then run the protocol, mascot and sync-phone-protocol tests.
