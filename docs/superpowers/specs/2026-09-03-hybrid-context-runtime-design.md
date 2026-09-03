# OpenMausBot Hybrid Context Runtime Design

**Status:** Approved direction for implementation planning

**Date:** 2026-09-03

## Goal

Make OpenMausBot the canonical owner of model-facing context, memory projection, and compaction across every engine, then add an optional OpenMaus-owned agent loop for API-key and local-model users. Keep the official Claude, Codex, Pi, Hermes, and ACP adapters for subscription-backed access and vendor-native behavior.

This is an OpenMausBot harness change. It does not depend on or modify OpenMausOS.

## Problem

OpenMausBot already owns the outer harness: bots, threads, branches, rooms, routines, approvals, integrations, transcripts, workspaces, skills, and `MEMORY.md`. Its CLI adapters delegate the inner model loop and normally the live context/compaction policy to an installed vendor harness.

That reuse is valuable, but five gaps are real:

1. A vendor session can contain context OpenMausBot cannot inspect or reproduce exactly.
2. Engine switches, rewinds, external updates, and lost resume cursors require reconstruction from OpenMausBot's state.
3. The current reconstruction in `server/index.ts` keeps only 40 text messages and omits meaningful tool activity.
4. Context size, compaction boundaries, memory inclusion, and why an item was omitted are not observable through one system-wide contract.
5. Which drivers replay history structurally is hardcoded at the dispatch site as
   `replaysNatively: instance.driverKind === "grok"` (`server/index.ts`). `openai-compat` and
   `minimax` run on the same `createOpenAIChatRuntime`, which always prepends
   `SendTurnInput.transcript` ahead of `SendTurnInput.text`. On any rewind, engine switch, or
   external update those bots therefore receive the whole active branch **twice** — once inline
   inside `turnText` and once as structured messages. The property being tested is an engine
   capability, not a driver-kind string.

## Decision

Use a hybrid model with three explicit ownership modes:

| Mode | Context behavior | Loop owner | Engines |
|---|---|---|---|
| `vendor-session` | OpenMaus prepares recovery context; a valid vendor session continues normally | Installed CLI/ACP harness | Claude, Codex, Pi CLI, Hermes, ACP engines |
| `omb-replay` | OpenMaus sends a bounded structured replay each turn | Provider performs one response | Existing API/chat drivers during migration |
| `omb-loop` | OpenMaus rebuilds before every model call | OpenMaus executes model/tool iterations | New OpenMaus Runtime |

Every turn gets one provider-neutral `TurnContextPlan`. A native session is an optimization over the canonical transcript, never the only recoverable copy.

## Non-goals

- Do not remove or silently migrate existing CLI-backed bots.
- Do not extract, imitate, or route vendor subscription credentials through an embedded third-party runtime.
- Do not replace `MEMORY.md` with hosted or vector memory.
- Do not store unbounded raw tool output.
- Do not delete or rewrite full display history during compaction.
- Do not promise identical hidden reasoning or provider cache state after an engine switch.
- Do not duplicate the separate memory browser/review-loop plans; this design only standardizes how approved memory reaches models.

## Canonical context plan

Add a pure projection layer under `server/context/`:

```ts
export type ContextOwnership = "vendor-session" | "omb-replay" | "omb-loop";

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

Room and group threads are multi-speaker: several bots and the user share one branch, and the
projector attributes each assistant item to its speaker rather than flattening every bot into an
undifferentiated `assistant` role. The current room dispatch path passes neither `transcript` nor
`resumeCursor`, so rooms depend entirely on the native session today; giving them a context plan
is net-new plumbing, not a substitution.

`ModelContextItem` contains provider-neutral user text, assistant text, bounded tool observations, and an optional compaction summary. Drivers render these items into their native protocols. Portable tool observations are descriptive historical context, not fabricated provider-native tool messages with fake call IDs.

`SendTurnInput.context` becomes authoritative. The existing `text` and `transcript` fields remain temporarily as compatibility projections during driver migration.

## Token budgeting

Replace `.slice(-40)` with a target-model budget:

```text
history budget = context window
               - system/persona/memory estimate
               - tool-schema estimate
               - output reserve
               - safety reserve
```

- Catalog-declared `contextWindow` and `maxOutputTokens` win.
- A conservative model-pattern table handles engines that cannot declare limits. Today only
  `pi` and `minimax` populate `contextWindow` and no driver populates `maxOutputTokens`, so the
  pattern table is the primary path for nearly every shipped engine, not a rare fallback. It
  must cover every shipped engine's default models.
- `ContextBudget` carries `limitsSource: "catalog" | "pattern" | "default"`. Without it a real
  200k window and a guessed one are indistinguishable in diagnostics, and a silent regression to
  the 32k conservative default looks identical to a correct small model.
- Token estimates are deliberately conservative and are not used for billing. `chars / 3`
  under-counts CJK, Devanagari, and emoji, where a character is frequently one token or more,
  and under-counting overflows the real window into a hard provider error. Estimate as
  `ceil(asciiChars / 3) + nonAsciiChars` so the conservative direction holds for every locale
  the app already ships.
- Projection removes complete semantic units; it never separates an assistant action from its portable tool observation.
- Oversized individual items are explicitly clipped at the context boundary and recorded in diagnostics.

## Durable branch-aware compaction

Add `kind: "compaction"` to the canonical message union:

```ts
interface CompactionRecord {
  schemaVersion: 1;
  summary: string;
  firstKeptId: string;
  throughId: string;
  sourceDigest: string;
  estimatedTokensBefore: number;
  targetContextWindow: number;
  createdByInstanceId: string;
}
```

Add `Store.insertMessageBefore(threadId, targetId, message)`. It inserts the divider before only the selected active-branch child; unlike `insertMessageAfter`, it must not reparent sibling branches. This keeps compaction branch-local.

Durable messages live in `server/message-db.ts` (`node:sqlite`), not only in `Store`'s in-memory
cache, so the divider carries three persistence requirements the in-memory shape does not show:

- **One transaction.** Inserting the divider and reparenting `targetId` are two row mutations
  that must commit together under a single `BEGIN IMMEDIATE`. A crash between them would orphan
  the branch. `insertMessageAfter` today writes the new row and then reparents children through
  separate `patchMessage` calls; the new path must not copy that.
- **No leaf mutation.** `insertMessageAfter` reaches SQLite through `mdb.appendMessage()`, which
  also runs `setActiveLeaf(threadId, full.id)` while leaving the in-memory `activeLeafId`
  untouched — after a restart the thread's active leaf points at the inserted artifact rather
  than the real leaf. A compaction divider is never a leaf, so it must persist through
  `mdb.insertMessage()` and leave `thread_state` alone. Fixing the existing
  `insertMessageAfter` divergence is in scope because the compaction tests exercise the same
  restart path.
- **Not searchable.** `mdb.searchMessages()` runs over the `text` column across every kind. A
  summary written into `text` becomes a full-text search hit whose kind the results UI cannot
  render. Store the summary in the `json` blob with `text` left null, and assert the exclusion.

Renderers must treat an unrecognized `Message.kind` as "render nothing" rather than throw, so a
user who downgrades to a build without `compaction` still opens the thread.

The full display path remains intact. The model projector uses the latest valid compaction record on the active branch plus messages from `firstKeptId` onward. Rewinding before a divider naturally excludes it.

Compaction occurs asynchronously, so insertion revalidates the active-path digest after summary generation. If the path changed, the stale record is not written; the current request uses a bounded ephemeral projection and the next turn can compact again.

Summary rules:

- Fold only settled history before the current user turn.
- Carry the previous summary into the next summary.
- Preserve goals, constraints, decisions, user preferences, identifiers, paths, URLs, files read/modified, completed work, open work, and explicit memory decisions.
- Treat transcript and tool content as untrusted data, not instructions.
- Redact and bound summaries before persistence.
- On summary failure, drop the oldest projected units for that request and write no record.

Commit `3374576` contains a useful earlier prototype and tests. It is reference material, not a cherry-pick: current message kinds, dispatch paths, storage rules, and branch behavior have moved on.

## Portable tool observations

Extend tool activity with an optional safe snapshot:

```ts
interface ToolContextSnapshot {
  callId?: string;
  name: string;
  inputSummary?: string;
  outputSummary?: string;
  ok?: boolean;
  filesRead?: string[];
  filesModified?: string[];
  clipped?: boolean;
}
```

Snapshots are best effort. Existing CLI drivers may initially expose only tool name and outcome. The owned runtime can expose richer summaries. All fields are secret-redacted, control-stripped, and capped before persistence. Raw provider events are never automatically promoted into durable context.

## Memory

`MEMORY.md` remains the durable, engine-independent source of bot memory. Its current bounded contents move from ad hoc system-prompt concatenation into a named context-plan section with byte/token counts and a fingerprint. Every ownership mode therefore receives the same memory snapshot and diagnostics can say when it was clipped without exposing its content.

The separate memory-surface and memory-review-loop plans remain responsible for browsing, approval, editing, journaling, and rollback.

## Resume and recovery

For `vendor-session` engines:

1. Normal turn: resume and send only `currentPrompt`.
2. Rewind, engine switch, or external update: start fresh with `replayPrompt`.
3. Missing/corrupt/rejected resume before prompt acceptance: retry once in a fresh session with `replayPrompt`.
4. Failure after prompt acceptance, or an ambiguous boundary: fail visibly and do not replay automatically because doing so could duplicate side effects.

Drivers must classify the acceptance boundary using their own protocol state rather than mutable English error text.

## OpenMaus Runtime

Add an optional `openmaus-runtime` driver backed by an embedded Pi-style model/agent core. Its first release uses the existing OpenAI-compatible URL, model, and provider-routing configuration, supporting OpenRouter, Groq, llama.cpp, and compatible local endpoints.

The owned runtime:

- rebuilds through `TurnContextPlan` before every model call;
- owns tool execution, approvals, steering, cancellation, deadlines, repeat detection, and iteration limits;
- connects existing OpenMausBot stdio MCP integration descriptors as model tools;
- maps its lifecycle onto the existing canonical `RuntimeEvent` bus;
- retains provider-native tool-call/result structures only in live runtime state;
- persists only bounded portable tool observations;
- uses the desktop's encrypted credential mechanism and reports metered billing;
- never claims to reuse a Claude/Codex subscription login.

All Pi-specific imports live behind `server/runtime/pi-runtime.ts` and a small internal `OwnedAgentRuntime` interface.

## Authentication policy

- Subscription mode stays inside official installed harnesses and their sign-in flows.
- Owned-loop mode initially supports API keys and local no-key endpoints only.
- OpenMausBot does not read vendor CLI auth databases or convert their sessions into API credentials.
- Any future provider OAuth flow requires a separate review showing the provider explicitly supports third-party use.
- UI labels authentication/billing separately from context ownership.

## Observability

Add a metadata-only `context.prepared` runtime event containing ownership, mode, source/sent item counts, estimated input tokens, history budget, `limitsSource`, compacted/clipped flags, and a bounded fingerprint. It contains no prompt, summary, memory, tool output, paths, or credentials.

The inspector renders the event. Engine/model surfaces show `Context: Vendor session`, `Context: OpenMaus replay`, or `Context: OpenMaus managed`. Chat shows an expandable divider at durable compaction boundaries.

## Security and failure boundaries

- Context projection is pure until a validated compaction is inserted.
- Bot/tool/summary content passes the existing secret-redaction boundary before storage.
- Tool observations are wrapped as untrusted historical data in replay prompts.
- API keys never enter context plans, events, diagnostics, summaries, renderer state, or logs.
- MCP children receive only their existing scoped environment and stop on turn settle, cancellation, or runtime disposal.
- Approvals fail closed if the answerer or request broker disappears.
- Iteration count, tool count, tool output, tool duration, and total-turn duration are bounded.

## Rollout

1. Ship portable context, compaction, resume recovery, memory projection, and diagnostics first.
2. Preserve valid CLI-session behavior while always preparing recovery context.
3. Introduce `openmaus-runtime` as disabled-by-default preview; never migrate existing bots.
4. Exercise it against fake model and MCP fixtures before any live-provider testing.
5. Enable it only for newly selected API/local bots after automated and isolated-fixture acceptance.
6. Roll back by disabling the driver or switching engines; canonical history remains usable.

## Acceptance criteria

- More than 40 short turns remain available when the target budget permits.
- Engine switches, rewinds, external updates, and safely recoverable session loss preserve relevant context.
- Smaller models receive a bounded summary and recent complete units; larger models receive more verbatim history from the same branch.
- Tool names, outcomes, and available bounded summaries survive engine switches.
- Full visible history and alternate branches survive repeated compactions.
- No engine ever receives the same history twice in one turn, on any invalidation path.
- Every dispatch exposes non-sensitive context ownership and budget diagnostics, including
  whether the model's declared limits were known or guessed.
- Existing subscription-backed bots behave as before on valid resume paths.
- An OpenMaus Runtime bot can perform a multi-step MCP turn, ask approval, accept steering, be interrupted, restart without native state, and continue from canonical context.
- Verification never touches the user's live OpenMausBot data.

