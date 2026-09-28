# Android thread navigation

Use the test suites below, which create synthetic fleets and disposable
loopback servers. Never pair a verification build to the user's live desktop
or send test messages to their bots.

## Build and regression checks

From `android/`, with JDK 17 and the Android SDK configured:

```sh
./gradlew :core:test :app:testDebugUnitTest :app:assemblePreview
```

Core tests cover saved folder order, title/folder search, legacy computers,
orphaned folders, closed/routine filtering, unread counts, per-thread runtime,
history loading after an SSE tail, and exact notification/search targeting.

`BotThreadTreeTest` and `AndroidThreadNavigationTest` drive real Compose
controls in Robolectric. Their data and HTTP responses are synthetic. They
check expanding folders, opening the exact thread without changing the
desktop selection, switching drafts from the header, status updates, and
failed create/rename/delete actions. Deletion requires confirmation; errors
keep the form and its entered text available for retry.

The roster reopening regression selects a sibling thread through the real
header picker, returns home, and taps the bot row again. It must reopen the
chosen thread without a server task-switch request. `ChatPreferencesTest`
checks that a fresh store restores the choice, isolates it by computer and bot,
falls back after deletion, and leaves rooms on their shared selection.

The reconnect regression keeps a nonactive thread open while a second,
non-resumable `Hello` hydrates the desktop-active thread. Its history must be
fetched again and rendered without navigation or changing the desktop's active
thread. This uses real Compose, Session, and HTTP history reads against a
loopback server; the SSE frames are scripted, not a real-device network test.

```sh
./gradlew :app:testDebugUnitTest --tests '*AndroidThreadNavigationTest*'
```

`ChatDraftHolderTest` covers separate text/attachment state, late upload
completion after switching away and back, and clearing an owner's drafts
when leaving the chat. Dictated text and attachments remain memory-only.

From the repository root, exercise the existing server contract:

```sh
pnpm exec vitest run server/paired-thread-targets-api.test.ts server/independent-threads-api.test.ts server/bot-projects-api.test.ts server/thread-capacity-api.test.ts
```

These launch isolated fake-provider fixtures. No server routes or pairing
protocol changes are needed for the Android UI.

## Compact home list

The home list has two densities, chosen per device in **Settings → Threads
list → List density**. Compact is the default: one line per bot and group, a
crown after a Chief of Staff, a hand while a bot waits on you and a spinner in
place of the time while it works. Only a bot with two or more threads shows
**› N**, which lists them under the bot's name and ends with **New thread**;
a long press on any bot offers **New thread** and **Manage threads**.
Comfortable is the earlier layout and keeps its own logic. The compact rules
mirror the iPhone companion's compact list and are tested in `:core`:

```sh
./gradlew :core:test --tests '*RosterDensityTest' \
  :app:testDebugUnitTest --tests '*RosterScreenTest' --tests '*ChatPreferencesTest'
```

`RosterScreenTest` mounts the real roster and Settings over a real Session,
`RosterFixture` (a synthetic fleet with every state the list draws, the
counterpart of the iPhone companion's roster preview fleet) and a loopback
server, with native graphics so text is measured for real. It checks:

- compact is the default, one line per bot, with the crown and no Threads row
  for a single-thread bot, and the Chief of Staff row set apart from Needs
  attention;
- the hand and the spinner on bot and group rows;
- a single-thread bot's long press and TalkBack action create a thread, with
  a spinner on the row until it opens;
- **› 3** lists Pepper's threads in line with its name, without the routine
  run, with a pin on the pinned one and a "Threads" heading over the unfiled
  one, and ends with **New thread**; closing the folder or tapping **› 3** again
  closes what it should; a list whose count goes away stays closed when the
  threads come back;
- search, including a single-thread bot's match; groups and the **+** that
  makes one; "No bots yet" never drawn over group rows;
- the role gives way before the name; at twice the text size names wrap
  between whole words with automatic hyphenation off, including a two-word
  name on a narrow phone;
- the setting switches back to comfortable and is saved; comfortable keeps its
  Threads tree;
- in both densities at twice the text size, the first title starts under the
  header and the last row scrolls fully clear of the floating bottom bar.

Two things these checks cannot settle: this host has no hyphenation patterns,
so only a device shows that no hyphen is added to a wrapped name, and TalkBack
speech needs a real screen reader.

## Installable preview

The output is `android/app/build/outputs/apk/preview/app-preview.apk`. This is
a debug-signed **OpenMausBot Preview** with its own application ID, so it does
not overwrite the released app or inherit its saved connections. Pair from
inside Preview using the scanner or manual form. The preview intentionally
does not register system share or pairing-link entrypoints.

This preview is built from main, not the separate Android 1.2.0 release
branch. That branch's call-mode screens are not on main; this is a thread
feature preview, not a replacement production upgrade.

For manual testing, launch the disposable fixture from
[threads.md](threads.md), enable Phone only on that fixture, and pair only a
test emulator/device to it. Check:

1. Home → Pepper's **› 3** (compact) or its Threads row (comfortable) → Email →
   open each named conversation.
2. Search a folder or thread name, then clear it; disclosure state survives.
3. Type in one thread, switch through its header, type in another and return.
   Text and attachments must not move between conversations.
4. Start independent fake-provider turns; each row and Updates entry shows
   its own Working/Queued/Unread state. Stop only the selected conversation.
5. Create, rename and confirm deletion. Disconnect the fixture and retry an
   action: show an error instead of silently closing the sheet.
6. Switch a group thread; groups retain their shared desktop selection.

Folder creation/reordering remains desktop-only. These checks do not establish
real-device HTTPS/Tailscale pairing, reconnects, dictation or uploads. Do not
claim those flows tested from the build or Robolectric suite alone.

## Recorded local pass — 2026-09-13

- 526 core tests and 890 app tests passed, including ten Compose thread cases.
- 19 isolated server thread/folder/capacity tests passed.
- Preview APK assembled successfully; its v2 signature and separate preview
  application ID were verified with the Android SDK tools.
- No physical-device installation, real pairing or live-provider test was run.

## Last opened thread regression — 2026-09-20 UTC (2026-09-21 IST)

The new real Compose regression failed before the fix: returning from the
chosen second thread to the roster and tapping the bot reopened the first
thread. After persisting the phone-local choice, the same regression passed
without any task-switch POST or change to the server-selected thread.

- 549 core tests and 919 app tests passed, including fresh-store restoration,
  connection/bot isolation, deleted-thread fallback, and room selection.
- Preview APK assembled and its v2 signature verified.
- Fixtures remained synthetic and confined to disposable loopback HTTP;
  no real pairing, device installation, or live-provider test was performed.

## Compact home list — 2026-09-27

- The 24 `RosterDensityTest` cases did not compile before the rules existed.
  On the unfixed layout at twice the text size, the clearance check failed:
  the last row ended at 818 dp, under the bottom bar's top at 804 dp. It passes
  with the measured inset. Ten of the twelve `RosterScreenTest` checks failed
  on the roster before the compact list existed.
- 621 core tests and 971 app tests passed (`cleanTest :core:test
  :app:testDebugUnitTest`), with no failures or skips. `:app:assembleDebug` and
  `:app:assemblePreview` succeeded; the preview APK's v2 signature and its
  `com.openmausbot.companion.preview` application ID were verified.
- Fixtures were synthetic and confined to a loopback server. No emulator,
  device installation, pairing or live-provider test was performed.

## Compact home list review fixes — 2026-09-27

- The reworked `RosterDensityTest` did not compile before the compact-only
  rules existed. On the unfixed screen, 8 of the 20 `RosterScreenTest` checks
  failed: hyphenation, the unfiled label and the pin, the list that reopened by
  itself, progress while a thread is made, the Chief of Staff spacing, and
  "No bots yet" over group rows. The other 12 pin behaviour that already held.
- 627 core tests and 979 app tests passed (`cleanTest :core:test
  :app:testDebugUnitTest`), with no failures or skips. `:app:assembleDebug` and
  `:app:assemblePreview` succeeded; the preview APK's v2 signature and its
  application ID were verified.
- Fixtures were synthetic and confined to a loopback server. No emulator,
  device installation, pairing or live-provider test was performed.
