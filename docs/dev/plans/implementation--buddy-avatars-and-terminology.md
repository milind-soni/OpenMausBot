# Implementation plan: SVG Buddy avatars, live motion states, and Buddy/Buddies terminology

## Objective

1. Replace the current Cursor mascot with the new 3-part SVG **Buddy** avatar (`Assets/Buddy Avater/BuddyBody.svg`, `BuddyLeftEye.svg`, `BuddyRightEye.svg`), positioned strictly according to `Assets/Buddy Avater/Buddy placement guides.png`.
2. Give Buddies expressive, lightweight SVG/CSS + pointer-reactive animations:
   - **Idle:** gentle vertical hover with slow continuous body rotation (`~26s`) while the eyes stay upright, blink naturally, and subtly glance.
   - **Active (`working`):** faster body rotation (`~3.8s`), livelier hover lift, and periodic horizontal shake bursts.
   - **Specialized live states:** distinct motion and visual cues for **Preview** (`preview`), **running tests** (`testing`), **thinking** (`thinking`), **writing** (`writing`), **searching** (`searching`), **listening** (`listening`), **queued** (`queued`), **needs attention** (`attention` / `notifying`), **error** (`error` / `alerting`), **usage limit** (`limited`), **connecting** (`loading`), **paused** (`paused`), **sleeping** (`sleeping`), **success** (`success`), and **celebrate** (`celebrate`).
3. Update user-facing terminology across Studio from **Bot / Bots** to **Buddy / Buddies** to align with the Gerer brand.
4. **Out of scope:** renaming persisted JSON keys (`bots.json`, `botId`, `role: "bot"`), HTTP routes (`/api/bots`), or internal MCP tool identifiers (`ask_bot`, `list_bots`), so existing workspaces, transcripts, and agent tools stay 100% compatible.

## Current state

- **Avatar rendering (`src/components/Avatar.tsx`, `src/components/CursorAvatar.tsx`):**
  - `MausAvatar` wraps `CursorAvatar`, a 1,660-line morphing blob mascot with baked-in geometry.
  - All app call sites (`Sidebar.tsx`, `ChatView.tsx`, `GroupView.tsx`, `RoomActivityPanel.tsx`, `SettingsPanel.tsx`, `RoomSettings.tsx`, `Composer.tsx`, `Onboarding.tsx`, `UsagePopover.tsx`) render `<MausAvatar color={...} state={...} size={...} />`.
- **Authoring geometry (`Assets/Buddy Avater/`):**
  - `Buddy placement guides.png` defines a `1024 × 1024` canvas:
    - Viewer-left eye (`BuddyRightEye.svg`): `x = 210`, `y = 284`, `width = 183`, `height = 292` (`448 px` from bottom).
    - Inter-eye gap: `80.5 px`.
    - Viewer-right eye (`BuddyLeftEye.svg`): `x = 472.744` (`≈ 473.5`), `y = 284`, `width = 183`, `height = 292` (`369 px` from right edge).
    - Body (`BuddyBody.svg`): 12-lobe scalloped cloud silhouette centered at `(512, 512)` in the `1024 × 1024` space (exported with a `-9.823409` slice offset into a `1005 × 1005` `viewBox`).
  - A standalone interactive motion prototype has been prepared at [docs/design/buddy-motion-study.html](/Users/esoefildine/Documents/Dev/GererBuildStudio/docs/design/buddy-motion-study.html).
- **State selection bug (`src/lib/mascot.ts:167`):**
  - `stateForBot(bot)` checks `const pinned = normalizeState(bot.mascotExpression); if (pinned) return pinned;` **before** checking `bot.busy`, failed tool runs, unread messages, or pending questions/approvals. Any Buddy with a saved expression never shows live working, error, or attention states.
  - Room headers (`src/components/GroupView.tsx:369`) and the Room Activity panel (`src/components/RoomActivityPanel.tsx:93`) hardcode `state={normalizeState(b.mascotExpression) ?? "happy"}` instead of deriving live state.
- **Terminology:**
  - User-facing UI strings across `src/`, `electron/schedule-notifications.mjs`, and user-visible error/status strings in `server/` currently say "bot" / "bots".

## Proposed changes

### 1. SVG Buddy avatar component (`src/components/BuddyAvatar.tsx` & `src/components/Avatar.tsx`)

1. **Create `src/components/BuddyAvatar.tsx`:**
   - Normalize all three SVG parts onto `viewBox="0 0 1024 1024"`:
     - `<g className="buddy-body-spin">` rotating around `512 512` using the exact path and matrix from `BuddyBody.svg`, filled with `currentColor` (driven by the Buddy's selected color from `MAUS_COLORS`, plus mint `#00C9A8` support).
     - `<g className="buddy-face">` containing the two eye sub-SVGs at `x="210" y="284" width="183" height="292"` and `x="472.744186" y="284" width="183" height="292"` with `#FBEAFF` fill, so only the scalloped body rotates while the eyes remain upright and readable.
   - Support pointer-follow gaze (`trackPointer`) composed with state-driven eye animations (blinking, upward ponder, horizontal scan, writing cadence, sleepy/happy/concerned eye transforms).
   - Include state overlays that automatically hide at compact sizes (`size < 32`):
     - `preview`: soft corner framing brackets + horizontal page-scanning gaze.
     - `testing`: focused stepped scan + three animated verification dots.
     - `attention` / `notifying`: gentle double-nudge + amber `!` badge.
     - `error` / `alerting`: slow concerned rock + tilted eyes + rose `!` badge.
     - `limited`: relaxed eyes + slate clock (`◷`) badge.
     - `listening` / `connecting`: subtle pulse halo.
     - `success` / `celebrate`: squash-and-stretch hop + brief sparkles, settling back to idle.
   - Respect `@media (prefers-reduced-motion: reduce)` and `animated={false}` by pausing continuous transforms and showing clear static resting expressions for each state.
2. **Update `src/components/Avatar.tsx`:**
   - Replace `CursorAvatar` usage inside `MausAvatar` with `BuddyAvatar` while keeping `MausAvatar`, `MausAvatarProps`, and `MausAvatarHandle` (`blink`, `spin`, `setExpression`) intact so existing call sites and `src/mascot-preview.tsx` continue to work.

### 2. Live state priority and Preview / testing / room integration (`src/lib/mascot.ts` & UI views)

1. **Expand and prioritize `stateForBot` (`src/lib/mascot.ts`):**
   - Add first-class states `preview`, `testing`, `queued`, `attention`, `error`, `limited`, `paused`, `success` alongside existing `MausState` values.
   - Evaluate live operational state **before** `bot.mascotExpression`:
     1. **Needs attention (`attention` / `alerting`):** unanswered live `options` message (`requestId` with no `answered`/`dismissed`), room activity status `"approval"`, or a Preview testing session in `"error"` / needing user intervention.
     2. **Error (`error` / `alerting`):** latest visible message is a failed activity (`tool.ok === false`) or room activity status is `"failed"`.
     3. **Usage limit (`limited`):** Buddy is waiting on usage capacity (`usingBackup` retry wait or active `auto-resume` schedule).
     4. **Preview / Testing (`testing` / `preview`):**
        - Active Preview testing session for `bot.id` (`useTestingState().sessions`), or running a test command/tool → `testing` (when running assertions/test suites) or `preview` (when inspecting/navigating a page in Preview).
     5. **Active turn sub-states (when `bot.busy` is true):**
        - Streaming reasoning active (before text) → `thinking`
        - Streaming text active → `writing`
        - Latest running tool is search/web/file lookup → `searching`
        - Default busy state → `working` (faster rotation + shake)
     6. **Queued (`queued`):** Buddy is listed in `group.queuedBotIds` or has a local queued message waiting.
     7. **Unread notification (`notifying` / `attention`):** `bot.unread` is true.
     8. **Resting identity:** `normalizeState(bot.mascotExpression)` if chosen by the user, otherwise role-inferred state or `"idle"`.
2. **Wire live context into avatar call sites:**
   - `src/components/Sidebar.tsx`, `src/components/ChatView.tsx`, `src/components/SettingsPanel.tsx`: pass active Preview session and streaming/reasoning status into `stateForBot`.
   - `src/components/GroupView.tsx` and `src/components/RoomActivityPanel.tsx`: use `stateForBot` with the room's `busyBotId`, `queuedBotIds`, and `roomActivity[bot.id]` instead of hardcoded `"happy"`.

### 3. "Buddy / Buddies" terminology pass

Update user-visible strings from `Bot` / `Bots` to `Buddy` / `Buddies` (preserving capitalization) across:
- **Core shell & navigation:** `src/App.tsx`, `src/components/Sidebar.tsx`, `src/components/Onboarding.tsx`, `src/lib/onboardingCopy.ts`.
- **Chat, Composer & Rooms:** `src/components/ChatView.tsx`, `src/components/Composer.tsx`, `src/components/GroupView.tsx`, `src/components/RoomSettings.tsx`, `src/components/RoomActivityPanel.tsx`, `src/components/Reactions.tsx`, `src/lib/messageSize.ts`.
- **Settings, Usage & Computer:** `src/components/SettingsPanel.tsx`, `src/components/SettingsScreen.tsx`, `src/components/BackupSettings.tsx`, `src/components/ModelPicker.tsx`, `src/components/ComputerPanel.tsx`, `src/components/UsagePopover.tsx`, `src/components/AutoResumeNoticeCard.tsx`.
- **Preview, Schedules, Tasks & Apps:** `src/components/PreviewBotBar.tsx`, `src/components/PreviewScreen.tsx`, `src/components/MobilePreviewPanel.tsx`, `src/components/SharePreviewModal.tsx`, `src/components/SchedulesScreen.tsx`, `src/components/ScheduleSheet.tsx`, `src/components/TaskBoardScreen.tsx`, `src/components/AppsScreen.tsx`, `electron/schedule-notifications.mjs`.
- **User-facing server errors/notices:** `server/index.ts`, `server/schedules.ts`, `server/preview-testing.ts`, `server/store.ts` (keeping internal API routes, JSON fields, and test expectations aligned).

## Verification

- **Automated tests:**
  - `src/lib/mascot.test.ts`: unit tests verifying eye-placement coordinates (`210, 284` and `472.744, 284` on `1024×1024`), live state precedence over `mascotExpression`, and detection of `working`, `thinking`, `writing`, `preview`, `testing`, `queued`, `attention`, `error`, and `idle`.
  - Update any existing unit tests that assert on user-visible `"bot"` / `"bots"` copy (`src/lib/onboardingCopy.test.ts`, `src/lib/messageSize.test.ts`, server tests if applicable).
  - Run `pnpm typecheck` and `pnpm test` under Node 24.
- **Visual & interactive checks:**
  - Verify the interactive motion study at [docs/design/buddy-motion-study.html](/Users/esoefildine/Documents/Dev/GererBuildStudio/docs/design/buddy-motion-study.html).
  - Verify avatar rendering at `16px`, `24px`, `28px`, `40px`, `64px`, and `112px` across Sidebar, Chat header, Empty chat intro, Room header, Room Activity panel, and Buddy Settings panel, including `prefers-reduced-motion`.

## Risks and rollback

- **Risk:** Small avatars (`16px`–`24px` in room headers and mention chips) could look cluttered if state badges or brackets render at full weight.
  - **Mitigation:** Automatically hide peripheral ornaments (`marker`, `brackets`, `testdots`, `sparkles`, `earring`) when `size < 32`, relying on body rotation speed, shake, and eye posture at micro sizes.
- **Risk:** Renaming internal fields or routes would break persisted `~/.gbs/bots.json` or active drivers.
  - **Mitigation:** Strictly scope the rename to user-visible UI copy and human-readable error/notification messages; leave all persistence, HTTP endpoints, and driver/MCP contracts untouched.
- **Rollback:** Revert the scoped commit; `CursorAvatar.tsx` remains in tree or can be restored cleanly via Git.

## Approval

Status: approved by the user on 2026-11-18 ("continue implementation alone"); implemented, in review.
