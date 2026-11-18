---
status: review
created: 2026-11-18
updated: 2026-11-18
scope: SVG Buddy avatars, live motion states, and Buddy/Buddies terminology
owner: Yv
related: [todo--plain-language-pass.md, review--bot-preview-testing.md]
---

# Replace bot avatars with animated SVG Buddies and align "Buddy / Buddies" terminology

Replace the legacy Cursor mascot with the new 3-part SVG Buddy avatar (`Assets/Buddy Avater/`), honoring the 1024×1024 eye-placement guide, slow idle body rotation + hover, faster active body rotation + shake, and distinct animations for Preview, testing, thinking, writing, searching, queued, attention, error, usage-limit, paused, sleeping, and celebration states. Update user-facing "Bot / Bots" copy across Studio to "Buddy / Buddies" while keeping storage (`bots.json`), HTTP routes (`/api/bots`), and MCP tool names (`ask_bot`, `list_bots`) backward-compatible.

---

## 1. SVG Buddy avatar component and motion system

- [?] **Build the normalized 1024×1024 SVG Buddy renderer** — `src/components/BuddyAvatar.tsx:1`, `src/components/Avatar.tsx:1`. Render `BuddyBody.svg`, `BuddyRightEye.svg` (viewer-left at `x=210, y=284, 183×292`), and `BuddyLeftEye.svg` (viewer-right at `x=472.744, y=284, 183×292`) inside a unified `0 0 1024 1024` coordinate space matching `Assets/Buddy Avater/Buddy placement guides.png`. Keep the `MausAvatar` export and props compatible so all call sites work cleanly.
- [?] **Implement idle, active, and specialized state animations** — `src/components/BuddyAvatar.tsx:1`, `src/components/BuddyAvatar.css:1`. Support slow continuous body rotation (`~26s`) and gentle vertical hover on idle; faster body rotation (`~3.8s`), buoyant hover, and periodic horizontal shake on active (`working`); plus distinct motion and visual cues for `thinking`, `preview`, `testing`, `writing`, `searching`, `listening`, `queued`, `attention` (`notifying`), `error` (`alerting`), `limited`, `connecting` (`loading`), `paused`, `sleeping`, `success`, and `celebrate`. Hide micro-badges/ornaments below `32px` and respect `prefers-reduced-motion: reduce` and `animated={false}`.

## 2. Live state priority and wiring across chat, rooms, and Preview

- [?] **Prioritize live activity over saved expressions in `stateForBot`** — `src/lib/mascot.ts:167`. Ensure live states (error, attention/options, Preview, testing, thinking, writing, searching, working, queued, unread) take precedence over a Buddy's saved resting `mascotExpression`, which applies when the Buddy is at rest.
- [?] **Connect live Preview, testing, streaming, and room states to avatars** — `src/components/Sidebar.tsx:490`, `src/components/ChatView.tsx:826`, `src/components/GroupView.tsx:367`, `src/components/RoomActivityPanel.tsx:91`, `src/components/SettingsPanel.tsx:107`. Pass live streaming/reasoning, room queue/activity status, and active Preview/testing session state into the Buddy avatar so headers, sidebar rows, and room cards reflect what each Buddy is doing in real time.

## 3. "Buddy / Buddies" terminology alignment

- [?] **Update sidebar, navigation, and onboarding copy** — `src/components/Sidebar.tsx:734`, `src/App.tsx:120`, `src/lib/onboardingCopy.ts:33`, `src/components/Onboarding.tsx:1`. Replace user-visible "Bot / Bots" labels, tooltips, empty states, and onboarding descriptions with "Buddy / Buddies".
- [?] **Update chat, composer, settings, and room copy** — `src/components/ChatView.tsx:445`, `src/components/Composer.tsx:64`, `src/components/SettingsPanel.tsx:120`, `src/components/SettingsScreen.tsx:821`, `src/components/BackupSettings.tsx:12`, `src/components/ModelPicker.tsx:193`, `src/components/ComputerPanel.tsx:55`, `src/components/GroupView.tsx:519`, `src/components/RoomSettings.tsx:116`, `src/components/Reactions.tsx:45`, `src/lib/messageSize.ts:21`.
- [?] **Update Preview, schedules, tasks, apps, usage, and user-facing server messages** — `src/components/PreviewBotBar.tsx:60`, `src/components/PreviewScreen.tsx:357`, `src/components/MobilePreviewPanel.tsx:323`, `src/components/SharePreviewModal.tsx:264`, `src/components/SchedulesScreen.tsx:17`, `src/components/ScheduleSheet.tsx:75`, `src/components/AutoResumeNoticeCard.tsx:13`, `src/components/TaskBoardScreen.tsx:258`, `src/components/UsagePopover.tsx:157`, `src/components/AppsScreen.tsx:257`, `electron/schedule-notifications.mjs:20`, `server/index.ts:363`, `server/schedules.ts:15`, `server/preview-testing.ts:49`.

## 4. Verification

- [?] **Add unit tests for Buddy state resolution and updated copy** — `src/lib/mascot.test.ts:1`, `src/lib/onboardingCopy.test.ts:1`, `src/lib/messageSize.test.ts:1`. Verify live states override pinned resting expressions, Preview/testing/thinking/writing/error/attention/queued states resolve accurately, and copy tests pass.
- [?] **Run full test suite, typecheck, and visual verification** — Verify avatar rendering and eye placement at `16px`, `24px`, `28px`, `40px`, `64px`, and `112px`, plus reduced-motion behavior.

---

## Implementation notes (2026-11-18, Yv)

- **Renderer:** `src/components/BuddyAvatar.tsx` draws the three original paths on one `1024×1024` canvas; the body's `-9.82` slice offset is removed, centring it on `512,512`. Only the body turns. A fixed highlight disc (r 456, inside the scallops' 459 inner radius) gives depth without rotating with the body. `MausAvatar` (`src/components/Avatar.tsx`) keeps its props and handle; the 1,660-line `CursorAvatar.tsx` is deleted.
- **Motion:** `src/components/BuddyAvatar.css`. All motion is CSS keyed off `data-mood`: idle turns in 26 s; working turns in 3.6 s with a quicker bob and shake bursts. Each live state has its own gaze path and ornaments (Preview brackets, test dots, writing caret, thought bubbles, listening halo, attention/error/limit badges, success and celebrate hops with sparkles). Ornaments hide below 32 px. Reduced motion and `animated={false}` show a still look, and every Buddy pauses while the window is hidden.
- **Live state:** `stateForBot` (`src/lib/mascot.ts`) now ranks attention, then error or usage limit, then the busy sub-states (writing, testing, Preview, connecting, searching, thinking, working), then queued and unread, before the saved expression. Failures are judged over the whole latest turn, because a usage-limit turn ends with a notice after the failed step. `LiveBuddyAvatar` and `RoomBuddyAvatar` (`src/components/LiveBuddyAvatar.tsx`) read streaming and Preview sessions themselves. Sidebar rows also show room work. A turn that ends cleanly gets one hop.
- **Picker:** ten resting expressions, each drawn differently. The new color `mint` (`#00C9A8`, the artwork's own) was added to `src/lib/mascot.ts` and `server/store.ts`. Role-inferred looks no longer use busy states, so a "Developer" Buddy doesn't shake at rest.
- **Wording:** user-visible copy only. `bots.json`, `botId`, `role: "bot"`, `/api/bots` and MCP tool names are unchanged. Messages sent only to agents (Preview tool errors, MCP descriptions) are unchanged.
- **Gallery:** `mascot-preview.html` now shows every state, color, size and motion.

## Verification

- `src/lib/mascot.test.ts`: 15 tests covering eye boxes against the guide (80.5 gap), live states over saved expressions, Preview/testing/search detection, attention, error vs usage limit (including the real notice sequence), room queueing, and legacy names.
- `pnpm typecheck` passes on Node 24.19. `pnpm test`: 528/530. The 2 failures are the existing backup-retry tests in `server/schedules-runtime.test.ts`.
- Isolated desktop instance (own user data, harness 8977, Vite 5391, fake AI apps): confirmed through DevTools that each avatar showed the expected state. Yv working, SoSo limited (with clock badge), Dell notifying, Marty playful and Z sleeping at rest, then Z working and Marty queued in a room (header, Activity panel and sidebar). Settings shows the 112 px Buddy, ten distinct expressions and the mint swatch.
- Not covered on screen: Preview and testing states during a real Buddy turn (covered by unit tests and the gallery), and the system reduced-motion setting (CSS only).
