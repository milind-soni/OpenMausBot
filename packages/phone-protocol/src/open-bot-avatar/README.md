# open-bot-avatar

Vendored sources of [Open Bot Avatar](https://github.com/DominikScholz/open-bot-avatar)
(MIT, see `LICENSE`) at commit `5e64c081971eb296f562544641bad37d40fb36b6`, which npm publishes as
`open-bot-avatar` 0.3.0:

- `*.ts` ← `packages/core/src/*.ts`, the engine: validation, volume, motion and SVG rendering, with no DOM.
- `dom/` ← `packages/core/src/dom/`, the browser mount. Only the desktop app uses it; the protocol's own
  type check and the phone copy (`scripts/sync-phone-protocol.mjs`) leave it out.

## Our changes

Each change is marked `MausBot:`:

- A smile under the eyes (`mouthMark`), drawn with the eyes in the canvas and SVG renderers. The CSS-3D
  `renderAvatarScene` path has no mouth; we never use it.
- The ribbons of `working` and `done` take our six rainbow comet palettes (`COMET_COLORS`) instead of
  shades of the body colour.
- Fur (`fur.ts`, new): three SVG filter styles for the body. `render.ts` draws a still's body slices
  through it with the face on top; `dom/paint.ts` paints a live body on its own bitmap and draws it
  through the same filter (scaled to the canvas) before the face; `types.ts` and `dom/mount.ts` carry
  the `fur` option.

`../object-bodies.ts` holds the starters from `examples.ts` and the definitions in the upstream `gallery/*.json`,
each worn under an `obj-` id.

To refresh, copy `packages/core/src` from a newer commit over these files, reapply the changes above, update the commit above and the
gallery definitions, then run the protocol, mascot and sync-phone-protocol tests.
