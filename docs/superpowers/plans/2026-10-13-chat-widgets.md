# Chat Widgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bot can show a ChatKit-style widget in chat with `show_widget`, it renders on desktop, iOS and Android from one payload, and a press reaches the bot as the person's next message.

**Architecture:** One canonical JSON tree, normalised once on the server by `shared/widget.ts`, stored on a new `widget` message kind with a text fallback. One recursive renderer per platform. A press is posted on the existing send-message route as `widgetAction`, becomes an ordinary user message that replies to the widget, and settles the widget with a `message.patch`.

**Tech Stack:** TypeScript (Node type-stripping server, React 19 + Tailwind v4 renderer, vitest); Swift 5.9 / SwiftUI / Swift Charts (iOS 16); Kotlin 2.2 / Jetpack Compose / kotlinx.serialization.

**Spec:** `docs/superpowers/specs/2026-10-13-chat-widgets-design.md` (this repo). Design canvas: https://claude.ai/artifact/3jp8ZJ62qQCx8BXejVp8gv

## Global Constraints

- Two repos, two branches named `feat/chat-widgets`: server, shared and desktop in `OpenGrokBot-widgets` (milind-soni/OpenMausBot); iOS and Android in `mausbot-mobile-widgets` (SupaMaus/mausbot-mobile). Never put phone code in the first or desktop code in the second. No push, no PR.
- Ratchets (`scripts/testing/file-size-ratchet.test.ts`, `index-route-ratchet.test.ts`): `server/index.ts`, `src/state/store.tsx`, `server/store.ts`, `server/config.ts`, `ChatView.tsx`, `GroupView.tsx`, `scripts/mcp-server.ts`, `server/drivers/agents-call.ts` may not gain a line; `server/index.ts` may not gain a path guard; no new file over 1,000 lines. Move code out to make room and lower the pinned number.
- Server code runs on type stripping: type-only imports must be `import type`, no enums, no parameter properties.
- Tests are colocated `*.test.ts` (never `.tsx`); React tests start with `// @vitest-environment happy-dom` and use `createElement`.
- Every desktop UI string goes through `t()` with a key in `src/locales/en.json`. iOS strings need `pt-BR`, `zh-Hans`, `zh-Hant` entries in `ios/App/Localizable.xcstrings`; Android strings need `values/`, `values-b+zh+Hans/`, `values-b+zh+Hant/`.
- Colours come from tokens only: no hex literals in widget renderers on any platform.
- On phones the type prefix is `ChatWidget`; `Widget` there means the home-screen extension.
- Renderers read canonical trees only and must never crash on one: an unknown node type draws its children or nothing.
- Checks before a task is done. Desktop: `pnpm typecheck`, `pnpm lint`, `pnpm exec vitest run <files>`, `pnpm i18n:check`, plus the two ratchet tests. iOS: `swift test --package-path ios`, `bash scripts/check-ios-view-shims.sh`, `node --test scripts/ios-strings.test.mjs`. Android: `JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew :core:test :app:testDebugUnitTest` from `android/`.

## Review Focus

1. A model sends sloppy JSON (a string, extra props, a non-root at the top, ChatKit spacing units): it must normalise or fail with a sentence naming the path, never post a broken card. Pinned in Task 1.
2. A press arrives twice (double tap, client retry with the same `sendId`): one user message, one settle. Pinned in Task 2.
3. A press arrives for a settled widget, a wrong thread or another bot's message: refused with 409 or 404, nothing sent. Pinned in Task 2.
4. A secret pasted into a widget string, and a password field: redacted before storage; rejected at parse. Pinned in Tasks 1 and 2.
5. An older or offline client: the text fallback reads well on its own, and a cached phone thread shows values but no live actions. Pinned in Tasks 1, 4 and 5.

---

### Task 1: Shared schema and wire kind

**Files:**
- Create: `shared/widget.ts`, `shared/widget-samples.ts`, `shared/widget.test.ts`
- Modify: `shared/wire.ts` (kind union, `widget?: WidgetPayload`), `src/lib/taskTimeline.ts` (kind union)

**Interfaces (produces):**
```ts
export const WIDGET_LIMITS: {...}; export const WIDGET_ICON_NAMES: readonly string[];
export interface WidgetAction { type: string; payload?: JsonValue }
export interface WidgetNode { type: string; id: string; children?: WidgetNode[]; [prop: string]: unknown }
export type WidgetRoot = WidgetNode;            // type "Card" | "ListView"
export interface WidgetSettled { ref: string; label: string; tone: "confirm" | "cancel" | "submit"; at: number; sendId?: string }
export interface WidgetPayload { v: 1; root: WidgetRoot; settled?: WidgetSettled }
export type WidgetValues = Record<string, string | boolean>;
export function parseWidgetInput(value: unknown): { ok: true; value: WidgetRoot } | { ok: false; error: string };
export function widgetToText(root: WidgetRoot): string;
export function widgetFields(scope: WidgetNode, root: WidgetRoot): WidgetField[];   // {name, type, label, node}
export function widgetInitialValues(scope: WidgetNode): WidgetValues;
export function widgetScope(root: WidgetRoot, ref: string): WidgetNode;             // nearest Form, else root
export function widgetActions(root: WidgetRoot): WidgetActionEntry[];              // {ref, label, action, tone?, client?}
export function widgetActionByLabel(root: WidgetRoot, label: string): WidgetActionEntry | undefined;
export function resolveWidgetAction(payload: WidgetPayload, ref: string, values: unknown):
  | { ok: true; ref: string; label: string; action: WidgetAction; values: WidgetValues; text: string; tone?: "confirm" | "cancel" | "submit" }
  | { ok: false; status: 400 | 404 | 409; error: string };
```
`WIDGET_SAMPLES` (in `widget-samples.ts`) is a record of named model-shaped inputs covering every node type; tests, fixtures and the verification recipe all use it.

- [ ] Write `shared/widget.test.ts` first: one case per node type normalising, each limit refusing with its path, password refusal, non-root wrapping, JSON-string input, spacing-unit conversion, duplicate action labels made unique by their row title, `widgetToText` snapshots for the list, form, table and chart samples, and `resolveWidgetAction` for scope, required, option, date, settled (409), unknown ref (404) and `cancel` skipping validation.
- [ ] Run `pnpm exec vitest run shared/widget.test.ts`; it fails on the missing module.
- [ ] Implement `shared/widget.ts` and `shared/widget-samples.ts`; add the kind and field to `shared/wire.ts` and the kind to `src/lib/taskTimeline.ts`.
- [ ] Run the test, `pnpm typecheck`, `pnpm lint`. Commit.

### Task 2: Server

**Files:**
- Create: `server/chat-widgets.ts`, `server/chat-widgets.test.ts`, `server/drivers/agents-widget-tools.ts`, `server/drivers/agents-call-cards.ts`
- Modify: `server/index.ts` (swap `createOptionsCard` for `createAgentCard`, same line count), `server/drivers/agents-catalog.ts` (spread the two definitions; read-only annotation list untouched), `server/drivers/agents-call.ts` (the `create_options_card` branch moves into `agents-call-cards.ts`, which also handles the two widget tools; lower its ratchet number), `server/routes/bot-messages.ts` (`widgetAction`), `server/replies.ts` (widget branch), `server/delta-context.ts` (`isContextMessage`), `server/routes/threads.ts` (markdown export line), `server/team-backup.ts` (`messageText`), `scripts/mcp-server.ts` (projection keeps `widget`, in place), `server/drivers/agents-catalog-wire.test.ts` goldens and budget baselines, `scripts/testing/file-size-ratchet.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces: `createAgentCard({store, bot, threadId, input}): {ok: true; messageId: string} | {ok: false; status: 400|403|404|409; error: string}`; the internal body shape `{tool: "show_widget", widget, fallback_text?}` and `{tool: "update_widget", widget_id, widget}`; the public body field `widgetAction: {messageId: string, ref: string, values?: Record<string, string|boolean>}` on `POST /api/bots/:id/messages` with `text` omitted.

- [ ] Tests first (`server/chat-widgets.test.ts`, additions to `server/replies.test.ts` or a new one, and a bot-messages route test following the existing route tests): create posts `kind: "widget"` with fallback text and no `from`; a room thread is 409; strings are redacted; `update_widget` replaces a live tree and refuses a settled one, another bot's message and another thread's; a press sends one user message replying to the widget with the label text; `confirm` settles, a plain button does not; the same `sendId` twice sends once and patches once; a settled widget is 409; `promptWithReply` names the action and payload; `isContextMessage` admits a widget row.
- [ ] Implement. `createAgentCard` delegates a body without `tool` to `createOptionsCard` unchanged.
- [ ] Regenerate goldens with `UPDATE_AGENTS_CATALOG_GOLDENS=1 pnpm exec vitest run server/drivers/agents-catalog-wire.test.ts`, then edit `BUDGET_BASELINE` by hand to the printed sizes.
- [ ] Run the touched tests, both ratchet tests, `pnpm typecheck`, `pnpm lint`. Commit.

### Task 3: Desktop renderer

**Files:**
- Create: `src/components/widget/WidgetMessage.tsx`, `WidgetNodes.tsx`, `WidgetControls.tsx`, `WidgetChart.tsx`, `widget-icons.ts`, `widget-send.ts`, tests beside them (`*.test.ts`), `src/components/OptionsCardRow.tsx`
- Modify: `src/components/ChatView.tsx` (the `options` case moves into `OptionsCardRow`; add `case "widget"`; lower its ratchet number), `src/state/store.tsx` (`Message` gains `kind` and `widget` from `WireMessage`, in place), `src/lib/export-transcript.ts`, `src/locales/en.json`

**Interfaces:**
- Consumes: Task 1 types and helpers; the `widgetAction` body from Task 2.
- Produces: `<WidgetMessage botId threadId message />`, default-exported pieces not used elsewhere.

- [ ] Tests first: every sample in `WIDGET_SAMPLES` renders to markup without throwing; a list with `limit` shows "Show all"; a settled payload renders the tick line and no buttons; pressing `confirm` posts `{threadId, sendId, widgetAction}` with the form's current values; a required empty field blocks the post and marks the field; `open_url` opens the link and posts nothing; a server refusal shows its sentence in the card.
- [ ] Implement to the canvas: surface, header, rows, dot status, actions under the card, settled line with Details, `size` widths, SVG chart from tokens.
- [ ] Run tests, `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check`, `pnpm check:contrast`, both ratchets. Commit.

### Task 4: iOS

**Files (in `mausbot-mobile-widgets`):**
- Create: `ios/Sources/CompanionCore/ChatWidget.swift` (forgiving `JSONValue`, `ChatWidgetPayload`, `ChatWidgetNode` accessors, field and action helpers mirroring Task 1's scope rules), `ios/Tests/CompanionCoreTests/ChatWidgetTests.swift`, `ios/App/Cards/ChatWidgetView.swift`, `ChatWidgetNodes.swift`, `ChatWidgetControls.swift`, `ChatWidgetChart.swift`, `ChatWidgetIcons.swift`
- Modify: `Models.swift` (`Kind.widget`, `widget` payload), `StateSnapshot.swift` and its guard tests, `ChatPreferences.swift` and `Walkie.swift` kind switches, `Client.swift` (`sendWidgetAction`), `Session.swift`, `TranscriptRows.swift` (`TranscriptActions.sendWidgetAction`), `ChatView.swift` (dispatch), `Localizable.xcstrings`
- Fixture: `ios/Tests/CompanionCoreTests/Fixtures/widget-messages.json` (written by Task 1's samples; do not hand-edit)

- [ ] Core tests first: the fixture decodes every message with `kind == .widget`; a malformed tree decodes to a message that falls back to text and never throws; field collection and required checks match the fixture's expectations; the snapshot round-trips the payload.
- [ ] Implement core, then views. Offline uses the existing reconnect notice. Remote images use `AsyncImage` over https only.
- [ ] Run the three iOS checks and `xcodegen generate` plus a simulator build if the toolchain is present. Commit.

### Task 5: Android

**Files (in `mausbot-mobile-widgets`):**
- Create: `android/core/.../core/ChatWidget.kt`, `android/core/src/test/.../ChatWidgetTest.kt`, `android/app/.../ui/ChatWidgetView.kt`, `ChatWidgetNodes.kt`, `ChatWidgetControls.kt`, `ChatWidgetChart.kt`, `ChatWidgetIcons.kt`, app tests beside the existing ones
- Modify: `Models.kt` (`Kind.WIDGET`, serializer, `widget` field last), `StateSnapshot.kt` and its test, `ChatPreferences.kt`, `ChatPolicy.kt` kind switches, `Client.kt`, `Session.kt` (`sendWidgetAction`), `MessageRow.kt` (dispatch), the three `strings.xml`

- [ ] Core tests first, mirroring Task 4 on the shared fixture.
- [ ] Implement core, then composables with `Maus.colors`, `Space`, `MausShapes`; charts on a Canvas; https images through a small bounded loader.
- [ ] Run `:core:test :app:testDebugUnitTest` and `:app:assembleDebug`. Read the real counts from `build/test-results`. Commit.

### Task 6: End-to-end verification and review

- [ ] Add `docs/verification/widgets.md` (checked by `scripts/testing/verification-docs.test.ts`) and run it against an isolated fixture: a fake-engine `show_widget` call, `messages` shows the widget row, the UI snapshot shows the card, a click settles it and starts a turn. Keep the JSON and screenshots.
- [ ] Compare desktop screenshots in Meadow and Midnight against the canvas; fix differences.
- [ ] Whole-branch review of both repos; fix findings; run every check in Global Constraints once more.
