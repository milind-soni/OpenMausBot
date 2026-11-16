# Bot-controlled testing inside Preview

Status: proposed — awaiting explicit user approval
Date: 2026-11-16
Owner: Yv

## Outcome

Bots test websites and project HTML in Studio Preview, visibly, using the same page the user can review. They can navigate, inspect, interact, resize, collect diagnostics and attach evidence without launching Chrome. No new approval prompt for each ordinary page action; existing bot permissions and navigation policies remain applicable.

## Verified foundation

- `src/components/PreviewFrame.tsx` is shared by Quick Preview and Preview Studio. Desktop uses Electron webviews; browser sessions use iframes.
- `electron/main.mjs` tracks Preview guest webContents and captures screenshots, including full-page images through its existing debugger connection.
- `server/drivers/agents-proxy.ts` already exposes authenticated bot tools through the harness. Its current results are text-only, so screenshot image blocks need explicit support.
- Claude, Codex and ACP core advertise `agentsMcp`. Antigravity currently does not. Tool availability must follow actual driver capability; do not advertise unavailable tools.
- The existing agents integration is gated by peer-delegation depth. Preview capability must be independent of peer recursion so a legitimately delegated tester can still test.

## User experience

1. A bot opens a named testing session associated with its conversation and project. Preview opens with the page, viewport and a clear “Controlled by [bot]” indicator.
2. The bot inspects, clicks and fills forms while the user watches. The header shows activity and a persistent Stop/take-control action.
3. Switching chat does not silently retarget the bot. Each command names an owned session/frame; bots cannot fight over a shared frame. Multiple sessions stay bounded by the existing frame budget.
4. Stop cancels queued work and revokes the control lease. In-flight operations may have already affected the page; they are not described as rolled back. User takeover prevents subsequent automated input until control is explicitly resumed.
5. Results include source URL, actual viewport, screenshot and actionable console/network failures. Evidence can be attached to chat and linked from a task report.
6. Ordinary viewing and the existing file viewers remain usable. A website interaction session is distinguished from Markdown/image/PDF viewing.

## Proposed bot tools

- `preview_status`: availability, capabilities and the caller's sessions.
- `preview_open`: URL or project HTML, named session, viewport/preset/Responsive mode.
- `preview_snapshot`: bounded DOM/accessibility summary with actionable element references and current URL/title/viewport. References expire after navigation or target replacement.
- `preview_action`: validated click, fill, select, keypress, scroll, wait, reload, back/forward and resize operations. Use semantic element references; return useful stale-target errors.
- `preview_screenshot`: actual visible/full-page PNG as an MCP image block plus a saved evidence artifact.
- `preview_diagnostics`: bounded console errors and failed request summaries, scoped to this session.
- `preview_close`: release the session and its resources.

No raw remote-debugging port, arbitrary main-window control or general-purpose CDP passthrough is needed. Structured browser actions are the first version; additional capabilities can be added after the core is verified.

## Implementation

1. Add a platform-neutral session/command broker (`server/preview-testing.ts`) with caller ownership, bounded queues, cancellation, frame budgets, timeouts and explicit unavailable states. Add authenticated bot routes in `server/index.ts` and tool schemas/results in `server/drivers/agents-proxy.ts`.
2. Add an Electron-only companion bridge (`electron/preview-testing.mjs`). The desktop launcher/main process supplies a dedicated ephemeral bridge credential to the harness and Electron, never to website guests. Desktop consumes bounded queued commands and acknowledges results. Packaged utilityProcess startup and `scripts/dev-desktop.mjs` must both wire this; an already-running incompatible dev harness reports restart-required rather than silently failing.
3. Main/preload IPC requests creation of a Preview target in the renderer. The renderer registers the session/frame; main validates that the resulting guest belongs to that app window and session. Only registered Preview guests can receive control commands. Target registration has generation IDs so destroyed/replaced frames cannot receive stale work.
4. Implement bounded inspection/input/diagnostics on the actual guest. Share debugger ownership with the existing screenshot path, so one operation cannot detach another's connection. Apply viewport changes to the real frame rather than merely scaling an image.
5. Update `PreviewFrame`, Quick Preview and Preview Studio to register targets, display bot ownership/activity, and provide Stop/take-control. Persist the minimum session metadata needed to show status; do not resume actions automatically after restart.
6. Return real image content through the MCP proxy. Save evidence under a project-scoped artifact directory when available; return explicit ephemeral evidence otherwise. Bound result sizes and omit credential-bearing request headers/cookies from diagnostics.
7. Update bot instructions to prefer Preview for Studio project website testing when capability is available. Expose capabilities in direct and room turns independently of peer messaging depth. Verify provider-specific tool mounting; unsupported drivers receive an honest unavailable result, not a claim of universal support. Antigravity needs a separate verified integration path before being labelled supported.

## Scope and limits

The first implementation targets the desktop app. Cross-origin browser iframes do not provide equivalent inspection/control; browser-only Studio must report that capability limit, without silently launching Chrome. Same-origin browser support can be added if it shares the same tested contracts. These checks cover Studio's embedded browser, not Safari/Firefox or physical devices. Speed, resource use and token savings are potential benefits to measure, not promised improvements.

Retain existing guest isolation, project file scoping and navigation checks. Local development servers already authorized for the project should not create repetitive per-click prompts. Pages do not receive the bridge credential or access to app controls. Per-session ownership also keeps two testing bots from sending input to one another's targets.

## Responsibilities and delivery order

| Role | Responsibility | Exit criterion |
|---|---|---|
| CEO / Yv | Scope, acceptance gates, cross-role coordination | Approved plan and one coherent visible workflow |
| Developer | Broker, desktop bridge, tools, provider wiring | Commands operate on actual owned Preview targets |
| UI/UX Designer | Ownership, activity, session selection, Stop/take-control | User can see and interrupt testing without confusion |
| Tester | Isolated harness + Electron tests, real local fixture site | Navigation/form/viewport/evidence/cancellation checks pass |
| Marketer | In-app help and capability wording | Clear desktop-first promise with no unsupported browser claims |

This is a responsibility plan, not a record of delegated work. No messages have been sent to other bots.

Deliver in order: (1) contracts and broker, (2) vertical desktop flow open → inspect → act → screenshot, (3) ownership/takeover and diagnostics, (4) provider and regression qualification.

## Acceptance gates

- A real tool-capable bot opens a local fixture in Preview, reads its controls, fills and submits a form, verifies the result and returns a real screenshot without launching Chrome.
- Mobile/tablet/desktop and Responsive tests report the actual viewport and reflow correctly.
- User Stop, takeover, navigation, frame destruction, server/desktop disconnect and competing bots produce deterministic results with no later queued input.
- Foreign session/frame access and website attempts to control Studio are rejected. Authenticated broker tests use throwaway data, never the real user workspace.
- Existing screenshot/sharing, manual Preview, file viewer and chat/room behavior remain functional.
- Validate supported provider paths and image delivery; unsupported providers are clearly identified.
- Typecheck, relevant unit/integration tests, production build and isolated Electron end-to-end checks pass; record the two pre-existing schedule-recovery failures separately if they remain.

## Expected benefits

Visible tests and immediate user takeover; shorter handoffs between building and reviewing; repeatable viewport checks using existing sizes; screenshots and errors linked directly to conversations/tasks; less separate-browser window management; reusable test sessions for Developer/Tester collaboration. Existing Preview sessions may reduce repeated navigation/sign-in, subject to verified partition/session behavior. No benchmark claim is made yet.
