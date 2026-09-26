# Mobile touch control for remote surfaces

Status: approved design, phase 1 in progress
Date: 2026-09-18

A touch gesture layer that lets an iOS or Android companion drive a remote
surface — first a bot's browser, later a bot's cloud desktop — with the
precision needed for sustained work rather than occasional rescue.

## Why

`ComputerView` and `ComputerScreen` already show a bot's screen on a phone.
Both are deliberately view-only; the iOS file says so in its own header:
"no clicking, no typing, no control." That was the right call when watching
was the whole feature. The goal now is the other half: real work from the
phone, including typing, shortcuts, selection and precise clicking.

The browser surface needs no new protocol. `server/browser-live.ts` already
accepts `input_mouse`, `input_keyboard` and `char` over plain HTTP POST, and
streams frames over SSE. What is missing is a client that can turn fingers
into those events well.

## Scope

Phase 1 — the gesture core plus the browser surface on both platforms.
Phase 2 — the same core driving a vendored noVNC bridge for the cloud desktop.

Phase 2 is designed for here but not built here. It is the reason the core
emits abstract intents instead of HTTP bodies.

Out of scope, deliberately: three-finger gestures, stylus pressure, gesture
record and playback, and remote-side zoom.

## Architecture

No gesture logic lives in a view on either platform.

```
TouchSample(id, phase, x, y, t)  ->  [ GestureCore ]  ->  Intent
                                          |               .move(x, y)
                                     mode: direct         .press(button, clicks)
                                           trackpad       .release(button)
                                     zoom/pan state       .scroll(dx, dy)
                                     click sequencer      .text(String)
                                                          .key(name, modifiers)
```

`GestureCore` lives in the shared modules — `CompanionCore/RemoteGestures.swift`
and `android/core/.../RemoteGestures.kt`. It is pure: no networking, no
platform types, no clock of its own (time arrives on each sample).

Coordinates crossing the core boundary are always normalised 0..1 against the
remote surface. The core never learns the frame's pixel size, the letterbox
offsets or the zoom transform. A separate `ViewportMapping` value owns that
conversion and is the only thing that thinks in pixels. That seam is what lets
one core serve a 1280x720 browser viewport and a 1920x1080 desktop unchanged.

Two thin adapters bracket it:

- **Platform in** — `UIGestureRecognizer` on iOS, `pointerInput` /
  `awaitPointerEventScope` on Android. Their only job is producing
  `TouchSample`. They make no decisions.
- **Protocol out** — an `IntentSink` per surface. `BrowserLiveSink` maps
  intents to `input_mouse` / `input_keyboard` / `char` bodies and posts them.
  Phase 2 adds `VncSink` against the noVNC bridge. Neither sink knows a finger
  exists.

The cost is one indirection and roughly 150 lines of uninteresting adapter per
platform. The return is that the hard parts — double-tap windows, drag
thresholds, zoom anchoring, mode switching — are tested in modules that
already carry 39 (iOS) and 30+ (Android) test files, with no simulator or
emulator in the loop, and iOS and Android cannot drift apart.

## Gesture vocabulary

Two modes on deliberately different metaphors, user-switchable from a toolbar
toggle, persisted per surface.

### Direct mode — a touchscreen

One finger acts on content; two fingers act on your view of it.

| Gesture | Intent |
|---|---|
| Tap | `move` then `press(left, 1)` then `release` |
| Double / triple tap | same, `clicks: 2` / `3` |
| Long press (500 ms, 10 pt tolerance) | `press(right, 1)` then `release` |
| Long press then drag without lifting | `press(left)` held, `move` while dragging, `release` on lift |
| One-finger drag | `scroll` |
| Two-finger drag | pan the local view |
| Pinch | zoom the local view |

### Trackpad mode — a laptop trackpad

| Gesture | Intent |
|---|---|
| One-finger drag | `move`, cursor travels with acceleration |
| Tap | `press(left, 1)` then `release` at the cursor |
| Two-finger tap | `press(right, 1)` then `release` |
| Tap, then press and drag | `press(left)` held through the drag |
| Two-finger drag | `scroll` |
| Pinch | zoom the local view |

The protocol has no relative-move event — `x` and `y` are always required — so
in trackpad mode the core owns a virtual cursor in normalised space and emits
absolute coordinates. Both modes therefore share one sink.

### Constants

These are part of the contract, not tuning left to each platform. A value that
differs between iOS and Android is a bug the shared fixture must catch.

| Name | Value | Meaning |
|---|---|---|
| `multiClickWindowMs` | 450 | Max gap between taps to extend a click sequence |
| `multiClickSlopNorm` | 0.02 | Max normalised movement between taps in a sequence |
| `longPressMs` | 500 | Hold before a long press fires |
| `longPressSlopNorm` | 0.015 | Movement that cancels a pending long press |
| `dragThresholdNorm` | 0.01 | Movement before a touch becomes a drag |
| `maxClicks` | 3 | Sequence wraps back to 1 after a triple |
| `minZoom` / `maxZoom` | 1.0 / 6.0 | Local zoom bounds |
| `momentumDecayPerFrame` | 0.94 | Per-frame velocity decay at 60 fps |
| `momentumCutoffNormPerFrame` | 0.0004 | Velocity below which momentum stops |

Trackpad acceleration is a fixed two-segment curve on pointer speed `v`,
measured in normalised units per second:

```
gain(v) = 1.0                    when v <= 0.35
gain(v) = min(3.0, 1.0 + (v - 0.35) * 2.5)   when v > 0.35
```

Monotonic, continuous at the join, and capped so a fast flick cannot throw the
cursor across the screen unrecoverably.

### Three details that decide whether this feels good

**The cursor is local.** It is drawn at 60 fps and never waits for the network;
only the sends are throttled. This is the single most important property for
sustained use: the round trip stops being visible because the thing under your
finger is local. Direct mode gets the cheaper version — a touch ripple so a tap
feels acknowledged before the frame catches up.

**Zoom is local, never remote.** Pinching magnifies the received frame and
never sends a zoom to the remote page, so small targets become reachable
without reflowing the site. `ViewportMapping` already does the arithmetic.

**Momentum scroll is client-generated** — decaying deltas after lift, emitted
at 60 fps. Safe because the input queue coalesces consecutive `mouseWheel`
events by summing deltas, so a flick collapses to a few sends, not sixty.

## Keyboard

This is where sustained use is won or lost, and it is much cheaper than
expected because the server already does the hard part.
`server/browser-live.ts` accepts `eventType: "char"` with plain text and turns
it into `insertText`; it resolves named keys (`Backspace`, `Enter`, `Tab`,
`Escape`, arrows, `Home`, `End`, `PageUp`, `PageDown`) itself; and it converts
a modifier bitmask into a chord such as `Control+c`. **A mobile client never
needs a virtual keycode table.**

- A hidden text field captures the soft keyboard. Committed text becomes
  `.text(String)` and ships as `char`.
- Backspace, Enter, Tab and arrows become `.key(name)`.
- A modifier accessory bar sits above the keyboard: `Ctrl` `Alt` `Cmd` `Esc`
  `Tab` and arrows. Tapping a modifier latches it; the next key ships with the
  bitmask (Alt 1, Control 2, Meta 4, Shift 8) and the server forms the chord.
- Hardware keyboards on iPad and Android pass through directly.

Without the accessory bar there is no Cmd-L, no Cmd-T, no Escape and no Tab
between fields, and therefore no real work.

## Control, auth and failure

### Permission

Add `browserControlAccess: boolean` to `DeviceRecord` in
`companion/src/devices.ts`, defaulting off for every new and migrated device,
mirroring the existing `cloudDesktopAccess` flag exactly: toggled only from the
loopback-only control page, with revocation tearing down live sessions through
`disconnectDevice`.

Then allowlist `/api/bots/:id/browser/live` and `/api/bots/:id/browser/action`
in `companion/src/routes.ts` behind that flag.

**No change is needed at `server/index.ts:11570`, contrary to this document's
first draft.** The harness imports the sidecar's own `denyReason`
(`server/request-auth.ts:16`) and re-runs it on every companion request, so
adding the two routes to `ALLOWED` opens both sides at once — defence in depth
that already exists. A sidecar-forwarded request then resolves to
`kind: "loopback"`, which the browser route already treats as `local-owner`.
The per-device capability check stays in the proxy, exactly where
`cloudDesktopAccess` enforces its own.

**It is a separate flag, not a reuse of `cloudDesktopAccess`.** The two look
alike and are not. A cloud desktop is a disposable VM; a bot's browser is
typically signed into the owner's real accounts. A device trusted with a
throwaway VM last month must not silently acquire the ability to drive a
logged-in mailbox because we shipped an update.

### Driving state

`take` and `release` are the whole model. The gesture core is inert unless the
surface is `driving`, so a stray touch while watching can never reach the
remote. Held inputs must flush on three events — explicit release, app
backgrounding, and connection loss — releasing in reverse order and never
replaying typed text or a click. `createBrowserPressedInputs.release()` in
`src/components/BrowserViewport.tsx` is the reference behaviour.

### Input queue

Port `src/lib/browser-input-queue.ts` to both shared cores: one request in
flight, movement coalesced behind it, keyboard and button order preserved, a
hard ceiling so a slow link cannot bank minutes of input, and no replay on
reconnect. This is not polish. Without it a single flick is sixty round trips
and the session wedges.

### Bandwidth

Frames are hundreds of KB of base64 each. On cellular, cap frame rate and
refuse the highest resolutions by default, behind an explicit high-quality
opt-in. The existing `watchScreen` / `stopWatchingScreen` pattern — streams off
unless a view is on screen — is the shape to follow.

### Contention

`browser-live.ts` caps viewers at 8 total and 2 per session, so a phone
competes with an open desktop panel. Surface that 429 as a real message
("this browser is open on your Mac, close it there first"), not a generic
failure.

## Testing

The core is pure, so its tests are table-driven and run on both platforms from
one shared list of cases:

- **Click sequencing** — tap, double, triple, and the boundary either side of
  the multi-click window; a move beyond tolerance breaks the sequence.
- **Long press** — fires at the threshold; cancelled by movement beyond
  tolerance; cancelled by a second finger.
- **Mode equivalence** — the same `TouchSample` script through both modes
  produces the documented intents and nothing else.
- **Cursor arithmetic** — trackpad acceleration is monotonic, and the cursor
  clamps to 0..1 without wrapping.
- **Zoom anchoring** — the point under the pinch centre stays under it, and
  pan clamps at the frame edges.
- **`ViewportMapping`** — letterboxed frames map correctly at several aspect
  ratios; out-of-bounds touches are rejected when not captured.
- **Held-input flush** — release, backgrounding and disconnection each emit
  releases in reverse order, with no text replay.
- **Queue** — movement coalesces, wheel deltas sum, key order survives, the
  ceiling holds, reconnect does not replay.

Parity is enforced by keeping the case list in a shared fixture, so a
behaviour added on one platform fails the other until it is added there too.

Platform adapters get thin tests only: that a recognizer produces the expected
`TouchSample` sequence. Anything more belongs in the core.

## Phase 2 sketch

Vendor noVNC into the app server and serve one page we control, pointed at the
backend's existing websockify socket, reached through the relay that
`companion/src/viewer-relay.ts` already provides. The native layer drives it
through a bridge we own — `WKWebView` on iOS, `WebView` on Android — so the
same `GestureCore` emits into `VncSink` instead of `BrowserLiveSink`.

This replaces today's arrangement, where iOS hands the provider's own
`vnc.html` to `SFSafariViewController` and inherits whatever mobile handling
that noVNC build happens to have. Vendoring means one version, one bridge and
both platforms.

A native RFB client was considered and rejected for now: it reimplements a
mature library, and encoding bugs are miserable to debug. Revisit only if the
webview proves too slow.
