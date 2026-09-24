# Android transcript presentation

With JDK 17 and the Android SDK configured, run from `android/`:

```sh
./gradlew :core:test :app:testDebugUnitTest :app:assemblePreview
```

For just the transcript regressions:

```sh
./gradlew :core:test --tests '*TranscriptPresentationTest*' \
  :app:testDebugUnitTest --tests '*TranscriptPresentationTest*' --tests '*LiveTailTest*'
```

The core suite verifies completed-turn folds at every activity level, wire
serialization, terminal patches, legacy/unfinished replies, interleaved turns,
elapsed time, and webhook parsing without changing the stored model prompt.

The app suite mounts the actual ChatScreen and Session in Robolectric using a
synthetic fleet and an isolated loopback server. It checks:

- Completed narration starts collapsed and can be expanded and collapsed.
- The final answer and webhook task remain visible while transport metadata
  stays out of the conversation. Event payloads open only on request.
- Webhook Copy selects the task; text-only Edit and retry is unavailable.
- Switching Activity to Hidden hides live reasoning but retains the working
  indicator. Full/Reduced keep reasoning available; Hidden keeps answer tokens.
- A search hit reveals its intermediate reply inside the completed-turn fold.

The native graphics fixture writes screenshots under
`android/app/build/outputs/transcript-screenshots/`. The checked-in
[before](assets/android-transcript/before.png),
[collapsed](assets/android-transcript/collapsed.png), and
[expanded payload](assets/android-transcript/payload-expanded.png) images
show the same synthetic conversation.

The preview APK is debug-signed with its own application ID and is written to
`android/app/build/outputs/apk/preview/app-preview.apk`. No real computer is
paired during these tests. Robolectric coverage and a successful APK build do
not establish physical-device pairing, live webhook delivery, or HTTPS behavior.

## Local evidence — 2026-09-18

- New core and Compose regressions reproduced unfolded narration, raw webhook
  metadata, and live reasoning remaining visible after selecting Hidden.
- After the fixes, all 548 core tests and 919 app tests passed, including a
  search hit in the 12th intermediate reply of a turn spanning several screens.
- The preview APK assembled successfully; its signature and separate preview
  application ID were verified with the Android SDK tools.
- Before/after screenshots from the native graphics fixture were visually
  inspected. All conversation state and HTTP responses were synthetic.
