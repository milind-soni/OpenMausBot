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
- **Use Node 24.** `package.json` requires `>=24`; the shell defaults to 22.x, but 24 is already
  installed at `~/.nvm/versions/node/v24.14.1/bin`. This is not cosmetic: on Node 22 the whole
  `electron/server-boot-probe.node-test.mjs` suite reports 10 cancelled subtests
  ("Promise resolution is still pending but the event loop has already resolved") and `pnpm test`
  exits non-zero, which reads exactly like a regression you just caused. On Node 24 the same
  suite is 90/90. Prefix with
  `export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"` before any `pnpm test` or
  `pnpm test:electron`.

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
- [ ] Make `contextOwnership` REQUIRED rather than optional, and let the compiler enumerate the
      declaration sites (there are eight, including the fake driver). An optional field with a
      default reintroduces exactly the silent-default bug this task exists to remove.
- [ ] Consume the capability at the dispatch site in the same task: replace
      `replaysNatively: instance.driverKind === "grok"` with
      `ownership: instance.adapter.capabilities.contextOwnership`. Declaring ownership without
      reading it leaves the duplicate-history defect live across a commit boundary for no gain,
      so the Task 1 duplicate-history `it.todo` activates here rather than in Task 5.
- [ ] Give the fake driver an ownership override and add exhaustiveness tests.
- [ ] Run:

  ```sh
  pnpm vitest run server/context/types.test.ts server/harness/registry.test.ts server/drivers
  pnpm typecheck
  pnpm lint
  ```

- [ ] Commit: `fix: declare engine context ownership and stop double-replaying history`.

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

### Task 4a: Persistence primitives for mid-branch inserts

**Files:** `server/message-db.ts`, `server/store.ts`, `server/context/insert-position.test.ts`

No new message kind. Pure storage work, independently valuable: it fixes a live restart bug.

- [ ] `insertMessageAfter` persists through `mdb.appendMessage()`, which also writes
      `thread_state.active_leaf_id`. A message threaded in behind the leaf is not the branch
      head, so the next launch walks a path that stops at it and hides everything after. Prove
      it with a restart test first.
- [ ] Add `mdb.insertMessageWithReparent()`: insert plus reparent in one `BEGIN IMMEDIATE`,
      leaving `thread_state` alone. Split across writes, a crash orphans the rows being
      reparented.
- [ ] Add `Store.insertMessageBefore(threadId, targetId, message)`: the new message takes the
      target's parent and ONLY the target moves onto it. Siblings keep their parent, so the
      insert stays branch-local. `insertMessageAfter` sweeps up every child, which would drag
      abandoned forks onto a divider.
- [ ] Commit: `fix: keep the branch head off mid-branch inserts`.

---

### Task 4b: Durable context types and the tool sanitizer

**Files:** `server/store.ts`, `server/context/sanitize.ts`, `server/context/durable-context.test.ts`,
`src/state/store.tsx`, `src/lib/taskTimeline.ts`, `src/components/ChatView.tsx`

- [ ] Add message kind `compaction` and `CompactionRecord` to the `Message` union in
      `server/store.ts` — NOT `server/contracts.ts`, which does not declare `Message`.
- [ ] Add optional `context: ToolContextSnapshot` to `Message.tool`.
- [ ] Store the summary in `compaction.summary` with `text` left null. `searchMessages()` is
      scoped to `kind = 'text'` and `kind = 'activity'`, so this is what keeps summaries out of
      search — assert it rather than assuming it, because it is one careless `text:` away from
      breaking.
- [ ] `sanitizeToolObservation()`: redact, strip controls, then cap — in that order. Capping
      first lets a secret survive by being cut in half; redacting after stripping misses a
      credential with a control character inside it. Must be idempotent.
- [ ] Mirror both types into the renderer by hand. `src/` cannot import from `server/` — the two
      builds use different module resolution — and every kind union has to move together:
      `src/state/store.tsx`, `src/lib/taskTimeline.ts`.
- [ ] Handle `compaction` explicitly in ChatView's kind switch. Its `default` renders a `Bubble`,
      so an unhandled kind becomes an empty bubble rather than nothing. Test with a synthetic
      unknown kind too: these rows are written once and read forever, including by a build the
      user downgraded to.
- [ ] Commit: `feat: add durable compaction records and bounded tool observations`.

---

### Task 4c: Compaction planner — BLOCKED ON TASK 3

Needs `ContextBudget` to know a projection has outgrown the window.

- [ ] `planCompaction()` folds complete semantic units and retains at least six recent
      user/assistant exchanges.
- [ ] `buildCompactionPrompt()` preserves the spec's continuity facts while treating its input as
      untrusted.
- [ ] Revalidate the active-path digest after summary generation; on a changed path, empty
      summary, or error, use a bounded ephemeral projection and write nothing.
- [ ] `Store.modelContext(threadId)` and `Store.insertCompaction(...)` over 4a's primitives.
- [ ] Store tests: no compaction, one and repeated compactions, restart from SQLite, rewind
      before a divider, alternate sibling branches, malformed boundary ids, changed path during
      generation, full visible-history preservation.

---

### Task 4d: Divider rendering — BLOCKED ON TASK 4c

Nothing produces a record until 4c lands; building the UI first is dead code.

- [ ] `src/components/CompactionDivider.tsx`, expandable, in individual and group chats.
- [ ] Old messages remain visible above it.

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
- [ ] **Codex is not a missing-recovery case, it is a silent data-loss bug.** When
      `thread/resume` fails, `codex.ts` catches the error, quietly starts a fresh thread via
      `thread/start`, and sends only the current message. The harness records a normal turn; the
      user sees a bot that forgot the entire conversation, with nothing in the log saying why.
      Fixed by sending `context.replayPrompt` to the fresh thread. Verified by reverting the fix
      and watching the driver test fail.
- [ ] Each remaining driver needs its own protocol reading, not a shared assumption. Claude's
      `--resume` fails VISIBLY rather than silently recovering, so it has no equivalent bug —
      only a missing recovery. Check Pi's `switch_session` and ACP's `session/load` for which
      shape they are before wiring.
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

**Task 7 is a prerequisite for verifying this release, not observability polish.** Driving the
isolated fixture (`docs/verification/README.md`) after Task 5 proves the chat workflow still
works end to end — 46 turns sent, settled, and read back with zero errors in the server log —
but its mapped commands report no context metadata, so they cannot show how much history
actually reached the engine. The headline claim of this release ("more than 40 turns when the
budget permits") is therefore unverifiable through the shared control surface until
`context.prepared` exists. Build Task 7 before attempting Task 11's acceptance evidence, and add
the `context.prepared` fields to a mapped command so the claim can be proven rather than
asserted.

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

  **Resolved 2026-09-04:** `@earendil-works/pi-agent-core@0.85.0`, `@earendil-works/pi-ai@0.85.0`,
  `@modelcontextprotocol/sdk@1.30.0`, all MIT. `scripts/bundle-server.mjs` has no `external`
  list, so esbuild inlines whatever is imported. Importing `@earendil-works/pi-ai/compat` took
  `dist-server/index.js` from **2,199,143 to 6,442,198 bytes (+4.2 MB, 2.9x)** because `compat`
  re-exports every provider pi ships. Importing the one provider this engine speaks —
  `@earendil-works/pi-ai/api/openai-completions` — lands at **3,173,475 bytes (+0.97 MB, +44%)**.
  Rule: import the provider subpath, never `/compat`; a future reviewer seeing `/compat` in
  `pi-runtime.ts` should treat it as a 3 MB regression.

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

  **Resolved 2026-09-04 (Task 9 shipped):** `customMcp` is advertised — the user's own
  `config.json` servers mount as namespaced tools (`server__tool`) with a reverse routing map,
  proven by `server/runtime/mcp-tools.test.ts` against a real stdio child in every failure mode
  the fake supports. `agentsMcp`, `computerMcp`, `composioMcp`, `phoneMcp`, and `browserMcp`
  stay unadvertised: each needs its own proof before a bot is told it has that tool.

  Two findings worth more than the checklist:

  - **Silence is a deny, and it broke the right tests.** Wiring the approval gate made every
    one of Task 8's tool-call tests time out — they assumed a tool runs unprompted, and now
    nothing runs without an answer. The tests were changed to play the harness's auto-approve;
    the runtime was not. A future test that "just calls a tool" and hangs is hitting this
    property, not a bug.
  - **The MCP SDK silently drops a malformed `tools/list` reply.** A server that answers the
    handshake and then speaks garbage does not error; the client simply waits. Only
    `MCP_STARTUP_TIMEOUT_MS` (20 s) returns the turn, so that constant is load-bearing. Tests
    shorten it through `mcpStartupTimeoutMs`; production must not.
  - **The MCP SDK's stdio transport broke the packaged build, and only the packaged smoke
    caught it.** `cross-spawn@7.0.6` (pulled in by `StdioClientTransport`) calls
    `require("child_process")` at load time; esbuild's ESM output has no `require`, so
    `dist-server/index.js` threw on boot while vitest and Electron dev — both unbundled — were
    green. Fixed with a `createRequire` banner on both server builds in
    `scripts/bundle-server.mjs`. `child_process` is a builtin, so the shim resolves it with no
    `node_modules` in reach and the packaged server stays self-contained. Bundle after Task 9:
    **3,599,073 bytes** (+425 KB over Task 8 for the MCP client; the require shim is 122 bytes). Keep running
    `pnpm test:packaged-server` before every task commit; nothing else exercises the bundle.
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

  **Resolved 2026-09-04 (Task 10 shipped):**
  - The credential is `openaiCompatApiKey`, one row in `WORKSPACE_CREDENTIALS`, one entry in
    `main.mjs`'s `CREDENTIAL_PATCH`, one literal in the `setCredential` union. The server side
    (`syncCredentialEnv`) already handled `openaiCompat.key`; only Electron and the renderer
    were missing. The renderer sees `openaiCompat: { configured }` — a boolean, never the key.
  - No-key endpoints are allowed only for loopback and private-network hosts
    (`server/drivers/local-endpoint.ts`): `127.0.0.1`, `localhost`, `*.localhost`, `[::1]`,
    RFC 1918, link-local, and IPv6 ULA/link-local. An unparseable URL is treated as remote — the
    safe side. A remote URL with no key is unavailable with a reason that names the rule.
  - `features.ownedRuntime` is a Settings → Experimental switch. Off means absent from the
    fleet; a bot that chose it sees an unavailable engine and keeps every transcript. Nothing
    migrates an existing bot.
  - The disclosure lives once, in `src/lib/context-label.ts` (`OWNED_RUNTIME_DISCLOSURE`), and
    the settings toggle, engine row, model menu, and setup card all render from it, so three
    surfaces cannot drift into three promises. `contextLabel()` and `authLabel()` are kept
    deliberately separate: who owns the context is not how it is paid for, and this engine is
    the case where they differ.
  - `registry.describe()` now projects `contextOwnership`, so the UI can label every engine,
    not only this one.
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

  **Resolved 2026-09-04 (Task 11 shipped), and precise about what proved what:**

  Driven through the shared control surface (`docs/verification/context-runtime.md`):
  1. more than 40 turns — 151 items on a 200k window (Task 7 evidence);
  3. rewind excluding the abandoned branch — `omb edit` (#760);
  5. a small window creating a divider with history intact — `OMB_CONTEXT_WINDOW` + `edit`;
  7. the owned runtime calling a tool, asking, and being interruptible — `OMB_VERIFY_OWNED=1`
     with `set-model`: `request.opened` for `notes__read_notes`, an "Approval needed" card,
     `needs-user`, then `interrupt` draining the ask as a system deny;
  8. restart without native state — a second turn carried `sent=3/3` from the plan alone;
  9. no key or tool output in diagnostics — canary `verify-key-canary-0000` absent from the
     whole event log, no tool output in any `context.prepared` line.

  Proven by tests, not the fixture — and the plan should say so rather than imply otherwise:
  2. vendor-to-replay switch preserving tool observations — `prepare-turn.test.ts`,
     `replay-once.test.ts`;
  4. external/delegated updates entering the next plan — `prepare-turn.test.ts`;
  6. one safe resume retry, never after acceptance — `codex/claude/pi/acp` driver tests;
  10. `openai-compat` receiving history once — `replay-once.test.ts`;
  11. room attribution across an engine switch — `rebuild.test.ts`.
  Approval allow/deny/timeout and steering on the owned runtime — `pi-runtime.test.ts`,
  `approval-gate.test.ts`. The control surface deliberately has no `approve` command, so
  `needs-user` is the fixture's proof that a call asked and blocked.

  Two gaps in the shared surface found on the way, left as they are:
  - `registry.describe()` does not project `customMcp`, and `list_available_models` projects
    only `snapshot.state`, so `omb models` shows neither `customMcp` nor `billing`. Both are
    pre-existing projections; adding them is a small follow-up, not part of this release.
  - `FAKE_OPENAI_TOOL` exists because a tool call to a name the loop has not mounted is
    reported as unknown BEFORE the approval gate runs — which proves nothing. Point the fake
    at the mounted, namespaced name or the scenario silently degrades.

---

## Release gates

Tasks 1–7 ship as the context-control release. Tasks 8–11 remain preview-only until all pass together.

Do not enable the preview by default until there is no duplicate-prompt recovery case and no
duplicate-history dispatch case; MCP children stop on cancel/dispose; approval loss fails closed; restart continuity works without live state; context/tool bounds survive adversarial tests; credential scans are clean; and the isolated recipe is reproducible by a second implementer.

## Execution handoff

Implement and review Tasks 1–7 first. At that point the original continuity/compaction concern is fixed across current engines even though CLI engines still own their live inner loop. Implement Tasks 8–11 as a separate reviewed release adding the optional fully owned loop.

