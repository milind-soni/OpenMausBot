# Avatar motion

Run `pnpm verify:avatar-motion`. The script launches a disposable fake-engine
server and prints the URL of the renderer fixture. Keep that process running
while using the page; Ctrl-C stops only its own server and temporary home.
No real bots, messages, provider credentials or application preferences are used.

The fixture renders the production `MausAvatar` and `BotAvatar` at 32, 56 and
112 pixels. Its selectors use the production expression, body and color
catalogs. Use **Run checks** for mounted React behavior, then inspect shape
changes and reaction buttons at normal playback speed.

For a shareable static demo, run `pnpm build:avatar-demo` and serve
`dist-avatar-demo` with any static host. It renders the production avatars with
synthetic task phases and catalog controls, without a server, model calls or
application storage. Its relative asset paths support deployment in a subfolder.
The demo is a separate build entry and is not bundled into the application.
Changing shape, color or resting expression preserves the selected task and
sequence playback. Use the separate reaction buttons to request a spin.

## Improvements and scope

The implementation starts from upstream `0345041dc31b8958cdb3e48440c4380ddd23c165`.

| Improvement | Implementation |
| --- | --- |
| Clearer small avatars | Solid color, smaller dark eyes and an optional mouth |
| Additional shapes | Pill, wedge and cloud alongside the existing ten; saved body IDs remain compatible |
| Continuous shape changes | Contour and face-anchor interpolation; one intermediate path supplies body and clip |
| Stable appearance after updates | Task, color and pause changes preserve the current artwork and clip instead of restoring the initially mounted shape |
| Faces stay within their silhouette | Shape-aware projection moves the face together, including the optional mouth, while retaining perspective and intentional back-face hiding |
| Brief customization feedback | A humming reaction with a turn and colored trails, followed by the habitual expression |
| Consistent entrances | Entrance timing starts on the instance's first frame |
| Task phases visible in the face | Thinking between tools, working during pending tools, attention while waiting, distinct lost-contact and stopped states |
| Continuous task movement | A damped pose offset bridges state changes while preserving each authored motion cycle |
| Accurate completion feedback | Only a successful completed turn celebrates; interruption is neutral and tool retries do not celebrate |
| Finite reactions | Store events expire after 1.4 seconds; stale timers cannot clear newer events or replay after reopening a profile |
| No repeated completion feedback | A bounded history consumes completion identities and ignores known turns superseded by a later start in the same thread |

Task activity overrides the chosen resting expression. The sidebar retains
aggregate bot activity; the chat retains its selected task's activity.
Completion deduplication retains 64 recent identities. A completion whose start
was not observed remains valid, including after reconnect; unknown opaque IDs
are not assumed to be older than observed turns.
Image avatars keep their existing rendering path. Spring parameters are visual
tuning; they do not represent a physical simulation of a material.

## Required checks

- Every selectable expression renders distinct eyes while paused.
- Paused expression/gaze changes repaint once and remain stationary.
- Body and clipping contour remain identical through a shape transition.
- A Hexagon-to-Cursor change retains Cursor artwork and clipping after task,
  color and pause/resume updates.
- Visible Cursor eyes remain inside the rendered outline at side turns and
  gaze extremes, including authored task expressions.
- Interrupting a reaction restores the habitual state before its timer expires.
- An entrance mounted after page startup still begins small.
- Thinking, tool execution, approval, result, cancellation, retry and lost contact
  keep the same body/color and resolve to their expected expression.
- Prolonged work continues its cycle, then stops repainting when paused.
- A new task phase cancels an older reaction; terminal feedback survives the
  following idle snapshot without extending its original deadline.
- Selecting or customizing a bot preserves waiting, lost-contact and stopped
  expressions, without replaying a canceled reaction when attention clears.
- A simulated media-preference change stops motion and effects, blocks explicit
  blink/spin, accepts static state changes and resumes after returning to normal.
- The separate native preference check requires browser media emulation or an
  OS setting already enabled; a skipped native check is not native validation.

Unit tests cover spring convergence at 30/60/120 Hz, interrupted targets,
all body-pair contours, expression selection, artwork generation, confirmed
turn outcomes, sibling tasks, retry events and nonce-protected expiry. The body
generator checks face containment and emits synchronized web/Swift/Kotlin
catalogs; `pnpm gen:bodies` also regenerates the interpolation points.
Face projection tests compare against independently flattened artwork for all
13 bodies and 25 expressions, both eye scales, five gaze positions, optional
mouth strokes, hemisphere transitions and interrupted morphs. Generated motion
points use LF on Windows too, matching the other generated catalogs.

The new animation engine is desktop/web. Mobile catalogs contain the added
figures; this does not claim mobile animation parity or a native build check.

## Evidence

[Browser results](evidence/avatar-motion/browser-checks.json) and
[rendered catalog](evidence/avatar-motion/preview.png) accompany this recipe,
along with the [task lifecycle preview](evidence/avatar-motion/task-lifecycle.png).
The fixture supplies synthetic task state to production components; its visual
checks do not establish every provider's runtime event ordering. Native OS
reduced-motion coverage is reported separately from the simulated preference.

Validation on 2026-09-13:

- 236 focused tests passed in 16 files after the final changes, including face
  projection, store completion identity, body generators, profile validation and
  the documentation index.
- Production client/server build, static demo build, repository lint and generator
  drift checks passed. Broker, Electron and packaged-server checks passed before
  the Cursor follow-up; those unrelated checks were not repeated for this update.
- The full Vitest run passed 6,657 tests and initially failed three. The catalog
  message and recipe-index failures were corrected and their 20 tests passed on
  rerun. The remaining `server/bot-continuity.e2e.test.ts:53` failure also reproduces
  unchanged on upstream `0345041d`: it expects an older setup instruction. The full
  command therefore is not reported as passing; 54 tests were skipped and one was todo.
  The full suite was not repeated for the Cursor follow-up.
- 17 mounted-browser scenarios passed, including Cursor face containment,
  artwork/clip preservation after React updates, the real StoreProvider expiry
  effect and avatar remount. The native reduced-motion check was skipped; the
  simulated preference change passed.
- The static preview was verified with task, shape, color and pause changes.
  Appearance changes preserve task playback; spins use their explicit control.
- Native mobile builds and provider-specific live runtime sequences were not run.
