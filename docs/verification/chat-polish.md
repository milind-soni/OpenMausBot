# Chat galleries, tool details, and settings

## Launch the disposable app

```sh
node --experimental-strip-types scripts/verify-chat-polish.ts
```

Open the printed `previewUrl`, not an already-running app. The fixture copies
tracked sample image/video assets and synthetic documents into a temporary home,
sends one real HTTP turn through the fake Claude driver, and mounts the real app.
It prints the server URL, PID, data directory, log path and bot ID. Ctrl-C closes
only its own preview/server and removes its disposable data; the log is retained.
No personal provider account, real credentials, or user workspace is used.

## User-visible checks

1. Open Bash with a click or Enter: the command and successful result appear.
   Its fixture password/token must be redacted. Collapse it again. Read shows a
   failed file lookup; Search says no output was recorded. Reload and reopen
   Bash: its input/result still appear. The disclosure is closed by default,
   exposes its expanded state, and has visible keyboard focus.
2. Open the uploaded image from the gallery, then close its existing viewer.
3. The assistant gallery starts with four of five attachments. Show more reveals
   the fifth, Show less collapses it, and original Markdown links remain usable.
4. The video is initially unloaded. Load it explicitly, use the native play
   control, verify playback, then close the preview. No autoplay. This is a
   message-authorized local file, not a direct filesystem URL in the browser.
5. Open Settings: search has focus. General uses aligned language/analytics
   rows; Appearance retains the existing skins and flattens simple switches.
   Search for Appearance, press Escape to clear search, then Escape to close.
   New or share displays the actual platform shortcut next to New Bot.
6. Check 1280×900 and 390×844, in Midnight and Atelier. Controls must remain
   reachable, filenames/results wrap or truncate within their surfaces, and the
   document must not overflow horizontally. Restore the viewport afterward.

## Regression checks

```sh
pnpm exec vitest run src/components/AttachmentGallery.test.ts src/components/AttachmentPreview.test.ts src/components/ToolActivity.test.ts src/components/SettingsPrimitives.test.ts src/components/ShortcutHint.test.ts server/message-file.test.ts scripts/testing/verification-docs.test.ts
pnpm exec vitest run server/tool-summary.test.ts server/control-omb.test.ts server/drivers/claude.test.ts server/drivers/codex.test.ts server/drivers/pi.test.ts server/drivers/acp/acp.test.ts
pnpm typecheck
pnpm lint
pnpm check:contrast
```

The server/driver fixtures cover bounded/redacted previews, structured JSON inside
text, binary omission, renderer HTTP hydration and SQLite persistence. Compact
model-facing control transcripts deliberately omit the new display-only fields.
Attachment tests cover existing file authorization, MIME checks, a 25 MB cap
(including chunked streams), aborted reads and encoded filenames.

## Evidence: 2026-09-13

Manually driven with computer use against the isolated fixture:

- [Desktop settings](evidence/chat-polish/settings-desktop.png)
- [Narrow, light settings](evidence/chat-polish/settings-narrow.png)
- [Expanded tool input/result](evidence/chat-polish/chat-details.png)

Successful, failed, and missing tool results were observed; redacted details
survived reload. The local MP4 decoded at 1592×1524, duration 14.03 s, and playback
advanced without a media error. Both gallery expansion directions, the image
dialog, settings search/Escape, and the New Bot shortcut hint were exercised.
At 390 px, document scroll width remained 390 px. No browser console errors were
reported in this run. The retained fixture log was
`server-1789307799660-26000.log` in the temporary `openmausbot-verification-evidence`
directory printed by the launcher.

These are offline provider fixtures and browser renderer checks, not live-model
or packaged Electron/phone tests. Older messages or providers with no result
payload show an explicit missing-output message. Video preview does not add new
composer upload formats or enable remote embedded video. Existing approvals and
file-access authorization are unchanged.
