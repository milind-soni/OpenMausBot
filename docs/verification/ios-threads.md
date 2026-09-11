# iOS thread navigation

Use disposable simulators and synthetic data. Do not pair these checks with
the user's running desktop or mutate their conversations.

## Core and existing server contract

From `ios/`, run `swift test`. Thread navigation cases cover folder order,
search, legacy computers, orphaned folders, routine filtering, unread counts,
runtime projection and loading full history after a background SSE tail.

From the repository root:

```sh
pnpm exec vitest run server/paired-thread-targets-api.test.ts server/independent-threads-api.test.ts server/bot-projects-api.test.ts server/thread-capacity-api.test.ts
```

These server tests launch isolated fake-provider fixtures. They cover thread
ownership, simultaneous turns, thread-scoped stop/settings, paired requests,
folders and capacity. They do not drive the native iOS UI.

## Native UI

Generate the Xcode project with `cd ios && xcodegen generate`. Create a fresh
iPhone or iPad simulator, then run the `OpenMausCompanion` scheme's UI tests
against that explicit simulator ID. For example, from `ios/`:

```sh
xcodebuild -project OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -configuration Debug -destination 'platform=iOS Simulator,id=SIMULATOR_ID' \
  -derivedDataPath /tmp/omb-ios-threads-build CODE_SIGNING_ALLOWED=NO test
```

`ThreadNavigationUITests` launches with `-store-preview -threads-preview`.
`App/ThreadPreview.json` is a synthetic, offline UI fixture: Pepper has two
threads in Email, one unfiled thread, and one hidden routine run. No companion
client, tokens or provider process are started. This fixture is separate from
the captured server contract fixtures under `Tests/CompanionCoreTests/Fixtures`.

Check on iPhone and iPad:

1. Expand Pepper's Threads row and Email folder. Each visible thread opens
   directly; the routine run is absent. Check working, queued and unread labels.
2. Search by folder and thread name, then clear the search.
3. Enter an unsent draft in Gmail, switch to iCloud through the header, and
   return. iCloud must not inherit Gmail's draft; Gmail must retain it.
4. Open Updates. Active sibling threads must have distinct entries and titles.
5. In the thread picker, attempt creation while offline. The sheet must stay
   open and show an error. Failed renames must retain the entered title.

Keep the `.xcresult` bundle and screenshots as evidence. Shut down and remove
only the disposable simulators you created.

The offline UI checks do **not** prove real-device pairing, HTTPS/Tailscale,
live network reconnects, dictation or attachment uploads. Validate those with
the [iOS end-to-end runbook](../../ios/TESTING.md) against an isolated companion
before claiming them tested. No new server routes or pairing changes are
introduced by the thread UI.

## Recorded local pass — 2026-09-11

- Xcode 26.6 Debug simulator build succeeded.
- 383 CompanionCore tests and 17 isolated server integration tests passed.
- All five native UI cases passed on iPhone 17 Pro and iPad Pro 13-inch (M5),
  using disposable iOS 26.5 simulators. Search also preserves the previously
  expanded bot when it is cancelled.
- Retained results: `/tmp/omb-ios-threads-iphone-acceptance.xcresult` and
  `/tmp/omb-ios-threads-ipad-clean.xcresult`, including screenshots.
- No physical-device, live pairing or provider verification was performed.
