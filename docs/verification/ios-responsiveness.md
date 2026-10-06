# iOS responsiveness under busy-fleet traffic

Use synthetic data and disposable simulators, never the user's paired app or
conversations. These checks concern ordinary chats, not Live audio.

## Core regressions

From `ios/`, run `swift test`. In particular:

- `EventBatchTests` delivers 500 token frames across 20 threads in five
  deliveries, with every token and sequence retained. One delivery publishes
  state once, including its replay cursor and concurrent local edits. Controls
  flush immediately; a lone token flushes on its fixed deadline; transport
  errors flush the tail; cancellation stops the source without committing it.
- `WidgetSnapshotTests` checks compact snapshots, changed titles/options,
  unchanged-payload renewal, unchanged ten-minute answer expiry, off-main FIFO
  writes, unpair/re-pair ordering, and retry after a failed write.
- `StoreTests`, `MarkdownTests`, `ReasoningWindowTests` and
  `LiveActivityUpdatesTests` cover edit-version parity, bounded parse reuse,
  Unicode/CRLF reasoning, and one highest-priority activity per bot without
  dropping any thread from Updates.
- The compact-surface publisher regression delivers during continuous traffic,
  preserves the initial window, delivers final unpairing, and stops on cancellation.
  Widget and Dynamic Island subscribers use fixed 400 ms windows, not a debounce
  that can starve indefinitely. A window temporarily retains its incoming state
  values; it is not a hard limit on the number of values in that window.

The 100-frame limit bounds each staging batch, not the stream's entire
downstream backlog. No event is dropped to enforce a buffering limit.

## Native acceptance

Generate the project with `cd ios && xcodegen generate`. Create a disposable
iPhone simulator and use its explicit ID:

```sh
xcodebuild -project OpenMausCompanion.xcodeproj -scheme OpenMausCompanion \
  -configuration Debug -destination 'platform=iOS Simulator,id=SIMULATOR_ID' \
  -derivedDataPath /tmp/omb-ios-responsiveness-build \
  -resultBundlePath /tmp/omb-ios-responsiveness-iphone.xcresult \
  -parallel-testing-enabled NO \
  -only-testing:OpenMausCompanionUITests/ResponsivenessUITests \
  -only-testing:OpenMausCompanionUITests/ThreadNavigationUITests \
  -only-testing:OpenMausCompanionUITests/TranscriptPresentationUITests \
  -only-testing:OpenMausCompanionUITests/RosterDensityUITests \
  -only-testing:OpenMausCompanionUITests/SwipeBackUITests \
  CODE_SIGNING_ALLOWED=NO test
```

Repeat on a disposable iPad. Keep the result bundles and screenshots, then
shut down and delete only the simulator IDs created for these checks.

`ResponsivenessUITests` adds the Debug-only `-busy-fleet-preview` flag to the
existing offline thread fixture. Twenty other bots have fifty completed
messages each and target 400 token frames per second for a nominal 90 seconds.
Scheduling under host load can extend this; the test checks actual cursor
progress rather than assuming the producer kept its target rate. Frames
go through the same batching and atomic Session fold as the real stream;
there is no API client, token, provider, microphone or message send.

The native suite has three cases, each with cursor advancement proving the
flood stayed active during the actions:

- It types into a short Gmail chat while the other threads stream, switches
  to iCloud, types a separate draft and returns. It checks draft isolation
  and the correct transcript.
- It opens a busy fixture bot's chat, the thread that is streaming, at Full
  activity (the reply grows as a bubble), and types into it.
- It scrolls back in that chat while the reply streams and checks the reader
  stays where they scrolled, then that Jump to latest returns to the end and
  the stream is followed again.

Typing and thread switching must finish within 12 s and 30 s. Measured runs
on a heavily loaded Mac took 1.4–3.9 s and 10–18 s, so the ceilings catch a
main thread that cannot keep up, not ordinary simulator variance. Both typing
cases also read the fixture badge's Debug-only `transcript-row-redraws`
counter, which counts message-row bodies: typing and two seconds of flood
afterwards must redraw fewer than 50, and should redraw none. Counting
starts once the counter has stopped climbing: under XCUITest, SwiftUI
sometimes keeps redrawing a just-opened chat's rows for a few seconds without
asking their `==`, which a direct launch never showed. Each busy
fixture thread stores fifty messages without parent links, so its chat shows
only the newest under the live reply; Gmail's six rows are the larger page.
Per-action times, redraw counts and screenshots are attached. Existing
suites protect tables, initial scroll landing, narration folds, reasoning,
roster density, search, navigation and swipe-back.

This proves the synthetic workload and native workflows, not the reported
physical iPhone freeze, real-network throughput, memory-pressure behavior or
hours-long stability. App Store users need a new iOS build containing these
changes; a desktop release does not update the installed iPhone app.

## Local evidence — 2026-10-06

Transcript rows (#1 of the Oct 5 iOS performance audit), measured on a
disposable iPhone 17 Pro / iOS 26.5 simulator with the Debug build. The Mac
had a load average above 100 from other builds throughout.

- Launched directly with `-busy-fleet-preview -open-first` (the Gmail chat,
  six rows), no XCUITest attached, counting body evaluations: on `main` the
  rows drew 1,314 times, their bubbles 1,314 and their Markdown 876 over the
  first 220 publishes, every row on every publish. With rows on plain values
  they drew 6–72 times in total across eight launches: the first draw plus
  a few redraws, which, in the six launches sampled over time, all came in
  the first second after the chat opened.
- `ResponsivenessUITests` on `main` (same counter patched in): 79–98 redraws
  of the streaming fixture chat's one row while typing and for 2 s after. On
  this branch: 0 in every run of both typing cases.
- Reading back while the reply streams: on `main` the reader is pulled back
  to the live reply; here the Jump to latest pill stays for 2 s of streaming,
  and tapping it resumes following.
- Mutation check: making the rows' action value compare unequal, as a fresh
  closure in a compared field would, failed both typing cases (390 and 66
  redraws). Removing `.equatable()` alone did not: SwiftUI also uses the
  rows' `Equatable` conformance without it, and their values are now
  identical from render to render.
- On the final tree (rebased onto #2330, #2331, #2333, #2334 and #2336),
  `ResponsivenessUITests`, `ThreadNavigationUITests`, `StopButtonUITests`,
  `MentionPickerUITests`, `ApprovalCardUITests`,
  `ImageAttachmentLayoutUITests`, `VoiceNoteUITests` and
  `GeneratedImageUITests` passed, and `TranscriptPresentationUITests`
  passed except `testHiddenFoldsNarrationAndWebhookPayloadCanBeExpanded`.
  That case fails the same way on unmodified `main` (the first of three
  iterations, at the Event payload tap; the next two pass), so it is not
  this change. The disposable simulators were deleted.
