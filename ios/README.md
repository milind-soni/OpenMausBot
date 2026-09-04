# OpenMausBot companion (iOS)

Your bots keep running on the laptop. This is the phone you watch them from,
answer their approvals on, and send them the next thing.

The laptop stays the only machine that persists agent processes, credentials,
transcripts and computers. The phone owns no copy — it is a second client of
the same harness the desktop app talks to, through the restricted sidecar
described in [`docs/ios-companion.md`](../docs/ios-companion.md).

## Status

Built and verified against a real harness on both a simulator and an iPhone:
QR handoff, Bonjour discovery, manual LAN and Tailscale pairing, the roster, paged chat,
streaming replies, shared sidebar sections, the computer view, and — the one that matters — an approval
raised by a bot on the Mac, answered on the phone, with the bot carrying on.

Pending API-key cards can also be completed on a freshly QR-paired phone.
The native secure field supports iOS Password AutoFill (Apple Passwords is the
free built-in option; enabled third-party providers work too), then CryptoKit
encrypts the value for the paired computer before it enters the network. The
phone clears the native field immediately; it may retain only the exact
ciphertext in memory for an idempotent retry, and never persists it. The
sidecar, hosted relay, transcript and SQLite database retain no plaintext copy.
Submission requires Secure phone access (HTTPS) or Tailscale; local Wi-Fi chat
still works, but the app does not send a reusable device token with a credential
request over cleartext LAN HTTP.

The app also installs an iOS Share extension. From any app's Share sheet, a
person can choose **OpenMausBot**, review the paired computer and destination,
add a note, and send selected text, a link, images, or documents directly to a
bot or room. The extension remembers the last destination per computer, but it
never sends silently: the destination is always visible before confirmation.

The event stream deliberately reads raw bytes rather than
`URLSession.AsyncBytes.lines`. Three easy-to-miss failure modes are covered by
real `URLSession` tests:

1. `timeoutInterval = .greatestFiniteMagnitude` — reads as "never time out",
   actually produces a request that opens and delivers nothing, because
   URLSession turns a timeout into a deadline by adding it to the current time.
2. Keeping only the derived line iterator while letting `URLSession.AsyncBytes`
   go out of scope. AsyncBytes cancels its data task when released, so the
   connection died the moment the first frame was returned.
3. Reading with `bytes.lines`, which folds consecutive newlines into one
   separator and therefore never reports the blank line that terminates an SSE
   event. Zero frames, no error, a healthy-looking connection at both ends.

`EventStreamTests` catches that class by driving a real `URLSession`.
[`TESTING.md`](TESTING.md) is the end-to-end runbook.

## Layout

```
ios/
  Package.swift                  CompanionCore + its tests
  project.yml                    XcodeGen spec for the app target
  Sources/CompanionCore/         no UI, no Apple frameworks beyond Foundation
    Models.swift                 the harness's wire types
    Frames.swift                 SSE frames, unknown kinds absorbed
    SSE.swift                    line parser + URLSession event stream
    Client.swift                 every call the phone is allowed to make
    Store.swift                  the fold: frames → state
    SectionSelection.swift       pure swipe/dwell selection state + grid hit testing
    Dictation.swift              composer text + transcript join
  Tests/CompanionCoreTests/
    Fixtures/                    captured from a real server — do not hand-edit
    DecodingTests.swift          the contract with the harness
    SSETests.swift               the parser, which is where this goes wrong
    StoreTests.swift             the fold
    DictationTests.swift         partials replace, they do not stack
  AppShared/                     connection metadata + Keychain access shared by trusted targets
  App/                           SwiftUI, and everything that needs a device
    CompanionApp.swift           entry; owns when the stream lives and dies
    Session.swift                connection, lifecycle, actions
    Discovery.swift              NWBrowser for _openmausbot._tcp
    Keychain.swift               the device token
    MausAvatar.swift             the mascot face, in the desktop's palette
    PairingView.swift            QR handoff, discovery, address and code fallback
    PairingScanner.swift         native QR camera, permission and recovery UI
    Glass.swift                  the one material the chrome is made of (Liquid Glass on 26+)
    SpeechBubble.swift           the bubble shape; the tail is the reference vector, scaled
    ChatListView.swift           roster: channels and shared desktop/mobile sections
    Updates.swift                what the Updates pill shows — only bots doing something
    UpdatesSheet.swift           the pill opened: needs you / working / to review
    NewGroupSheet.swift          make a channel from the phone
    NewSectionSheet.swift        tap or swipe bots together into a section
    ChatView.swift               transcript, tailed bubbles, approval cards, composer
    SpeechDictation.swift        on-device speech recognition, press-to-stop
    ComputerView.swift           opt-in live view of a bot's computer
    MarkdownText.swift           the supported Markdown presentation layer
    SettingsView.swift           status, computer switcher, and pairing removal
  ShareExtension/                native Share-sheet picker, item loading, upload, and send
```

## Building

The core needs nothing but a Swift toolchain:

```sh
cd ios
swift test
```

The app needs Xcode. The `.xcodeproj` is generated rather than committed:

```sh
brew install xcodegen
cd ios && xcodegen generate && open OpenMausCompanion.xcodeproj
```

**Re-run `xcodegen generate` after pulling any change that adds a file to
`App/`.** The spec says `sources: App`, but XcodeGen resolves that to explicit
file references when it generates, so a new file is simply absent from the
target until you regenerate — and the build fails with `Cannot find 'X' in
scope`, which reads like a code error and is not one.

If you'd rather not install XcodeGen, make an iOS App target by hand, add the
`App/` folder and the local `CompanionCore` package, and copy the Info.plist
keys out of `project.yml` — `NSLocalNetworkUsageDescription` and
`NSBonjourServices` especially. Without them `NWBrowser` returns no results at
all, *silently*, which looks exactly like "no computers on this network".

## Regenerating the fixtures

Whenever the companion API changes:

```sh
node scripts/capture-companion-fixtures.mjs   # from the repo root
```

It boots a real harness against a throwaway home directory, drives the real
pairing handshake through the sidecar, and writes down what came back. The
harness may use SQLite internally; the fixture records the public HTTP/SSE
contract, which is the only storage surface the phone should know.
Commit the diff — a change there is a change to the contract, and reviewing it
is the point.

## What the phone may and may not do

Enforced by the default-deny policy in `companion/src/routes.ts`, and mirrored
here by simply not having the methods:

| Allowed | Refused |
|---|---|
| Read bots, rooms and transcripts | Write API keys (`PUT /api/config`) |
| Send messages, make a bot or a room | Manage pairing or revoke devices |
| Share selected text, links, images and documents | Browse arbitrary files on the phone or Mac |
| **Answer approvals and questions** | Drive the Local VM or this computer |
| Interrupt a bot, mark chats read | Reach `/api/internal/*` |
| File visible bots into one sidebar section | Use general bot or room `PATCH` routes |
| Fetch screen images on demand | Load the packaged desktop UI |
| Open an explicitly enabled cloud desktop | Provision, sleep or run shell commands on cloud computers |

Marking a chat read and remembering an approval use purpose-built server
verbs. Section creation likewise uses one strict atomic batch route. The
sidecar does not expose the general bot or room `PATCH` routes,
because those can also change execution policy, computers, connected apps, and
working directories.

Companion settings stay on the computer on purpose: losing the phone must not
mean losing the ability to lock it out.

Interactive cloud desktop access is additionally enabled per paired device and
starts off. The phone asks the Mac to mint a fresh provider URL after an
explicit warning, validates that it is HTTPS, opens it in an in-app Safari
sheet, and never persists it. The Local VM's loopback-only noVNC listener and
the host computer remain unreachable through the companion.

## Design notes

- **Zero third-party dependencies.** The raw-byte SSE reader, Keychain,
  `NWBrowser`, and notifications are all first-party.
- **QR scan confirms before connecting.** The QR carries a short-lived,
  high-entropy credential rather than relying on the visible six-digit code.
  The app validates the target, asks the user to confirm it, exchanges the
  credential once, and persists only the resulting device token in Keychain.
- **Thin client.** The harness already folds provider events into settled
  messages. The phone folds `message`, `message.patch`, and `bot` frames, plus
  the small `runtime` delta subset needed to show a reply while it is typed.
- **`screens=off`.** The harness would otherwise push a base64 desktop capture
  every few seconds to a device on cellular.
- **Reconnect by cursor.** The stream is resumable: hold the `<streamId>:<seq>`
  cursor, and on reconnect the server replays what was missed or says
  `resumed: false`, which is the signal to hydrate. Lifecycle — not the parser —
  is the hard part of a phone client, which is why the stream is torn down
  deliberately on backgrounding rather than left for iOS to kill.
- **No optimistic state.** Actions call the harness and let the event stream
  deliver the result. A phone that draws its own version of what just happened
  is a phone that disagrees with the laptop.
- **Messaging-app shape, not settings-list shape.** Mascot faces at roster size,
  the bot's role as a chip beside its name, timestamps that say "Yesterday"
  rather than a date, and a gap-based separator in the transcript instead of a
  stamp on every message. The palette in `MausAvatar.swift` is copied verbatim
  from `src/lib/mascot.ts`: a bot the user knows as "the orange one" should be
  the same orange on both screens.
- **Return sends, Shift+Return breaks the line**, via `.onKeyPress`. Returning
  `.ignored` for the shifted case hands the keypress back to the text field,
  which is the only thing that can insert the newline once Return is claimed.
  Software keyboards have no Shift+Return, so there `.onSubmit` sends.
- **Composer dictation is the mic.** Tap to talk, tap to stop, then edit or
  send. Recognition stays on-device when the phone supports it, and the mic
  remains visible so another spoken sentence can be appended. Search covers
  the SQLite transcript store and opens the exact task,
  branch, and message; the roster's "+" creates the same basic bot the desktop
  endpoint creates, then opens it.
- **Share-sheet files cross one narrow boundary.** Images are limited to 10 MiB
  each, supported documents to 25 MiB each, and the computer accepts at most
  512 MiB of attachments in total before asking the user to clear space. The
  extension copies temporary
  provider files into its App Group before asynchronous work, uploads raw bytes
  through the same paired connection, and sends only the Mac-local generated
  path to the selected destination. Each share keeps a stable random upload ID,
  so retrying a dropped route reuses the same file instead of making duplicates.
  The Mac stores the file with a generated name and owner-only permissions; the
  iPhone's temporary sandbox URL is never sent.
  Keep the Share sheet open until it says **Sent**. This version does not hand a
  partially uploaded file to a background transfer service if iOS closes the
  extension; abandoned temporary copies are purged on the next share or app
  foreground.

## Limits in this version

The live connection is foreground-only. Notification frames produce native
banners, sounds, time-sensitive approval alerts, and an app badge while connected;
the resume cursor replays alerts missed during a short background pause. There is
no APNs delivery after the app is terminated, no call mode or spoken replies,
and no cloud-resident bot service. Optional hosted HTTPS is an encrypted route
back to the user's computer, not a second transcript store. Composer dictation is available.
Task management, SQLite transcript search,
transcript sharing, reactions, and edit/version controls use narrow companion
routes and the computer remains the source of truth. Tailscale is supported
through manual MagicDNS entry; it is not a dependency and OpenMausBot does not
operate a cloud copy of local data.
