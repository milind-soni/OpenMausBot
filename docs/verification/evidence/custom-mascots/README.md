# Custom mascot verification

This evidence is bound to runtime commit `cf5f530bbb176b769e89be869352df981c764a82`. The screenshots and motion clip are fresh captures from that commit; no earlier-runtime screenshots or video are included.

## Build and CI

- `pnpm build` passed in receipt `20261021T232757Z-21d22407`.
- Check [PR #3240](https://github.com/milind-soni/OpenMausBot/pull/3240) for the live checks on the current head. This evidence does not claim that the full `pnpm test` run has passed.

## UI results

- In Settings Simple mode, opened the creator at a 900×600 viewport and imported [bunny.svg](bunny.svg) through the visible file chooser. Default face fitting passed and Save was enabled without adjustment; the save returned HTTP 201.
- The applied Bunny has a non-square silhouette in the settings preview, header, and sidebar. The saved numeric profile contains 512 outline points and anchor `{ x: 113.824, y: 150.426, scale: 0.6237 }`; raw SVG is not persisted.
- Reload retained the selected Bunny. Copying it to a second fixture bot through the UI returned HTTP 201 and retained the numeric outline.
- The native Cat (`kitten`) and existing Halloween Cat (`cat`) each returned HTTP 200 with matching profile readback. Reset returned to `cursor` with HTTP 200 and retained the saved mascot library.
- Working was selected before motion capture. The body transform changed during a measured 17.107-second observation with controls unchanged. [motion.mp4](motion.mp4) is an approximately 10-second, normal-speed segment from the actual UI recording; the container has 250 frames at 25 fps.

[Before](before.png) · [Creator](creator.png) · [Short viewport](short-viewport.png) · [Applied](applied.png) · [Reload](reload.png) · [Cross-bot reuse](reuse.png)

[Native Cat](native-cat.png) · [Halloween Cat](halloween-cat.png) · [Reset with library retained](reset-library.png) · [Bunny restored](bunny-restored-after-cat.png) · [Working selected](working-expression.png)

[Motion start](motion-t0.png) · [Motion middle](motion-t5.png) · [Motion end](motion-t9.png) · [Motion clip](motion.mp4)

Asset URLs, HTTP statuses, source hashes, media hashes, motion samples, and the sanitized action receipt are in [proof.json](proof.json). The image captures are original browser screenshots; the video is a crop of an actual UI recording, with no compositing.

Media hashes refer to repository bytes. The file chooser used a Windows CRLF working copy of `bunny.svg`; Git publishes the equivalent LF-normalized SVG. The receipt records both hashes.

## Verification limits

The run used a headless Chromium production web renderer with a disposable fake-CLI fixture, a browser loopback allowlist, and no provider turns. No Node outbound preload was installed. Installed Electron and mobile UI were not exercised.

The fresh cf5 action and motion captures recorded no page errors, console warnings, or console errors. A prior receipt for the 1dcc run recorded 12 nonfatal SVG negative-ellipse messages while visiting built-in/Halloween states. That historical observation is separate from these cf5 captures; its baseline origin is unknown.
