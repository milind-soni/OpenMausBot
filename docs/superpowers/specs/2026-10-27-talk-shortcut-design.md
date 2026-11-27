# Talk shortcut: hold a key, talk to MausBot from any app

Date: 2026-10-27 · Branch: `feat/talk-shortcut` · Idea source: Atticus's hold-to-talk box (SaarthurR/atticus-mac, MIT). We take the idea, not the code.

## Why

Asking MausBot something means switching to the app, finding the chat and
typing. Holding a key from wherever you are, saying it and letting go is the
fastest way in. MausBot is the orchestrator, so it is the right place for a
quick ask to land.

## Goals

- macOS: hold ⌃⌥Space from any app, speak, release ⌃⌥ to send.
- A small floating box near the bottom of the screen shows the live words, then
  MausBot's reply. It never takes focus and never brings the MausBot window
  forward.
- Clicking the box opens that chat in MausBot.
- On/off in Settings → General.

## Non-goals (v1)

- Windows and Linux (no speech recogniser there today; the setting is hidden).
- Typing into the box (it cannot take focus by design).
- Choosing another bot or a free-form key (three presets only).
- Reading the reply aloud.
- Asking from the phone apps.

## Anti-goals

- Stealing focus or Esc from the app the person is in.
- Breaking a call or composer dictation that is using the microphone.
- A box that lingers or piles up.

## Design

### Key: press via `globalShortcut`, release via the speech helper

Electron's `globalShortcut` registers `Control+Alt+Space` (Carbon hotkey, no
permission needed) but cannot see a key go up. The existing speech helper
already finishes recognition when its finish file appears. Add
`--finish-on-release control,option`: the helper's finish timer also finishes
when `CGEventSource.flagsState(.combinedSessionState)` no longer holds both
modifiers. So: hold ⌃⌥, tap or hold Space, speak, let go of ⌃⌥. A release
before the helper is ready still finishes (the timer keeps polling).

Repeat presses while a session is active are ignored. A press while a reply is
showing dismisses the box and starts a new ask. If another app owns the
shortcut, registration fails and Settings shows "⌃⌥Space is used by another
app".

### Speech (`electron/speech.mjs`)

`startSpeech` takes a sink (`{transcript(line), end(info), replaced()}`) as well
as a window; window callers are unchanged. New `speechBusy()`. The speech
helper is not the only thing that holds the mic: Live calls use
`getUserMedia`, and voice calls stop the helper while the bot speaks. So the
renderer also tells main when any call starts and ends (`call:active` IPC), and
the talk shortcut refuses during a call or while composer dictation is on: the
box says "Voice is in use in MausBot" and nothing starts. If the renderer starts
speech while the talk box is listening, the talk sink's `replaced()` closes the
box.

### The box (`electron/talk-panel.mjs`)

Created lazily per ask and destroyed after it fades: `type:"panel"`,
frameless, transparent, `focusable:false`, `skipTaskbar`, always on top at
`screen-saver` level, visible on all Spaces and over full-screen apps,
`showInactive()`, bottom-centre of the display under the cursor. It loads a
`data:` URL page (inline CSS, strict CSP) with a tiny preload exposing only
`open()` and `dismiss()`. Main pushes state:

`listening (live words) → sending → thinking → reply (first ~400 chars, plain
text) → done` or `needs-you` (an approval or question card) or `error`.

The box takes the light or dark of the app's skin as last painted (Settings →
Appearance → Theme), macOS's appearance only until a page has painted one. It
stays on the display it opened on. The box hides 12 s after the reply unless the
pointer is over it. Clicking it
opens `openmausbot://thread/<threadId>?bot=<botId>` and shows the main window.
Places that treat every window as the main one (`activate`, single-instance,
`activateExistingWindow`, window-all-closed, the capabilities broadcast) skip
the panel.

### Sending (Electron main)

Asks always go to the MausBot on this Mac's own server, even when the window is
showing a Team Cloud (my call for v1). Once this Mac's bots moved to My Cloud
(home is My Cloud, or this Mac's copy is frozen) the shortcut is unavailable and
its key free, until home is this Mac again; a frozen server's 409 `moved` says
"MausBot lives on My Cloud now — talk to it there".

`GET /api/bots?messages=0` → MausBot (`defaultBot` without `person`, else the
Chief of Staff). `POST /api/bots/:id/messages {text, sendId}` with the desktop
owner header (`localServerRequest`). Follow the reply on `GET
/api/events?screens=off` for that thread: assistant deltas update the box, the
final bot message wins, `turn.completed` ends it, a request card switches to
"needs you". No reply in 120 s shows "Still working · Open chat". An empty
transcript closes the box silently. If the local server is not running, the box
says "Open MausBot to talk"; while it is still starting, "MausBot is still
starting. Try again in a moment."; with no MausBot, "Set up MausBot first, then
try again." Speech problems use the composer's words: only a refused permission
asks for access, a microphone or recognizer failure says "Talking couldn't
start. Try again."

### Settings

`desktop-prefs.json` gets `talkShortcut: boolean` (default `true` on macOS),
`talkKey: "ctrl-opt-space" | "ctrl-shift-space" | "opt-shift-space"` and the
Quick asks chat id. Settings → General gets a switch: "Talk to MausBot from any
app · hold ⌃⌥Space, speak, let go" with the key picker under it. Hidden where
Apple speech is unavailable, on a remote client and while home is My Cloud. Not
in `REMOTE_SAFE`.

## Testing

- `electron/*.node-test.mjs`: shortcut registers and unregisters with the pref;
  a busy speech session refuses; the sink path receives transcript and end; the
  replaced callback fires; the panel state machine (listening → reply → hide,
  needs-you, empty transcript, server down, timeout) against a fake server and
  fake SSE.
- Swift: release detection by injecting the flags reader (a flag that pretends
  the keys were released).
- By hand on a Mac (OMB2 side-by-side build): hold, speak, release from Safari;
  the box never takes focus; a call in progress blocks it; the reply lands in
  MausBot's chat.

## Decisions

- Omkar, 2026-10-27: asks land in one dedicated MausBot chat, "Quick asks",
  created on first use and reused (follow-ups keep context; asks never mix into
  work running in another chat). If it was deleted, a new one is made. Its id is
  kept in desktop prefs per server.
- Omkar, 2026-10-27: default key ⌃⌥Space. macOS uses ⌃⌥Space for "Select next
  source in Input menu", which clashes for people with two keyboard layouts, so
  Settings offers ⌃⌥Space, ⌃⇧Space and ⌥⇧Space (⌥⌘Space is the Finder search window). Release detection follows the
  chosen key's modifiers. This replaces the "no remapping" non-goal.
- My calls: always the local server in v1; calls and composer dictation block
  the shortcut.

## Left to the builder

Box visuals (follow the app's tokens and mascot), exact copy, panel size, how
dev mode reaches the dev server.
