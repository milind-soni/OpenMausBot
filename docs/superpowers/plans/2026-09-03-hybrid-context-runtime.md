# OpenMausBot Hybrid Context Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` task by task. Use `superpowers:test-driven-development` for behavior changes and `superpowers:verification-before-completion` before claiming completion.

**Goal:** Make OpenMausBot's transcript, memory projection, context budgeting, and compaction canonical across all engines, then add an optional OpenMaus-owned model/tool loop for API-key and local-model bots.

**Architecture:** Dispatch creates one provider-neutral `TurnContextPlan` from the active branch. Vendor-session drivers resume normally but retain a safe replay for invalidation/recovery; replay drivers consume structured history; `openmaus-runtime` consumes the same plan before every model call and owns its agent/tool loop. Durable compaction records live on one branch while full display history remains unchanged.

**Tech stack:** TypeScript strict, Node 24, Vitest, current Store/SQLite persistence, runtime event bus and provider SPI, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and the official `@modelcontextprotocol/sdk` behind internal adapters.

**Spec:** [`docs/superpowers/specs/2026-09-03-hybrid-context-runtime-design.md`](../specs/2026-09-03-hybrid-context-runtime-design.md)

## Global constraints

- This plan targets the `milind-soni/OpenMausBot` checkout only. It has no OpenMausOS dependency.
- Implement in a dedicated worktree/branch. The current `android-release/v1.1.0` checkout contains unrelated untracked user files; never reset, overwrite, stage, or commit them.
- Inherit the constraints in `2026-08-31-00-control-plane-roadmap.md`: strict TypeScript, Node 24+, test-floor preservation, write-only secrets, `0600` durable files, capability-gated UI, unknown-config round-tripping, safe exports/imports, and audited authorization.
- Follow the repository's anti-slop lint rules: use concrete boundary types and schema validation rather than new `unknown`-shaped internal APIs or chained assertions.
- Know where the types actually live before editing. `Message` (its `kind` union and its `tool`
  field) is declared in `server/store.ts`, **not** `server/contracts.ts`; `contracts.ts` holds
  `SendTurnInput`, `ProviderAdapter.capabilities`, `ModelCatalog`, and `RuntimeEvent`. Durable
  message rows are written by `server/message-db.ts` over `node:sqlite`.
- `server/contracts.ts` documents `contextWindow` as sizing "server/context-rebuild.ts". No such
  file exists on `main`. Repoint that comment at `server/context/` in Task 2 rather than
  recreating a file to match a stale comment.
- Do not cherry-pick `3374576`. Port its pure functions/tests selectively and reconcile them with the current branch, image events, message kinds, SQLite storage, rooms, replies, queues, and dispatch claims.
- Preserve every current engine's valid-resume path. Do not migrate existing bots.
- Subscription credentials remain inside official vendor harnesses. Owned runtime supports API keys/local endpoints only and never reads CLI auth files.
- Redact and bound every stored bot/tool/summary field. Diagnostics contain metadata only.
- Portable tool observations are historical assistant context, not fabricated provider-native tool-call messages.
- Follow `docs/verification/README.md`; never mutate the installed app or `~/.openmausbot` during verification.
- Run targeted tests for every red/green cycle, `pnpm typecheck` and `pnpm lint` before task commits, and the full suite in Task 11.
- Suggested commits are local checkpoints, not authorization to push.
- `package.json` requires Node >= 24 and the local toolchain is on 22.x, so every `pnpm` command
  prints an unsupported-engine warning and `node:sqlite` runs as experimental. Tests pass, but
  Task 11's acceptance evidence must be produced on Node 24+ or it does not represent what
  ships.

---

### Task 1: Characterize current handoff behavior

**Files:**

- Create: `server/context/prepare-turn.ts`
- Create: `server/context/prepare-turn.test.ts`
- Modify: `server/index.ts`
- Modify: `server/testing/fake-driver.ts`
- Read: `server/turn-context.ts`, `server/replies.ts`, `server/drivers/{claude,codex,pi,openai-chat}.ts`

- [ ] There is no seam to characterize against: `server/index.ts` has no exports, and the
      projection is inline in a ~9,900-line entry file, so the only alternative is booting the
      real server per case through `index.test.ts`. Open the task by extracting the existing
      projection verbatim into `prepareTurnContext()` under `server/context/` — the transcript
      tail, `engineIsFresh`, and `buildTurnContext` composed behind one name — and calling it
      from the dispatch site. Behaviour-preserving refactor only: no budget, no tool
      observations, no ownership capability yet. Those arrive in Tasks 2-5, which now evolve
      this function instead of replacing an inline block.
- [ ] Add opt-in `SendTurnInput` capture to `makeFakeDriver()` without changing its defaults.
- [ ] Characterize the current 40-message cutoff against the extracted function, including that
      message size is never consulted. Record the desired budget-based behavior as `it.todo`;
      activate it in Task 5.
- [ ] Characterize current omission of `activity` messages. Record the desired portable-tool behavior as `it.todo`; activate it in Task 3.
- [ ] Characterize the duplicate-history defect, as a defect and not as desired behavior.
      `server/index.ts` sets `replaysNatively: instance.driverKind === "grok"`, but
      `openai-compat` and `minimax` are also `createOpenAIChatRuntime` drivers whose
      `messagesFor()` always prepends `turn.transcript` before `turn.text`. Assert that an
      `openai-compat` instance on a rewound / fresh / externally-updated thread currently
      receives the branch twice — once inside `turnText`, once in `transcript` — and mark the
      single-copy expectation `it.todo` for Task 5. Name the assertion so it reads as a bug
      snapshot; a later reader must not preserve it as a contract.
- [ ] Preserve regression fixtures for valid same-engine resume, engine switch, rewind, external update, queued sends, and reply context.
- [ ] Add Claude/Codex fixtures identifying whether a resume rejection occurs before or after prompt acceptance. Do not introduce retry behavior yet.
- [ ] Run:

  ```sh
  pnpm vitest run server/context/prepare-turn.test.ts server/turn-context.test.ts server/replies.test.ts server/drivers/claude.test.ts server/drivers/codex.test.ts
  pnpm vitest run server/index.test.ts
  pnpm typecheck
  pnpm lint
  ```

  `index.test.ts` boots the real server and is the proof the extraction changed no behaviour.

  Expected: green; current limitations are explicit assertions and replacement behavior is todo.

- [ ] Commit: `test: characterize current context handoff`.

---

### Task 2: Add ownership and context-plan contracts

**Files:**

- Create: `server/context/types.ts`
- Create: `server/context/types.test.ts`
- Modify: `server/contracts.ts`
- Modify: `server/testing/fake-driver.ts`
- Modify: driver capability declarations under `server/drivers/`

**Interfaces:**

```ts
export type ContextOwnership = "vendor-session" | "omb-replay" | "omb-loop";

export type ModelContextItem =
  | { kind: "user-text"; messageId: string; text: string }
  | { kind: "assistant-text"; messageId: string; text: string; speaker?: string }
  | { kind: "tool-observation"; messageId: string; observation: ToolContextSnapshot }
  | { kind: "summary"; messageId: string; text: string };

export interface TurnContextPlan {
  ownership: ContextOwnership;
  mode: "resume-preferred" | "replay-required";
  currentPrompt: string;
  replayPrompt: string;
  messages: ModelContextItem[];
  budget: ContextBudget;
  diagnostics: ContextDiagnostics;
}
```

- [ ] Require `contextOwnership` in `ProviderAdapter.capabilities`: installed CLI/ACP drivers = `vendor-session`; API transcript drivers = `omb-replay`; later owned driver = `omb-loop`. Set
      `omb-replay` on `grok`, `openai-compat`, and `minimax` — every driver built on
      `createOpenAIChatRuntime` — so ownership is a declared capability rather than the
      `driverKind === "grok"` string test it replaces.
- [ ] Add a registry test asserting each built-in driver in `BUILT_IN_DRIVERS` declares an
      ownership value, so a new driver cannot silently default into inline replay.
- [ ] Add `maxOutputTokens?: number` beside catalog `contextWindow`, and repoint the
      `contextWindow` doc comment from the non-existent `server/context-rebuild.ts` to
      `server/context/`.
- [ ] Add `context?: TurnContextPlan` to `SendTurnInput`; retain `text`/`transcript` as temporary compatibility fields.
- [ ] Give the fake driver an ownership override and add exhaustiveness tests.
- [ ] Run:

  ```sh
  pnpm vitest run server/context/types.test.ts server/harness/registry.test.ts server/drivers
  pnpm typecheck
  pnpm lint
  ```

- [ ] Commit: `refactor: declare engine context ownership`.

---

### Task 3: Build the pure active-branch projector

**Files:**

- Create: `server/context/budget.ts`
- Create: `server/context/budget.test.ts`
- Create: `server/context/project.ts`
- Create: `server/context/project.test.ts`
- Create: `server/context/render.ts`
- Create: `server/context/render.test.ts`
- Modify: `server/contracts.ts`

**Rules:**

- `contextLimitsFor(modelId, catalog)` uses catalog values, then a model-pattern table, then
  conservative defaults of 32,000 window and 4,096 output tokens, and reports which of the three
  it used as `limitsSource: "catalog" | "pattern" | "default"`. Only `pi` and `minimax` populate
  `contextWindow` today and nothing populates `maxOutputTokens`, so the pattern table is the
  primary path for nearly every shipped engine — treat it as load-bearing, not a fallback.
- `estimateContextTokens()` is planning-only and must never under-count. Use
  `ceil(asciiChars / 3) + nonAsciiChars` plus framing: `chars / 3` under-counts CJK, Devanagari,
  and emoji, where one character is often one token or more, and under-counting overflows the
  real window into a hard provider error rather than a clipped projection.
- `makeContextBudget()` reserves measured system/tools, `min(maxOutputTokens, floor(window * 0.25))` for output, and `max(1024, floor(window * 0.05))` for safety.
- `projectMessage()` maps text, room attribution, reply quotations, and safe tool observations. It skips screen/image bytes, options, connectors, secret cards, routine/goal UI receipts, empty text, and error-only activity.
- `projectActiveBranch()` preserves chronological semantic units and excludes the current/queued message IDs supplied by dispatch.
- `renderReplayPrompt()` delimits summary/tool data as untrusted history and includes the current prompt exactly once.

- [ ] Port relevant pure tests from `3374576` and add every current message kind.
- [ ] Activate the Task 1 portable-tool todo.
- [ ] Test abandoned siblings never enter context, room speakers remain attributed, and flat replies preserve their quote.
- [ ] Test that an 8k model receives less verbatim history than a 200k model with no fixed message-count rule.
- [ ] Test `limitsSource` for each branch, and assert that every shipped engine's default model
      resolves through `catalog` or `pattern` — never silently through `default`. A model that
      does fall through must say so in diagnostics.
- [ ] Test the estimator against CJK, Devanagari, and emoji fixtures and assert it never returns
      fewer tokens than the character count for non-ASCII text.
- [ ] Test oversized items are clipped only at the explicit boundary and recent user intent remains.
- [ ] Test injection-looking tool output remains delimited data.
- [ ] Run:

  ```sh
  pnpm vitest run server/context/budget.test.ts server/context/project.test.ts server/context/render.test.ts server/replies.test.ts
  pnpm typecheck
  pnpm lint
  ```

- [ ] Commit: `feat: project model context from the active branch`.

---

### Task 4: Persist safe tool observations and branch-local compactions

**Files:**

- Create: `server/context/sanitize.ts`
- Create: `server/context/sanitize.test.ts`
- Create: `server/context/compact.ts`
- Create: `server/context/compact.test.ts`
- Create: `src/components/CompactionDivider.tsx`
- Modify: `server/store.ts` (this is where `Message.kind` and `Message.tool` are declared)
- Modify: `server/store.test.ts`
- Modify: `server/message-db.ts`
- Modify: `server/message-db.test.ts`
- Modify: `server/thread-events.ts`
- Modify: `server/thread-events.test.ts`
- Modify: `src/state/store.tsx`
- Modify: `src/components/ChatView.tsx`
- Modify: `src/components/GroupView.tsx`

**Persistence contract:**

- Add message kind `compaction` and the spec's exact `CompactionRecord` to the `Message` union in
  `server/store.ts` and to the renderer's mirror of it.
- Add optional `context: ToolContextSnapshot` to `Message.tool` (also `server/store.ts`).
- Persist the divider through a new `message-db` helper that inserts the divider row and
  reparents `targetId` inside **one** `BEGIN IMMEDIATE` transaction. Two separate writes can
  orphan the branch on a crash, which is what `insertMessageAfter` does today via
  `mdb.appendMessage()` followed by per-child `patchMessage()` calls.
- The divider must not touch `thread_state`. `mdb.appendMessage()` calls
  `setActiveLeaf(threadId, full.id)` while the in-memory `activeLeafId` stays put, so a restart
  resolves the leaf to the inserted row. Use `mdb.insertMessage()` and leave the leaf alone.
  Fix the same divergence in `insertMessageAfter` while the restart tests are open — the
  compaction suite exercises exactly that path and will otherwise encode the bug.
- Keep summaries out of full-text search: `mdb.searchMessages()` selects over the `text` column
  for every kind, so write the summary into the `json` blob with `text` left null.
- Cap tool input at 2,000 characters, output at 6,000, each path at 512, and each path list at 50. Strip controls, call `redactSecretsInText()`, and set `clipped` when any cap applies.
- Add `Store.insertMessageBefore(threadId, targetId, message)`, reparenting only `targetId`; siblings must remain on their original parent.
- Add `Store.modelContext(threadId)` and `Store.insertCompaction(...)` with active-path adjacency and digest revalidation.

- [ ] Write Store tests for no compaction, one/repeated compaction, restart from SQLite, rewind before divider, alternate sibling branches, malformed boundary IDs, changed path during summary generation, and full visible-history preservation.
- [ ] Write sanitizer tests for secrets, controls, oversized output, path caps, and idempotence.
- [ ] Make `planCompaction()` fold complete semantic units and retain at least six recent user/assistant exchanges.
- [ ] Make `buildCompactionPrompt()` preserve the spec's continuity facts while treating its input as untrusted.
- [ ] On empty/error/stale summary, use bounded ephemeral projection and write nothing.
- [ ] Assert `searchMessages()` never returns a `compaction` row for a query matching summary text.
- [ ] Render an expandable divider in individual and group chats; old messages remain visible above it.
- [ ] Make every renderer path treat an unrecognized `Message.kind` as "render nothing" rather
      than throw, so a user who downgrades to a build without `compaction` can still open the
      thread. Test with a synthetic unknown kind, not only with `compaction`.
- [ ] Run:

  ```sh
  pnpm vitest run server/store.test.ts server/context/compact.test.ts server/context/sanitize.test.ts server/thread-events.test.ts
  pnpm typecheck
  pnpm lint
  ```

- [ ] Commit: `feat: preserve portable tool context and branch compactions`.

---

### Task 5: Centralize context preparation at dispatch

**Files:**

- Create: `server/context/service.ts`
- Create: `server/context/service.test.ts`
- Modify: `server/index.ts`
- Modify: `server/turn-context.ts`
- Modify: `server/turn-context.test.ts`
- Modify: `server/drivers/openai-chat.ts`
- Modify: `server/drivers/openai-chat.test.ts`
- Modify: `server/workspace.ts`
- Modify: `server/workspace.test.ts`

**Dispatch order:** current user message → persona/integration/memory sections → target model limits → active-branch projection → optional compaction → resume/replay decision → one `TurnContextPlan` → `sendTurn()`.

- [ ] Activate the Task 1 no-fixed-count todo.
- [ ] Replace the `.filter(...).slice(-40)` block in `server/index.ts` with `ContextService.prepareTurn()`.
- [ ] Keep persona/system construction at one boundary and never duplicate it in history.
- [ ] Move current `memorySystemPrompt()` output into a named budgeted context section without changing `MEMORY.md` storage or the separate memory plans. Record included bytes/tokens and clipping in diagnostics.
- [ ] Convert `buildTurnContext()` into a compatibility renderer over the plan, or remove it when its callers are migrated. Keep `engineIsFresh()` as the ownership-independent invalidation rule.
- [ ] Make `openai-chat.ts` consume `context.messages`; compatibility fallback may remain only for callers without a plan during this task.
- [ ] Activate the Task 1 duplicate-history todo: an `omb-replay` engine receives history in
      `context.messages` only, never additionally inlined into the prompt. Assert one copy for
      `openai-compat` and `minimax`, not just for `grok`.
- [ ] Route direct chat, routines, delegations/external updates, queue drains, replies, and
      edited messages through the same service.
- [ ] Rooms and groups are net-new plumbing, not a substitution. The room dispatch path in
      `server/index.ts` currently passes neither `transcript` nor `resumeCursor`, so those bots
      rely entirely on the native session. Give them a plan too, and decide the multi-speaker
      projection rule explicitly: several bots plus the user share one branch, so each assistant
      item keeps its speaker attribution instead of collapsing into one `assistant` role. Test a
      room where two bots alternate and a third joins mid-thread.
- [ ] Verify current user text appears once and invalidation markers clear only after accepted dispatch.
- [ ] Run:

  ```sh
  pnpm vitest run server/context server/turn-context.test.ts server/index.test.ts server/drivers/openai-chat.test.ts server/workspace.test.ts server/room-cwd.test.ts server/room-turn-timeout.test.ts server/delegations.test.ts
  pnpm typecheck
  pnpm lint
  ```

- [ ] Commit: `feat: prepare canonical context for every dispatch path`.

---

### Task 6: Recover safely from invalid native sessions

**Files:**

- Create: `server/context/resume-recovery.ts`
- Create: `server/context/resume-recovery.test.ts`
- Modify: `server/drivers/claude.ts`
- Modify: `server/drivers/claude.test.ts`
- Modify: `server/drivers/codex.ts`
- Modify: `server/drivers/codex.test.ts`
- Modify: `server/drivers/pi.ts`
- Modify: `server/drivers/pi.test.ts`
- Modify: `server/drivers/acp/core.ts`
- Modify: `server/drivers/acp/core.test.ts`

- [ ] Implement `classifyResumeFailure()` returning `before-accept`, `after-accept`, or `unknown`.
- [ ] Permit exactly one fresh-session retry with `replayPrompt` only for `before-accept`.
- [ ] For `after-accept`/`unknown`, fail visibly and never resend automatically.
- [ ] Add fixtures for Claude resume rejection, Codex `thread/resume`, Pi `switch_session`, and ACP `session/load` before prompt submission.
- [ ] Add a negative test per driver proving a post-acceptance failure sends no second prompt.
- [ ] Clear only the failed instance cursor unless an actual rewind invalidates all cursors.
- [ ] Verify the replay contains the current prompt exactly once.
- [ ] Run:

  ```sh
  pnpm vitest run server/context/resume-recovery.test.ts server/drivers/claude.test.ts server/drivers/codex.test.ts server/drivers/pi.test.ts server/drivers/acp/core.test.ts
  pnpm typecheck
  pnpm lint
  ```

- [ ] Commit: `fix: rebuild context when a native session cannot resume`.

---

### Task 7: Expose context diagnostics and ownership

**Files:**

- Create: `src/lib/context-label.ts`
- Create: `src/lib/context-label.test.ts`
- Modify: `server/contracts.ts`
- Modify: `server/thread-events.ts`
- Modify: `server/context/service.ts`
- Modify: `server/index.ts`
- Modify: `src/state/store.tsx`
- Modify: `src/lib/inspector.ts`
- Modify: `src/lib/inspector.test.ts`
- Modify: `src/components/InspectorPanel.tsx`
- Modify: `src/components/ModelPicker.tsx`
- Modify: `src/components/EnginesSettings.tsx`

- [ ] Add metadata-only `context.prepared`: ownership, mode, source/sent counts, estimated tokens, history budget, `limitsSource`, compacted/clipped flags, bounded fingerprint.
- [ ] Adding a `RuntimeEvent` variant touches every exhaustive switch over the union. Sweep them
      in this task rather than leaving a default branch that silently swallows the new event.
- [ ] Validate finite non-negative integers and enums in persisted thread-event parsing.
- [ ] Emit it once per accepted plan before `turn.started`; include no source content, summaries, paths, memory, tools, or secrets.
- [ ] Render a concise inspector row and ownership labels: `Vendor session`, `OpenMaus replay`, `OpenMaus managed`.
- [ ] Test serialized diagnostics against prompt/tool/API-key secret fixtures.
- [ ] Run:

  ```sh
  pnpm vitest run server/thread-events.test.ts server/context/service.test.ts src/lib/inspector.test.ts src/lib/context-label.test.ts server/index.test.ts
  pnpm typecheck
  pnpm lint
  ```

- [ ] Commit: `feat: show who owns each model context`.

**Review gate:** Tasks 1–7 are independently releasable and materially fix context/compaction continuity for all current engines. Review and merge this release before starting the embedded loop.

---

### Task 8: Add the embedded model loop behind an internal adapter

**Files:**

- Create: `server/runtime/contracts.ts`
- Create: `server/runtime/pi-runtime.ts`
- Create: `server/runtime/pi-runtime.test.ts`
- Create: `server/runtime/fake-model.ts`
- Create: `server/drivers/openmaus-runtime.ts`
- Create: `server/drivers/openmaus-runtime.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `server/drivers/builtIn.ts`
- Modify: `server/config.ts`
- Modify: `server/config.test.ts`

- [ ] Lock exact resolved dependencies:

  ```sh
  pnpm add -E @earendil-works/pi-agent-core @earendil-works/pi-ai @modelcontextprotocol/sdk
  ```

  None of the three are currently in `package.json`. This is an Electron-packaged desktop app, so
  three new runtime dependencies change what `build:server` bundles and what ships in the
  installer. Record the resolved versions, the licenses, and the bundle-size delta in the commit
  message, and run `pnpm build:server && pnpm test:packaged-server` before the task commit — not
  only in Task 11.

- [ ] Define concrete internal `OwnedAgentRuntime` inputs/events; keep all Pi imports inside `pi-runtime.ts`.
- [ ] Create a deterministic fake streaming model covering text, reasoning, one/multiple tool calls, cancellation, provider error, and usage.
- [ ] Adapt `TurnContextPlan.messages` to Pi model messages. Keep native tool-call/result pairs only in live state and use portable observations after restart.
- [ ] Register `openmaus-runtime` as disabled-by-default with `contextOwnership: "omb-loop"`, `queueing: true`, and no MCP capabilities until Task 9 proves them.
- [ ] Reuse the current OpenAI-compatible URL, model, catalog, key contract, and OpenRouter routing. Keep the existing `openai-compat` driver unchanged as the control/rollback path.
- [ ] Implement text-only streaming, reasoning, usage, interruption, cleanup, restart without native state, and context transformation before every call.
- [ ] Run:

  ```sh
  pnpm vitest run server/runtime/pi-runtime.test.ts server/drivers/openmaus-runtime.test.ts server/config.test.ts server/harness/registry.test.ts
  pnpm typecheck
  pnpm lint
  ```

- [ ] Commit: `feat: add preview OpenMaus-owned model runtime`.

---

### Task 9: Mount MCP tools, approvals, steering, and loop limits

**Files:**

- Create: `server/runtime/mcp-tools.ts`
- Create: `server/runtime/mcp-tools.test.ts`
- Create: `server/runtime/approval-gate.ts`
- Create: `server/runtime/approval-gate.test.ts`
- Create: `server/runtime/loop-guard.ts`
- Create: `server/runtime/loop-guard.test.ts`
- Modify: `server/runtime/pi-runtime.ts`
- Modify: `server/drivers/openmaus-runtime.ts`
- Modify: `server/drivers/openmaus-runtime.test.ts`
- Modify: `server/contracts.ts`
- Modify: `server/index.ts`

- [ ] Connect normalized `SendTurnInput.integrations` via official MCP stdio transport: initialize, list tools, call tool, cancel, close.
- [ ] Namespace tools by integration server and preserve a reverse routing map.
- [ ] Bound model-visible tool results separately from smaller durable `ToolContextSnapshot`s.
- [ ] Test startup, discovery, name collisions, success/error results, malformed frames, timeout, cancellation, child exit, concurrency, and cleanup.
- [ ] Route permissions/questions through existing `request.opened`, `respondToRequest`, `request.resolved`, and decision audit. Test allow-once, deny, answer, timeout, lost answerer, turn end, and cancel; fail closed.
- [ ] Implement steering before the next model call and test no-live-turn fallback.
- [ ] Enforce 32 model calls, 64 tool calls, 180-second default tool timeout, advisory at three identical calls in a six-call window, and stop at five identical calls. The existing total-turn watchdog wins if earlier.
- [ ] Advertise each MCP capability only after its integration test passes.
- [ ] Run:

  ```sh
  pnpm vitest run server/runtime server/drivers/openmaus-runtime.test.ts server/index.test.ts server/harness
  pnpm typecheck
  pnpm lint
  ```

- [ ] Commit: `feat: run OpenMaus tools inside the owned agent loop`.

---

### Task 10: Add secure preview setup and explicit auth disclosure

**Files:**

- Modify: `electron/workspace-credentials.mjs`
- Modify: `electron/workspace-credentials.test.mjs`
- Modify: `electron/main.mjs`
- Modify: `server/config.ts`
- Modify: `server/config.test.ts`
- Modify: `src/state/store.tsx`
- Modify: `src/components/ApiKeys.tsx`
- Modify: `src/components/EngineSetup.tsx`
- Modify: `src/components/EngineSetup.test.ts`
- Modify: `src/components/ModelPicker.tsx`
- Modify: `src/components/EnginesSettings.tsx`
- Modify: `docs/custom-engines.md`
- Modify: `docs/verification/engines.md`

- [ ] Add `{ section: "openaiCompat", field: "key", name: "openaiCompatApiKey", env: "OPENAI_COMPAT_API_KEY" }` to `WORKSPACE_CREDENTIALS`. Test plaintext migration into `credentials.bin`, blank tombstones, env injection, idempotence, and failure rollback.
- [ ] Add `features.ownedRuntime`, default false for existing installations. Disabled means unavailable without deleting transcript data.
- [ ] Permit no-key endpoints only for loopback/private local hosts under existing URL policy; remote endpoints require a configured key.
- [ ] Show separate labels for authentication/billing and context ownership.
- [ ] State explicitly that OpenMaus Runtime does not reuse Claude/Codex subscription login and may incur provider API charges.
- [ ] Do not auto-migrate `openai-compat` bots. Switching to/from the preview is an explicit per-bot engine selection.
- [ ] Verify keys never enter config responses, renderer state, diagnostics, analytics, or logs.
- [ ] Run targeted config, Electron credential, setup, engine/model-picker, and secret-redaction tests, then:

  ```sh
  pnpm typecheck
  pnpm lint
  ```

- [ ] Commit: `feat: expose OpenMaus Runtime as an explicit preview engine`.

---

### Task 11: End-to-end acceptance in the isolated harness

**Files:**

- Modify: `scripts/control-omb.ts`
- Modify: `scripts/control-omb.test.ts`
- Modify: `docs/verification/chat-turns.md`
- Modify: `docs/verification/README.md`
- Create: `docs/verification/context-runtime.md`
- Add fixture support only under existing testing helpers; no live credentials.

- [ ] Add a fake vendor engine that records context-plan metadata and can reject resume before acceptance.
- [ ] Add loopback-only fake OpenAI-compatible streaming and MCP servers for owned-runtime verification.
- [ ] Drive and retain evidence for:

  1. More than 40 short turns when budget permits.
  2. Vendor-to-replay switch preserving old instructions/tool observations.
  3. Rewind excluding the abandoned branch.
  4. External/delegated updates entering the next plan.
  5. Forced small window creating a divider while old history stays retrievable.
  6. Safe resume failure retrying once; post-acceptance failure never retrying.
  7. Owned runtime executing two tools, requesting permission, accepting steering, and answering.
  8. Process restart losing live state but continuing from transcript/summary.
  9. No prompt, memory, tool secret, API key, or unbounded output in diagnostics/persistence.
  10. An `openai-compat` bot on a rewound thread receives the branch exactly once.
  11. A room thread with three bots keeps per-speaker attribution across an engine switch.

- [ ] Run:

  ```sh
  pnpm typecheck
  pnpm lint
  pnpm test
  pnpm build
  pnpm test:packaged-server
  ```

- [ ] Launch exactly as `docs/verification/README.md` requires:

  ```sh
  node --experimental-strip-types scripts/control-omb.ts launch
  ```

  Use the printed explicit URL in a second terminal for `doctor`, context scenarios, `wait`, and `messages`. Save JSON evidence and the log path; interrupt only that launcher for cleanup.

- [ ] Manually verify ownership labels, preview disclosure, compaction divider, inspector row, engine switch/rollback, approval, interrupt, and steering in a rebuilt renderer. Keep this evidence separate from server-harness evidence.
- [ ] Commit: `test: verify portable context and owned runtime`.

---

## Release gates

Tasks 1–7 ship as the context-control release. Tasks 8–11 remain preview-only until all pass together.

Do not enable the preview by default until there is no duplicate-prompt recovery case and no
duplicate-history dispatch case; MCP children stop on cancel/dispose; approval loss fails closed; restart continuity works without live state; context/tool bounds survive adversarial tests; credential scans are clean; and the isolated recipe is reproducible by a second implementer.

## Execution handoff

Implement and review Tasks 1–7 first. At that point the original continuity/compaction concern is fixed across current engines even though CLI engines still own their live inner loop. Implement Tasks 8–11 as a separate reviewed release adding the optional fully owned loop.

