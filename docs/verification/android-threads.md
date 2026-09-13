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

`ChatDraftHolderTest` covers separate text/attachment state, late upload
completion after switching away and back, and clearing an owner's drafts
when leaving the chat. Dictated text and attachments remain memory-only.

From the repository root, exercise the existing server contract:

```sh
pnpm exec vitest run server/paired-thread-targets-api.test.ts server/independent-threads-api.test.ts server/bot-projects-api.test.ts server/thread-capacity-api.test.ts
```

These launch isolated fake-provider fixtures. No server routes or pairing
protocol changes are needed for the Android UI.

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

1. Home → expand Pepper → Email → open each named conversation.
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
