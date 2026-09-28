# Android Live calls

The phone holds its own WebRTC audio to OpenAI GPT-Live; the paired computer
creates the session (its OpenAI key never leaves it) and runs the call. The
chat stays on screen with a call bar above the composer. Never pair a
verification build with your everyday workspace, and never point one at the
sidecar of the OpenMausBot you use day to day; the fixture below gets its own
ports.

## Unit suites

From `android/`, with a JDK 17 in `$JAVA_HOME` and the Android SDK
configured (`$ANDROID_HOME`, or `sdk.dir` in `local.properties`):

```sh
./gradlew :core:cleanTest :core:test :app:cleanTestDebugUnitTest :app:testDebugUnitTest \
  :app:assembleDebug :app:assemblePreview
./gradlew :core:test --tests '*LiveCall*' --tests '*StoreTest*'
./gradlew :app:testDebugUnitTest --tests '*LiveCall*' --tests '*LiveCaptions*' --tests '*TransportCloseGuard*' \
  --tests '*VoiceNoteWiringTest*'
```

A bare `cleanTest` does not reach `:app:testDebugUnitTest`, so the first line
names both clean tasks; count the results with
`grep -h '<testsuite ' */build/test-results/**/*.xml`.

`:core` covers the four `/api/live/*` calls against a loopback server (the
offer byte for byte, the two 409 shapes, the 35 s session client), the
`live.call` frame both ways (a frame without a `call` key is broken, not a
free line; a status this build does not know counts as running), the store,
and `Session`'s reads of the line: the call is re-read after a fresh hello,
but that answer, and a hang-up's, never overwrite newer news (a frame that
landed meanwhile, a newer call), and a hang-up answered 404 for a call the
line still shows reads the line again. `:app` covers the manager's state
machine with a fake transport: "Connecting…" until the computer reports the
call attached and the data channel is open, with the clock counting from that
moment on the phone's own clock; "Hanging up…" until the computer confirms
(its answer, an `ended` frame, or 8 s); Try again only after a drop or a
failed start (never after an end that is not a drop, a missing key, a busy
line, a denied microphone or a lost pairing); the computer's reason, and
whether it was a drop, replacing a plain "Call ended." that the data channel
brought first; the first-call disclosure, due until Start call and kept on
the phone; a lost pairing hanging up at once and a switch of computer
leaving the call behind; the speaker choice kept on the phone; microphone
denied, needsKey, busy, this phone's own ending call in a 409, a rejected
answer, a frame that beats the 201, hang up while the offer is built or
during setup, frames about other calls, a computer that restarts, process
`ON_STOP` versus an Activity pause; and on virtual time, audio not connected
20 s after the answer drops the call once, and never a call that connected,
was hung up first or came later. Also the end words (the desktop's, for every
reason), the captions rule, the bar (a long notice wraps whole with its
buttons under it on a 360 dp phone up to 130 % font; the caption line keeps
its newest words; "Hanging up…" has no buttons; an end Try again cannot fix
has only the cross), the settings form (what a call sends to OpenAI, what
turning off typed replies keeps back), the banner, the voice preview and
voice notes staying off during a call (refused at the players' focus gate
too, so a note whose download finishes after the call started waits for it
to end), the audio route's device choice, and one Robolectric pass through
the real chat screen: the phone button, the first-call disclosure (Cancel
starts nothing and asks again; Start call starts the call and is not asked
again), the 201, "Connecting…", the computer's `live` frame, the bar, Hang up
on the computer, the phone button hidden during a call and while another
device holds one, and the remote bar for a call another device holds.
`TransportCloseGuardTest` pins that a hang-up during "Connecting…" fails the
pending WebRTC wait instead of touching a disposed peer.
`LiveCallNativeIsolationTest` pins that only
`audio/WebRtcLiveCallTransport.kt` imports `org.webrtc`, so the JVM suite
never loads the native library.

## Emulator smoke against the fixture

Three terminals on the host computer, from the repository root:

```sh
# 1. The fake GPT-Live (prints its base URL)
node --experimental-strip-types server/testing/fake-openai-live.ts 0

# 2. The fixture, pointed at the fake (prints http://127.0.0.1:PORT and its logPath)
OMB_OPENAI_LIVE_URL=http://127.0.0.1:FAKE_PORT OMB_OPENAI_LIVE_KEY=sk-fake \
  node --experimental-strip-types scripts/control-omb.ts launch

# 3. A sidecar for that fixture, on ports your everyday OpenMausBot does not use
OMB_PORT=PORT OMB_WEBHOOK_PORT=$((PORT + 1)) OMB_COMPANION_PORT=8820 OMB_CONTROL_PORT=8821 \
  OMB_COMPANION_NAME="Verification fixture" OMB_COMPANION_DIR="$(mktemp -d)" \
  node --experimental-strip-types companion/src/index.ts
curl -s -X POST http://127.0.0.1:8821/pairing      # → { …, code, token }
```

The sidecar advertises itself on the local network while it runs;
`OMB_COMPANION_NAME` keeps it apart from the real computer in the phone's
lists. The fake's SDP answer is built from the phone's offer, so the phone
accepts it; its one ICE candidate is a loopback address nobody listens on, so
no audio ever flows and the call's data channel never opens.

Then an arm64 API 35+ emulator (Android 15 or later; the checks below were
written on Android 17 and Android 15 images). Host audio is not needed
(nothing answers the audio), so the host's microphone stays out of it:

```sh
SDK=$ANDROID_HOME
$SDK/emulator/emulator -avd YOUR_ARM64_API35_PLUS_AVD -no-snapshot &      # add -no-window to run headless
$SDK/platform-tools/adb wait-for-device
until [ "$($SDK/platform-tools/adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 5; done
$SDK/platform-tools/adb install -r android/app/build/outputs/apk/preview/app-preview.apk
$SDK/platform-tools/adb shell am start -n com.openmausbot.companion.preview/com.openmausbot.companion.MainActivity
```

In MausBot Preview, tap Connect my computer, then Other ways to connect, and
pair manually with the address `10.0.2.2:8820` and the code from the curl (the
emulator reaches the host at 10.0.2.2; ask for a new code if the window
closed). On Android 17 two system prompts come first:

- **"Choose a device to connect"** lists every OpenMausBot computer the
  emulator can see on the network, the real one included. Tap **Don't
  connect**; never pick the real computer.
- **Nearby devices** ("find, connect to, and determine the relative position
  of nearby devices"). On Android 17 this also grants local-network access,
  which the app needs to reach `10.0.2.2` even when the address is typed. With
  **Don't allow**, Connect fails with "Couldn't reach this computer through any
  available route (http://10.0.2.2:8820)". Tap **Allow**, or grant it from the
  host and tap Connect again:
  `adb shell pm grant com.openmausbot.companion.preview android.permission.ACCESS_LOCAL_NETWORK`.

Android 15 shows only the Nearby devices prompt, and pairs by address with
Don't allow. Skip the notifications screen with Not now.

The sidecar path works against this fixture: it speaks to the harness from
loopback, which a headless fixture trusts, so pairing directly to the harness
was not needed. If you do pair that way instead
(`docs/verification/android-server-pairing.md`; the manual form takes
`10.0.2.2:PORT` and a code from `POST /api/auth/pairing`), keep the code's
default scopes: the `/api/live/*` routes are admin-scoped on the harness, so a
client-only pairing gets `403` in the bar.

**Check A — this phone's call.** Open the fixture's bot (Kiwi) and tap the
phone icon in the header ("Call Kiwi"). The first time on this phone a dialog
says "A Live call sends your voice to OpenAI, along with the chat's recent
messages, the bot's answers and the details of any approval it asks for. The
OpenAI key stays on your computer." with Start call and Cancel. Cancel starts
nothing (`GET /api/live/call` stays `{"call":null}`) and the next tap shows the
dialog again; Start call starts the call, and the dialog does not come back on
this phone, also after the app is closed and opened again. Allow the
microphone (While using the app).
The bar reads "Connecting…" with the settings gear, Mute and Hang up, and the
header's phone icon is gone. `curl -s http://127.0.0.1:PORT/api/live/call`
shows the call with `"client":"android"` and `"status":"live"`: the fixture's
side attached. The bar still says "Connecting…", because it goes live only
once the computer reports the call attached *and* the phone's data channel is
open, and the fake's audio never connects (its one candidate is a loopback
address nobody listens on), so the channel never opens. The phone gives up at
about 20 seconds: the bar reads "Call dropped: the audio could not connect."
with Try again and the cross, `GET /api/live/call` turns `{"call":null}` as
after a Hang up, the phone icon is back, and the log line says `end=hung-up`
(the phone's own end request). Each check below fits in one call; Try again
starts a fresh one with its own 20 seconds.

- Mute turns into Unmute and back.
- The gear opens Live call settings: first the sentence on what a call sends
  to OpenAI ("A Live call sends your voice to OpenAI, along with the chat's
  recent messages, the bot's answers and the details of any approval it asks
  for. The OpenAI key stays on your computer."), then Speaker and Earpiece,
  the 22 voices, "Read replies to typed messages" with "When this is off,
  messages you type during a call and the bot's answers to them are not sent
  to OpenAI." under it, and the idle minutes 1, 2, 3, 5, 10, 15, 30 and 60.
  Done closes it. The emulator has no earpiece, so the call stays on its
  speaker either way; the choice is still there after the app is closed and
  opened again.
- Back to the bot list: a banner "Connecting…" with Hang up sits on top;
  tapping it returns to the chat, and its Hang up ends the call from there.
- Hang up: the bar reads "Hanging up…" with no buttons until the fixture
  answers (well under a second), then goes; the phone icon comes back, and
  `GET /api/live/call` is `{"call":null}`. The fixture's log (the `logPath`
  the launch printed) has one `[live] call started … client=android` and one
  `[live] call ended … end=hung-up errors=none` line per call, and no speech.
- A voice note in the chat (the fixture's fake engine sends none by itself;
  any bot reply with an audio attachment will do): during the call its play
  button is dimmed and does nothing, and "Voice notes can't play during a
  Live call." sits under it. After Hang up it plays again. A note tapped
  just before the call, whose download finishes during it, does not play
  either: it waits with the same line and plays after Hang up without
  downloading again. `VoiceNoteWiringTest` pins both without an emulator.
- Press Home during a call: within a few seconds the computer ends it
  (`{"call":null}`); back in the app the bar reads "Call ended." with only
  the cross (leaving the app is not a drop), and the phone icon starts a
  fresh call.
- Deny the microphone once: the bar reads "Live calls need Microphone access.
  Enable it in Settings → MausBot." with only the cross (trying again cannot
  help until the setting changes); after allowing it in Settings, the phone
  icon asks again.

A notice that fits beside its buttons stays on their line ("Call ended."). A
longer one wraps, up to three lines, with the buttons under it: on a
1080-pixel-wide screen the microphone one above takes two lines, and nothing
is cut off.

`adb logcat -b crash -d` stays empty. WebRTC logs under `org.webrtc.Logging`
(the app itself logs nothing about calls).

**Check B — a call from the computer.** From the host (the fixture accepts
loopback):

```sh
BOT=$(curl -s http://127.0.0.1:PORT/api/bots | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).bots[0].id))')
curl -s -X POST http://127.0.0.1:PORT/api/live/session -H 'content-type: application/json' \
  -d "{\"botId\":\"$BOT\",\"sdp\":\"v=0\\r\\n\",\"client\":\"desktop\"}"
```

The phone's chat shows "Live with Kiwi · 0:0x" over "From your computer", with
only Hang up, and the header's phone icon is gone while that call runs (a call
from here would only be refused as busy). Go back to the bot list during the
call: no banner (a call another device holds shows only in its chat). Tap
Hang up in the chat: the bar goes and `GET /api/live/call` is
`{"call":null}`; the phone icon comes back; the log adds a `client=desktop`
pair of lines. A remote bar never shows while that call is `ending`.

**What this cannot show.** Audio in either direction, captions, the live bar
("Live with Kiwi · m:ss", whose clock starts the moment the call went live on
the phone) and its banner, "via call" messages from a real spoken request
(the fake plays no delegation from the outside), a call whose audio connects
and so stays up past 0:20, a plain "Call dropped." and "Could not connect the
call audio." (the fake's answer is accepted and its audio never connects, so
it never fails either), the speaker/earpiece route on hardware (the emulator
has no earpiece), the idle hang-up ("Call ended after a long silence.", which
also checks that the computer's reason replaces the data channel's plain
"Call ended."), which the 20-second drop always beats, and a pairing revoked
mid-call ("Call ended: you were signed out.", or the computer's own words
when its frame gets there first). Real audio needs a physical phone, a
real OpenAI key on the computer and someone to talk to the bot: that is the
pre-PR check the spec requires, and there a call must go live and still be up
at 0:21.

Stop with `adb emu kill` and Ctrl-C in the three terminals; the fixture removes
its temporary data (the log under `openmausbot-verification-evidence` stays).

## Sideloading

`./gradlew :app:assemblePreview` writes
`android/app/build/outputs/apk/preview/app-preview.apk` — **MausBot Preview**,
application id `com.openmausbot.companion.preview`, debug-signed. It installs
beside the real app with its own pairing and data:

```sh
adb install -r android/app/build/outputs/apk/preview/app-preview.apk
```

`app-debug.apk` (from `:app:assembleDebug`) shares the real app's id and
cannot replace a Play-installed copy. Both are universal (four ABIs, about
88 MB).

## Local verification — 2026-09-26

- `:core` 615 tests and `:app` 1027 tests, 0 failures, 0 skipped;
  `app-debug.apk` 88,836,849 bytes and `app-preview.apk` 87,517,132 bytes.
- An arm64 API 37 (Android 17) emulator: pairing at `10.0.2.2:8820` failed
  with "Couldn't reach this computer…" after Don't allow, and succeeded through
  the sidecar once local-network access was granted with `pm grant`; Checks A
  and B as they read then, including Home ending the call and Try again.
- An arm64 API 35 (Android 15) emulator: paired through the sidecar with the
  Nearby devices prompt declined; Checks A and B as they read then, plus the
  denied microphone, the banner's own Hang up, and a call left alone ending
  after 5:00 with the idle notice.
- Both runs: the app holds `MODE_IN_COMMUNICATION` with the speaker as its
  communication device during a call and returns to `MODE_NORMAL` with the
  device cleared after it (`adb shell dumpsys audio`); no crash in the crash
  buffer; `GET /api/live/call` went from the call to `{"call":null}` within a
  second of every Hang up; the fixture's log held only `[live] call
  started`/`call ended` lines (`end=hung-up`, or `end=idle` for the call left
  alone), all `errors=none`.
- After the fix that wraps long notices: `:core` 615 and `:app` 1032 tests, 0
  failures; `app-debug.apk` 88,841,586 bytes and `app-preview.apk` 88,889,559
  bytes. On the API 37 emulator, against a sidecar on 28810/28811 paired by
  typing `10.0.2.2:28810` (local-network access granted with `pm grant` before
  the app first opened; no system prompt appeared; the in-app list of
  computers on the network also showed the real one, so nothing was picked
  from it): the denied microphone and Check B's busy notice read whole on two
  lines with Try again and Dismiss under them, "Call ended" after Home kept
  both beside it on one line, and the live bar looked as before. Both calls
  logged `end=hung-up errors=none`; the crash buffer stayed empty.
- After the media-connect timeout: `:core` 615 and `:app` 1036 tests, 0
  failures, 0 skipped; `app-debug.apk` 88,841,701 bytes and `app-preview.apk`
  88,889,702 bytes. Not yet run on an emulator: the runs above predate the
  timeout (so a call there lasted until the idle hang-up), and the 20-second
  drop Check A now describes is pinned by `LiveCallManagerTest` alone.
