# OpenMausBot harness implementation plan

- Status: proposed
- Last repo review: 2026-08-17
- Tracking artifact: the pull request that adds this document

## Summary

Seventeen changes to `server/` and `src/`, ordered into three rounds, plus a
deferred list. No external agent harness is adopted as a dependency.

This plan replaces an earlier draft that was built by reading other harnesses
(pi, agent-orchestrator, deepseek-harness) and asking what OpenMausBot lacked by
comparison. That produced a good map of what is *possible* and a poor map of what
is actually *missing*. The items below come from reading this repository. Their
designs still borrow from those projects where the design work is genuinely good,
and the verified facts are retained in [Upstream references](#upstream-references).

**The reframe that reorders everything.** OpenMausBot is itself a harness. The
agent CLIs' own session files are an *optimization* — a per-engine cache that
happens to hold context for one engine on one machine. The canonical, durable,
cross-engine record is `server/store.ts`. Every path where that record has to
become model context is therefore load-bearing, and today every one of them is
capped at 40 text messages or broken outright.

Round 1 fixes things users hit. Round 2 gives the harness guarantees it currently
lacks. Round 3 is work unlocked by the first two.

## Verified findings

Everything below was checked against the repository on 2026-08-17. Line numbers
drift as `server/index.ts` grows; the symbol names are the stable reference.

**Context reconstruction is capped or absent.**

- `server/index.ts:806` builds the model-facing transcript as
  `activePath(threadId)` filtered to `kind === "text"`, then `.slice(-40)`.
- Only `server/drivers/grok.ts` reads `SendTurnInput.transcript`. CLI and ACP
  drivers resume through their own native sessions.
- `server/index.ts:817` builds an inline replay for non-grok drivers **only**
  when `rewound` is set.
- `rewound: true` is set in exactly two places — `server/index.ts:2058` and
  `:2075` — both branch/edit handlers.
- `resumeCursors` is `Record<instanceId, cursor>` (`server/store.ts:117`), read
  at `server/index.ts:979` as `rewound ? undefined : task.resumeCursors[instanceId]`.
- **Consequence:** switching a bot's model mid-thread finds no cursor for the new
  instance, does not set `rewound`, and is not grok — so the new engine receives
  the latest message and nothing else. The advertised "switch a bot's model
  mid-conversation" silently discards the conversation.
- **Second consequence:** the replay filter is text-only, so every tool call and
  result is dropped. A rebuilt context shows people talking with no evidence of
  work performed.

**Input is text-only.**

- `SendTurnInput` carries `text: string` and no image or file field.
- Message kinds are `"text" | "options" | "activity" | "screen"`
  (`server/store.ts:53`); `screen` is the bot's own screenshot output.
- Bots can send the user images. The user cannot send one back.

**The main conversation path has no retry.**

- Zero occurrences of retry in `server/drivers/claude.ts`, `codex.ts`, `grok.ts`.
- Retry exists in `server/box.ts`, `server/computer-proxy.ts`,
  `server/drivers/acp/core.ts`, `server/webhooks.ts`, `server/drivers/antigravity.ts`.
- The peripheral systems are resilient; the conversation path is not.

**No liveness, and one coarse state.**

- `busy?: boolean` (`server/store.ts:175`) is the entire runtime state model.
- `server/index.ts:1022` clears it at turn end; `server/index.ts:1296` clears it
  for every bot on startup — the workaround for a driver dying silently.
- 221 references to `busy` across 36 files, 10 of them tests.

**Two independent write paths.**

- `writeFileAtomic(BOTS_FILE, ...)` at `server/store.ts:360` and
  `EventBus.publish` at `server/harness/bus.ts:32`.
- `server/index.ts` contains 139 `store.` calls and 39 `broadcast(` calls.

**Automation is gated but not durable.**

- `botState` returns `"ready" | "busy" | "missing"` (`server/index.ts:1036`,
  `:1065`); routines and webhooks share one queued executor
  (`server/index.ts:1060`); peer `ask_bot` paths return `{ busy: true }`
  (`server/index.ts:1432`, `:1475`). There is no missing gate.
- `server/delegations.ts:31` states the delegation queue is *"Persisted nowhere —
  a server restart drops delegations"*. Routines and webhooks have durable
  receipts; delegations do not.

**Approvals answer in prose.**

- The unanswered-request path (`server/drivers/claude.ts:122`) sends the model a
  natural-language instruction to skip the action. It is fail-closed in intent
  but is not a typed outcome a caller can branch on.
- `request.opened` carries `tool` and `summary` as its own copy of information
  already streamed as a tool item; the two can drift.

**Already present — do not rebuild.**

- Message tree: `parentId` (`server/store.ts:69`), `activePath` (`:480`),
  `branchMessage` (`:519`), `activeLeafId`.
- A working version switcher in the UI: `ChatView.tsx:388-403` renders `1/3`
  with previous/next arrows, backed by `switchBranch` and an `/active-branch`
  endpoint. Branches are discoverable and reachable.
- Ports and adapters: `server/contracts.ts` is the port interface,
  `server/drivers/` are the adapters, unknown drivers degrade to unavailable
  shadow snapshots.
- `RuntimeEventBase.raw` carries the native protocol payload. Nothing surfaces it.
- `ProviderInstance.generateText` (`server/contracts.ts:245`) — the summarization
  seam already exists.
- Cost is populated by all three main drivers and reaches the app on
  `turn.completed.cost` and `thread.token-usage.updated`. The UI discards it.

**Not present anywhere.**

- Cross-thread search.
- Per-call tool deadlines or repeat-call detection.
- `contextWindow` on `ModelCatalog.options` (`server/contracts.ts:223`).

---

# Round 1 — broken or missing

## 1. Fix model-switch context loss

**What.** Switching a bot's engine mid-thread must rebuild context for the new
engine instead of starting it blank.

**Why.** Verified broken, and it is a front-page feature.

**Design.** At dispatch, decide freshness by *who ran the last turn on the
task*, not by whether this instance holds a cursor — a cursor only proves a
session covering some prefix of the thread, and every turn another engine took
since is missing from it. Track `TaskRecord.lastInstanceId` at dispatch and
replay (the same branch `rewound` already takes at `server/index.ts:817`) when
it differs from the selected instance. Tasks from before the field existed fall
back to the cursor map: a lone cursor that is ours keeps resuming, anything
ambiguous replays. Ship this before item 7; a 40-message text replay is better
than no context, and the rebuild path is where item 7 later plugs in.
*(As built in #180: `engineIsFresh()` in `server/turn-context.ts`,
`store.markTaskDispatched()`; the naive missing-cursor rule was tried first and
failed the A → B → A case in manual testing.)*

Keep the rebuild marker distinct from `rewound`. `rewound` means "the visible
branch changed"; this means "this engine has no session here". They coincide
today and will not always.

**Done when.** A thread with history, switched from Claude to Codex, produces a
first reply that demonstrably knows what came before.

## 2. Attachments — user to bot

**What.** Users can send images and files to a bot.

**Why.** `SendTurnInput` is text-only. Bots send screenshots; users cannot send
one back. Every underlying CLI already accepts image input.

**Design.**

- `SendTurnInput.images?: Array<{ mediaType: string; data: string }>` (base64),
  and a `files?` variant if a path-based handoff suits the CLI drivers better.
- A message kind for user attachments alongside `screen`, stored with the
  message and rendered in the transcript.
- Composer: paste, drag-and-drop, and a file button.
- Per-driver encoding — Claude and Codex take images in their stream formats;
  ACP has its own content blocks.
- `capabilities.images?: boolean`. Drivers that cannot take images advertise
  `false`, and the composer disables attachment for those bots rather than
  failing at send time.
- Cap size and count; large files should reference a path rather than inline
  base64 where the driver supports it.

**Done when.** A screenshot pasted into the composer reaches the model on every
driver that advertises support, appears in the transcript, and survives reload.

## 3. Auto-retry in the main drivers

**What.** Bounded retry with backoff on transient failures in `claude.ts`,
`codex.ts`, `grok.ts`.

**Why.** Zero retry today. A 529, a rate limit, or a dropped socket kills the
turn — including turns started by routines and webhooks while nobody is watching.

**Design.**

- Classify transient (429, 5xx, overloaded, connection reset) versus terminal
  (auth, invalid model, quota exhausted). Terminal failures must not retry.
- Exponential backoff with jitter, a small attempt cap, and a hard ceiling.
- Emit a `turn.retrying` runtime event so the UI can show it rather than
  appearing frozen.
- An abort path: the user interrupting during a retry cancels the whole turn.
- Retries must not duplicate a partially streamed assistant message — a retry
  after partial output discards the partial and restarts the turn.

**Done when.** A simulated 529 produces a visible retry and a completed turn
instead of a failed one, and an invalid API key fails immediately without
retrying.

## 4. Cross-thread search

**What.** Search across every bot's messages and activity.

**Why.** A roster of bots, threads that live for weeks, and no way to find
anything.

**Design.**

- Server-side endpoint over the store: query, optional bot filter, optional kind
  filter, paginated results with thread and message ids.
- Start with a linear scan over in-memory messages plus the per-thread NDJSON;
  add an index only if it is measurably too slow.
- Results link to the message, which means selecting the branch that contains it
  — `switchBranch` already does this.
- Search `activity` kinds too, not just text, so "which bot ran that migration"
  is answerable.

**Done when.** A phrase said three weeks ago in a branched thread is findable and
clicking the result lands on it with the right branch selected.

## 5. Cost and usage visibility

**What.** Surface the per-turn and per-bot cost and token data already arriving.

**Why.** The data is on the wire from all three main drivers and thrown away.
An app that runs agents unattended overnight has to show what that spends.

**Design.**

- Per-turn cost on the turn, cumulative per thread, cumulative per bot.
- Distinguish metered from subscription-billed. Claude on Max and Codex on
  ChatGPT Plus report notional cost; showing a dollar figure there is misleading.
  Label the source: "on your subscription" versus an actual amount.
- A per-bot total in the profile, and a fleet total somewhere reachable.

**Done when.** A user can answer "which of my bots is costing me money" without
opening a provider dashboard.

---

# Round 2 — harness guarantees

## 6. Liveness reaper

**What.** Poll live driver processes and derive a lost state.

**Why.** A driver dying without a terminal event leaves the bot `busy` forever;
clearing every bot on startup (`server/index.ts:1296`) is the current recovery.

**Design.**

- A tick over `server/procs.ts` probing each process owning an in-flight turn.
- Process-exit detection at minimum; a protocol-level ping where the transport
  supports one.
- On loss: emit `runtime.error` with a setup-versus-crash distinction, settle the
  turn, and move the bot to a lost state rather than silently idle — a bot that
  died mid-task should say so.
- Startup reconciliation replaces the blanket clear: reconcile each bot against
  observed processes instead of resetting all of them.

**Done when.** Killing a driver process externally surfaces a lost bot within one
tick, and a restart no longer needs to clear state for every bot at once.

## 7. Portable context

**What.** The harness can reconstruct a faithful, size-bounded context for any
engine, at any point in the tree.

**Why.** This is the mechanism behind engine switching, branching, group turns,
and delegation. All of them currently get 40 text messages or nothing.

**The governing rule.** There are two transcripts and only one of them shrinks.
The display path — `store.activePath()`, shipped whole at `server/index.ts:179` —
is already correct, grows without bound, and is not touched. Nothing is ever
deleted from the record. Only the model-facing rebuild is bounded.

**Design, in four parts.**

*7a. Context window in the catalog.* Add optional `contextWindow` and `maxTokens`
to `ModelCatalog.options`. Ten lines, and nothing can size a rebuild without it.

*7b. Replay includes work, not just talk.* The current filter is
`kind === "text"`. Tool activity must be represented in a rebuild or a handed-over
engine has no idea what was done. Render `activity` entries compactly — tool name,
key arguments, outcome — rather than full output.

*7c. Compaction replaces `.slice(-40)`.* A `compaction` message kind carrying
`{ summary, firstKeptId, tokensBefore, at }`, appended with a `parentId` like any
other message, so it lives in the existing tree and removes nothing behind it.
`store.modelContext(threadId, target)` walks `activePath()` back to the most
recent compaction record and returns summary plus messages from `firstKeptId`.

Correctness rules, from pi's implementation: never cut between a tool call and
its result; handle the split-turn case where one turn alone exceeds the keep
budget by generating and merging two summaries; feed the previous summary into
each subsequent summarization; carry read and modified files forward cumulatively.

Summarize through `ProviderInstance.generateText`, which already exists.

*7d. The rebuild is a function of the target.* The same thread may be handed
between an 8k local model and a 200k Claude. One frozen summary cannot serve
both. Treat the summary as a cached **input** to a rebuild sized for the target
model's window, not as the fixed output. Scale the reserve proportionally —
pi's flat 16384 assumes a ~200k window and would leave an 8k model permanently
over the line.

*Measurement.* Anchor on provider-reported usage when the request envelope
matches the last successful call; fall back to a heuristic otherwise. Take that
principle from deepseek-harness's token meter without its full surface-node
machinery.

*Scope.* This governs every path that rebuilds: grok, post-branch replay, item 1's
engine switch, delegation, and group turns. CLI drivers continuing their own
native session are unaffected and keep compacting internally.

*UI.* Emit `thread.compacted`. Render a quiet divider — "Context compacted,
earlier messages are still here" — expandable to the summary. Scrolling above it
shows everything.

**Done when.** A thread of several hundred messages, handed to a different engine,
produces a reply that reflects both the conversation and the work done in it; and
scrolling up still reaches message one.

## 8. Durable delegations

**What.** Bot-to-bot handoffs survive a restart.

**Why.** `server/delegations.ts:31` — persisted nowhere. The stated rationale
holds for permissions, where nobody can answer for an unattended bot. Queued work
is not a permission.

**Design.** Persist the per-thread queue alongside the thread, with the same
durable-receipt treatment routines and webhooks already get. Drain on startup
after the liveness reconciliation in item 6, re-validating the target and the
`approvePeerComms` setting at drain time — the existing code already re-checks at
drain rather than queue time, and that stays.

**Done when.** A delegation queued immediately before a restart runs after it.

## 9. Tool deadlines and loop detection

**What.** A per-call tool deadline and detection of repeated identical calls.

**Why.** Nothing watches a bot looping. That is the user's money.

**Design.**

- A deadline armed per tool call, configurable, with a sane default. On expiry
  the call is terminated and the model told the tool timed out.
- Repeat detection over a sliding window of recent calls keyed on tool name plus
  normalized arguments. First response is advisory — inject a note that the same
  call has been made N times. Escalate to termination only past a hard threshold.
- Both are harness-side so they work for every driver rather than per-CLI.

**Done when.** A tool that hangs is cut off and the turn continues, and a bot
repeating one call is nudged before it repeats it twenty times.

## 10. Tool-result redaction

**What.** Scrub secrets from tool results before they are persisted.

**Why.** Anything a bot reads lands in the transcript and is replayed to the
model on every subsequent turn — and after item 7, into every rebuild too. One
accidental `.env` read becomes permanent.

**Design.** A result-side hook running before the message is written. Reuse the
patterns already in `server/auto-approve.ts` (`SENSITIVE` covers `.env`, ssh keys,
AWS credentials, netrc, npmrc, keychain, service accounts). Replace matches with a
marker that says something was redacted, so behaviour stays explainable. Redact
the stored copy, not just the displayed one.

**Done when.** A bot reading a file containing an API key produces a transcript
with the key removed, and a later turn cannot recover it from context.

## 11. Fail-closed approvals

**What.** A typed, closed approval outcome, and an approval request that does not
duplicate the tool call.

**Why.** The unanswered path currently instructs the model in prose to skip
(`server/drivers/claude.ts:122`). A caller cannot branch on prose.

**Design.**

- Outcome becomes `allowed-once | rejected | cancelled | unavailable`. Callers
  deny on `unavailable`, which is the value for a missing, throwing, or timed-out
  answerer. Taken from deepseek-harness's approval seam.
- `allowed-once` grants only the asked-about action. Broadening stays explicit
  and separate — which is what "Always allow" already is.
- `request.opened` references the streamed tool item by `itemId` rather than
  carrying its own `tool` and `summary`. Two copies can drift; one cannot.
- Touches `respondToRequest` in every driver and the permission-proxy socket
  protocol in `claude.ts`. Land it on its own.

**Done when.** An unanswered request resolves `unavailable` and the action is
denied, with no prose instruction reaching the model.

## 12. Generation fencing

**What.** A monotonic generation per driver instance, stamped on emitted events;
stale events dropped.

**Why.** Events from a superseded driver instance landing on a live turn is rare,
destructive, and nearly unbisectable.

**Design.** Generation assigned in the registry at instance creation, carried on
`RuntimeEventBase`, checked in `server/harness/bus.ts` before fan-out.

**Reconcile with `rewound` rather than stacking on it.** The repo already has one
notion of a stale session; two overlapping notions is how you get a bug neither
catches. Decide whether `rewound` becomes a generation bump or stays separate, and
write the answer down.

**Done when.** Events from a disposed instance cannot reach a client or mutate a
live turn.

## 13. Emit inside the store

**What.** Make `store.appendMessage` and `store.patchBot` emit as part of writing.

**Why.** Two independent write paths mean a caller can persist without emitting
(UI drifts from disk) or emit without persisting (a restart loses what the user
just watched).

**Design.** Put the emit where the write already is. This is deliberately *not*
the universal `commit()` refactor an earlier draft proposed — routing 178 call
sites through a new function in a 2,465-line file is a flag-day change with no
user-visible benefit and nothing to bisect against. Making a handful of store
methods emit internally kills the same bug class.

**Done when.** No mutation path can persist without emitting, and the property is
enforced by construction rather than convention.

## 14. Server-side activity state

**What.** A real runtime state on the bot record, with `busy` retained as a
derived getter.

**Why.** `busy` cannot distinguish working, waiting on the user, lost, and dead —
and item 6 produces a state that has no representation today.

**States.** `working` · `waiting-on-you` · `idle` · `no-signal` · `dead`.

**Design.** Add the field; derive `busy` from it. **Only the harness reads the new
field initially.** There are 221 `busy` references across 36 files including
`Composer.tsx`, `Sidebar.tsx`, `ChatView.tsx`, `CallView.tsx`, `GroupView.tsx`,
`ComputerPanel.tsx`, and 10 test files. Migrating them wholesale risks a
half-migration where the sidebar says idle and the composer says busy. Keep the
shim for a full release, migrate readers incrementally, delete last.

`turn.settled` is not a separate event — settled is a transition into `idle` with
an empty queue.

**Done when.** The harness can distinguish all five states and every existing
`busy` reader still behaves identically.

## 15. Raw event inspector

**What.** A per-thread view of the actual event stream.

**Why.** `RuntimeEventBase.raw` already carries the native protocol payload and
nothing surfaces it. This is the tool you will want while building everything
else in this document.

**Design.** Tool calls with full arguments and outputs, timestamps, driver
generation, and the raw payload behind a toggle. Build it early — it pays for
itself during items 7, 11, and 16.

**Done when.** A misbehaving turn can be diagnosed without adding logging.

---

# Round 3 — unlocked by the first two

## 16. Local models

**What.** One `local` driver covering Ollama, LM Studio, and vLLM.

**Why here.** Not low value — *blocked*. An 8k model without item 7 forgets
everything after a short conversation and looks broken. After item 7 the driver
is nearly free.

**Design.** Start from `server/drivers/grok.ts`, already an OpenAI-shaped SSE
client with transcript replay and `generateText`. Config `{ baseUrl, api }` with
`supportsMultipleInstances: true`, so Ollama (`127.0.0.1:11434`), LM Studio
(`127.0.0.1:1234`), and a custom vLLM endpoint are three instances of one driver.

Detection maps onto the existing CLI vocabulary: `snapshot()` pings the server
and reports unavailable with a reason when refused; `models` comes from
`/v1/models` so only pulled models appear; `refreshModels()` re-fetches without a
restart, falling back to a static list like `server/drivers/acp/opencode-go.ts`;
`EngineInstall.signInCommand` carries `ollama serve` for the installed-but-not-
running case.

Compatibility, learned from pi: send `system` rather than the `developer` role,
and declare no `effortLevels`. Keyless local servers need a placeholder key or
their models stay hidden. Capability flags `computerMcp`, `composioMcp`,
`agentsMcp`, and `images` set honestly — usually `false`.

Add model-free tool-result pruning here rather than in item 7: a filter over the
rebuild that drops stale tool output before any summarization runs. Cheap, no
model call, and it matters most on small windows.

**Done when.** A bot runs on a locally pulled model with no cloud credentials
configured anywhere in the app, and stays coherent past the context window.

## 17. Mid-turn steering

**What.** Deliver a message into a running turn instead of rejecting it.

**Why.** The harness can start and interrupt a turn but cannot feed one. That is
a missing primitive, and it also improves routines and delegations, which
currently only queue behind `busy`.

**The risk, and why this is last.** `server/drivers/claude.ts:536-537` writes the
prompt then immediately calls `stdin.end()`. With `--input-format stream-json`
that close is very likely the CLI's turn-completion signal. Keeping stdin open
may mean turns never end — no `turn.completed`, bot stuck indefinitely.
**Verify the CLI's EOF semantics before designing the queue**, and do not attempt
this before item 6 exists to catch a hung turn.

**Design.**

- `ProviderAdapter.steer(threadId, text)` and `.followUp(threadId, text)`, plus
  `capabilities.queueing?: boolean`.
- Semantics from pi: *steer* is delivered after the current tool batch completes
  and before the next model call; *follow-up* waits until the bot stops. Default
  `one-at-a-time` so a burst of typing does not arrive as one wall.
- A `queue.updated` runtime event carrying both pending queues.
- Replace the 409 at `server/index.ts:755` with a queue where the driver supports
  it; stop locking the composer at `:840`; render queued messages as pending.
- Drivers advertising `queueing: false` keep current behaviour, exactly as
  `computerMcp` already gates the computer panel.
- Generation fencing (item 12) must be in place: a queued message must never be
  delivered into a turn from a superseded generation.

**Done when.** A user types mid-turn, the bot changes course at the next safe
point, and no driver hangs.

---

# Deferred

Kept for the record with the reason each was set aside. Revisit when there is a
reason beyond "another harness has it".

**Shared memory across bots.** The largest surface in any draft of this plan: a
new npm dependency (`mem0ai`, Apache-2.0, with a complete TypeScript OSS
implementation), a native SQLite module across three packaging targets,
embeddings, a scope model, promotion and demotion between tiers, an approval
path, and a Brain panel — plus two model calls per turn. The design, if it
happens: bots never edit a shared block directly; they propose, mem0's
extract-then-reconcile pass (`ADD`/`UPDATE`/`DELETE`/`NONE`) arbitrates, and the
block is a rendered view of the result. That closes the last-writer-wins hole
Letta documents in its own guidance. Scopes would be thread, bot, workspace,
user, with workspace enforced by the harness since mem0 has no org scope.
Deferred because it is a product bet, not a harness improvement, and it is
cost-bearing on every turn.

**Skills as bot personalities.** Passing a directory to drivers that already read
the shared skill locations. Little harness value, and without a curated gallery
of prebuilt personalities it ships a folder picker pointing at nothing. The
gallery is a content project, not an engineering one.

**Spill storage.** Persisting oversized tool output to a session-scoped file and
handing the model a locator. Genuinely good design, but for CLI drivers the tool
runs inside the CLI and the harness never handles the result — there is nothing
to intercept. Only worth it if a future driver executes tools in-process.

**Tree navigation UI.** Labels, filter modes, a full tree view, and clone. The
version switcher at `ChatView.tsx:388-403` already makes branches discoverable
and reachable, so nobody is losing work. Polish over a working feature.

**Remote access groundwork.** Snapshot-authoritative state with a defined resync
(the app currently folds SSE into state, which is safe on loopback and drifts
permanently on a lossy link); session attachment and locking for when two clients
open one bot; authentication on the main API and a configurable bind address.
**These must land before the harness port is exposed beyond loopback, not
after** — if Tailscale moves up, these move with it.

**Decomposing `server/index.ts`.** At ~2,465 lines it mixes routing, dispatch,
store writes, and bus emits. Item 13 touches the worst of it. Not a blocker.

---

## Cross-cutting risks

**`ProviderAdapter` growth versus the one-file promise.** Items 2, 11, and 17 all
add to the adapter contract. The repo's stated invariant — adding a provider is
one file in `server/drivers/` plus one registration — gets harder with each
required method, across eight existing drivers and 82 test files. Capability
flags let drivers opt out of *behaviour*, not out of *implementing the surface*.
Decide deliberately whether the promise survives, and record the answer.

**On-disk forward compatibility.** `~/.openmausbot` is shared across app versions.
New message kinds (attachments, compaction), a new state field, and generation
stamps all mean an older build may read a newer store. There is precedent —
`server/store.ts:443` already migrates a pre-branching flat file — but a
downgrade path needs to be explicit rather than discovered.

**Test surface.** 82 test files. Contract changes in items 2, 11, 14, and 17
ripple through driver tests. Budget migration time; it is where the hours
actually go.

**Two notions of staleness.** `rewound`, `resumeCursors`, and item 12's
generations all encode "this session no longer applies". Unify or clearly
separate them before adding the third.

## Open questions

1. Is `cwd` surfaced per bot from the UI? If a user cannot point a bot at a
   project folder, that belongs in Round 1 and is not currently on this list.
2. Does the Codex app-server protocol accept a user message mid-turn, or should
   the Codex driver advertise `queueing: false`?
3. What exactly terminates a Claude CLI turn under `--input-format stream-json` —
   stdin EOF, or something else? Item 17 depends on the answer.
4. Does Ollama's `/v1/models` expose a usable context window, or does item 7a
   need a bundled table keyed by model family?
5. How should groups rebuild context for a bot that has no native session
   covering the other members' turns? Item 7 must cover this path explicitly.
6. Should compaction summaries use the bot's own model, or a cheaper one when
   configured?
7. What is the right reserve ratio for small windows — is `contextWindow * 0.2`
   correct at 8k, or does it need a floor?
8. Which liveness probe per driver kind — process existence, or a protocol-level
   ping where the transport supports one?

## Upstream references

The projects this plan reads for design, and what was taken from each. Facts
below are the ones the item designs cite; nothing else from these projects is
assumed.

- **pi** — compaction correctness rules (never cut between a tool call and its
  result; split-turn case; feed the previous summary into the next; carry
  read/modified files forward) — item 7. Its flat 16384-token reserve assumes a
  ~200k window — item 7d scales the reserve instead. Local-model compatibility
  (send `system`, not the `developer` role; declare no effort levels) — item 16.
  Steer vs follow-up semantics (steer after the current tool batch, follow-up
  after the turn) — item 17.
- **agent-orchestrator** — read for the general shape of a multi-agent
  harness; no specific design is borrowed.
- **deepseek-harness** — token-meter principle (anchor on provider-reported
  usage when the request envelope matches, heuristic otherwise) — item 7; the
  typed approval seam (`allowed-once | rejected | cancelled | unavailable`) —
  item 11.
- **mem0** (`mem0ai`, Apache-2.0) and **Letta** — the extract-then-reconcile
  memory design and the last-writer-wins caveat — deferred "shared memory".
