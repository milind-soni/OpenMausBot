# Phase 0 — foundation: the harness sees what a bot did, and starts measuring

Status: plan (Sep 14, 2026). First phase of the harness-upgrade programme described in
`../../../harness-gap-analysis.md` (§17, "foundation first, team last"). Composes with
`agent-harness-upgrades.md` item 7 (portable context, unbuilt) and item 15 (raw inspector, done).
Touches no bot-to-bot behaviour: delegation, rooms, peer comms and shared memory are untouched
until Phase 6.

**Standing rule (owner, Sep 14): OpenMausBot is model- and CLI-agnostic, and every item here must
hold for every engine.** The engine families on main are: **Claude Code** (stream-json,
`drivers/claude.ts`), **Codex** (app-server JSON-RPC, `drivers/codex.ts`), **pi** (rpc mode,
`drivers/pi.ts`), the **ACP family** sharing `drivers/acp/core.ts` (Cursor, Gemini, Droid, Grok
Build, Hermes, Kimi, OpenCode Go, Qwen, custom, Antigravity), the **OpenAI-compatible HTTP
family** sharing `drivers/openai-chat.ts` (openai-compat for OpenRouter/Groq/Together/llama.cpp,
xAI Grok API, MiniMax, and local hosts through `local-inject.ts`), and the **box agent**
(`drivers/boxagent.ts`, the turn runs on a cloud box). Each item below ends with a per-family
decision: **full**, **degraded** (what is lost is stated), or **not supported** (hidden behind a
capability flag, per the existing rule in `contracts.ts` that a bot is never told it has a
capability its driver cannot mount). Engine-specific channels (Claude hooks) are accelerators; the
baseline of every item is the canonical `RuntimeEvent` stream every driver already emits. §"Every
engine, every item" collects the matrix, and the test plan runs each item against every fake
engine in `server/testing/` (`fake-claude-cli`, `fake-codex-app-server`, `fake-acp-cli`,
`fake-agy-cli`, `fake-pi-cli`, `fake-driver`).

## Why

Six facts about main today, each with the file that proves it:

1. **The harness stores talk, not work.** An `activity` row keeps `tool.name`, `ok`, a
   200-character `summary` and a ≤ 6,000-character `output` preview (`store.ts:Message.tool`,
   `tool-summary.ts:toolDetailPreview`), and every CLI driver already fills that preview from its
   protocol (Claude `tool_result` blocks at `drivers/claude.ts:1538`, Codex `item/completed`
   at `drivers/codex.ts:917`, ACP `rawOutput` at `drivers/acp/core.ts:799`, pi at
   `drivers/pi.ts:707`). The HTTP family has no tools at all (`drivers/openai-chat.ts` is
   chat-only). Nothing *aggregates* those rows into a record of the turn, and the full results
   and reasoning live in the engine's own session, which the harness never reads. Every context rebuild — engine switch, rewind, external update, room turn — is therefore
   the last 40 (`index.ts:5187`) or 30 (`index.ts:6815`) *text* messages, and "a handed-over engine
   has no idea what was done" (`agent-harness-upgrades.md` item 7).
2. **Claude Code hooks are not used.** The driver already writes a private `--settings` file per
   launch (`drivers/claude.ts:1209-1211, 1379-1381`) containing only auth `env`/`apiKeyHelper`.
   Hooks (`PostToolUse` with the full `tool_response`, `PreToolUse`, `PreCompact`,
   `SessionStart` with `source: compact`, `Stop`) can be declared in that same file. They add, for
   Claude only, untruncated tool results and a say around compaction. Other engines get the same
   *information* through their protocols (0.1) and the same *compaction* hooks through the
   harness-owned compaction record (0.7); hooks are an accelerator, not the design.
3. **A bot turn cannot return a typed object.** The Claude driver runs
   `--output-format stream-json` with no schema (`drivers/claude.ts:1048`); the goal-room decision
   is regex-parsed from prose (`group-goal-run.ts:parseGroupGoalDecision`). Everything in Phases 3
   and 6 (verifier verdicts, graph edges, decision nodes) needs schema-checked output.
4. **Nothing fuses process launches.** `spawnCli` (`procs.ts:61`) is called by every driver, the
   one-shot helper (`drivers/claude.ts:1836`), routines and delegation wakes. Wake budgets exist
   per thread (`DelegationWakeBudget`) but there is no user-wide cap. ruflo's history (per-hook
   `npx` cold starts that kernel-panicked a machine; daemons that leaked tens of thousands of
   `claude --print` launches) is the failure to pre-empt.
5. **Cost is booked, efficiency is not.** `appendUsage` records `input/output/cachedInput/cost`
   per settled turn (`index.ts` fold at `case "turn.completed"`; `usage-ledger.ts`), but nothing
   computes tokens-per-task, cache-hit share per bot, or which prompt section costs what on a live
   turn (`previewSystemPrompt` at `index.ts:1553` reports bytes for the *preview*, not for turns).
6. **Every new feature lands in `server/index.ts`** (16,247 lines, ~40 module-level maps, the
   five-call drain incantation repeated at six exits). Both existing plans defer decomposition.
   Phase 0 does not decompose it either; it stops the growth by giving new mutations one shape.

The owner's question that shaped this plan: "you send the first 200 lines and 40 messages every
time — isn't that wasting context?" The honest answer is in §3 of the gap analysis: the notebook
is delivered once and on change (the volatile half), and the 40-message replay is a fallback path.
The real waste is tool output accumulating inside the session, cache-breaking prefixes, and the
lossy shape of the replay when it does fire. One engine family is the exception and proves the
rule: the OpenAI-compatible HTTP drivers have no session to resume, so for them the 40-message
replay is *every* turn (`drivers/openai-chat.ts:194`) and there is no compaction at all — a hard
cut. Items 0.1, 0.2, 0.6 and 0.7 below address exactly those problems, 0.7 matters most for the
HTTP engines, and 0.6 makes the cost of every section visible per turn, per engine.

## What we borrow (and from where)

- **Work digest from events + checkpoint diff** — our own fold (`item.completed` patches the
  activity row with `output`, `turn.completed` settles), `checkpoints.ts` shadow-git per
  `(botId, sha(cwd))` (snapshot before every turn at `index.ts:5639`), `memory-journal.ts`
  turn-boundary diffs. Anthropic's sub-agent guidance (return a 1-2k-token condensed summary),
  Manus ("restorable compression: keep the identifier, drop the payload").
- **Hooks as the observation channel** — Claude Code hook events and their JSON payloads
  (`PostToolUse` carries `tool_name`, `tool_input`, `tool_response`; `SessionStart` carries
  `source`; hooks may return `hookSpecificOutput.additionalContext`). ruflo's hook conventions,
  learned the hard way: always exit 0, a global 5 s timer, dedupe on `tool_use_id`, a local helper
  script (never `npx pkg@latest` inside a hook), stdin JSON with snake/camel normalisation.
  OpenClaw's silent pre-compaction memory flush. herdr's lesson: never let a hook be the *only*
  authority for "blocked" (Esc leaves no hook trace); our driver already sees requests and their
  resolution over stream-json, so hooks here only *observe* and *inject*, never decide state.
- **Typed turns** — `claude -p --output-format json --json-schema` returns `structured_output`;
  `codex exec --output-schema <file>` (with two known Codex caveats: the schema is ignored when MCP
  servers are active in some versions, and unsupported on `resume`). continual-harness's rule:
  validate in code regardless of provider, and a parse failure means "not done".
- **Global launch budget** — ruflo `services/global-ai-budget.ts` (file-locked permits,
  `maxConcurrentGlobal`, per-hour/day caps, pause on quota errors). Our `DelegationWakeBudget`
  and `room-post-budget.ts` pure `(budget, attempt) → decision` shape.
- **Command + receipt shape** — t3code (our upstream: `packages/contracts`,
  `apps/server/src/orchestration/{decider,OrchestrationEngine}.ts`): every mutation is a typed
  command with an idempotent receipt, committed with its events in one transaction; side effects
  are subscribers. Our own `RoutineRequestReceipt` and `chat_followups.sendId` already do this for
  two paths.
- **Measurement** — Manus (KV-cache hit rate as the #1 metric), Factory (tokens per *task*, not
  per request), Claude Code's `/usage` "Prompt cache (main)" line, tbench's cost/tokens columns.

## Design

### 0.1 The work digest (`server/digest.ts`, new `Message.kind = "digest"`)

At `turn.completed` the fold computes one durable, redacted record of what the turn *did*:

```ts
export interface TurnDigest {
  turnId: string;
  botId: string; threadId: string;
  at: number; durationMs: number;
  tools: Array<{ name: string; count: number; failed: number; sample?: string }>; // sample = existing commandSummary
  files: { changed: string[]; added: string[]; deleted: string[]; truncated?: number };   // from the checkpoint diff
  memory: Array<{ path: string; kind: "created" | "updated" | "deleted" }>;                 // from memory-journal rows for this turn
  reply: string;                 // first sentence of the terminal assistant text, ≤ 200 chars
  usage?: { input: number; output: number; cachedInput?: number; costUsd?: number | null };
  hookCoverage: "full" | "chips";  // "full" when 0.2 delivered real tool results for this turn
}
```

- Stored as `pushMessage({ role: "bot", kind: "digest", text: renderDigest(d), digest: d, turnId })`
  where `text` is a compact one-paragraph rendering so the existing FTS triggers index it for
  `session_search` with no schema change (`message-db.ts` indexes `messages.text`).
- **Files changed** come from a new `checkpoints.diffStat(botId, cwd, fromHash, toHash)` that runs
  `git diff --name-status <before> <after>` against the shadow repo (`runGit`, existing 120 s
  timeout and per-repo `serialize`). The "before" hash is the snapshot taken at dispatch
  (`index.ts:5639`); the "after" is a second snapshot at settle, labelled `settle <turn>`. When
  checkpoints are disabled or refused for the cwd (`refusalReason`), `files` is omitted and the
  digest says so. Paths are relative to cwd; secrets in paths are not a concern, contents never are
  read.
- **Tool counts** come from the turn's `activity` rows (grouped by `tool.name`, `ok === false`
  counted as failed) — available for every driver. When 0.2 is active the `sample` and the
  `failed` count come from real results instead of chips, and `hookCoverage` flips to `"full"`.
- **Memory rows** come from `memory-journal.ts` entries with this `threadId` written between
  dispatch and settle (`endMemoryTurn` already runs on `turn.completed`; order the digest after it).
- Rendered digests are **included in every context rebuild**: the direct replay filter at
  `index.ts:5185` and `serializeRoomContext` at `index.ts:6813` admit `kind === "digest"` rows,
  rendered as a bracketed `[What <bot> did in the previous turn: …]` line. This is the first
  time a rebuilt context carries *work*, not only talk. The renderer shows a digest row as a
  collapsed chip ("did 30 things · 2 files") under the reply; it is not a new message bubble.
- Size cap: 1,500 bytes rendered (tools list truncated to top 8 by count, files to 20 with a
  `+N more` marker). One digest per settled turn; failed/interrupted turns still get one with
  `reply: ""` so the record of tool use is not lost.

**Engines.** *Full:* Claude, Codex, pi, ACP family — tool counts, failures and samples come from
the `activity` rows every one of these drivers already writes with an `output` preview; files
from the checkpoint diff (any engine with a `cwd`); memory from the journal. *Degraded:* box agent
— the turn runs on the box, so the harness sees only assistant text; the digest carries the reply,
usage and `hookCoverage: "none"`, and the box's own tool activity is a Phase 5 item (box-side
event tap). *Degraded by nature:* HTTP family — no tools, so a digest is reply + usage + memory
rows; still written, because rebuilds for these engines happen every turn and the digest is the
only work record they have.

### 0.2 Claude Code hooks through the existing `--settings` file (`server/hooks/`, `drivers/claude.ts`)

`authSettingsPath` becomes `settingsPath` and is always written (not only when auth settings
exist). Its content gains a `hooks` block pointing at one local helper, `server/hooks/omb-hook.ts`
(run with the same `process.execPath --experimental-strip-types` as `PERM_PROXY_PATH`), which
POSTs the event to `http://127.0.0.1:PORT/api/internal/hook` with the turn's capability token in
`env` (the same `mintInternalCapability` door every proxy uses, so a hook can only report into its
own thread).

Events and what the harness does with each:

| Hook | Matcher | Harness action |
| --- | --- | --- |
| `PostToolUse` | `*` | Ingest `{tool_name, tool_input, tool_response, tool_use_id}`; store the redacted result (`tool-summary.ts:toolDetailPreview`, 6 KB cap; spill the full text to `DATA_DIR/tool-results/<thread>/<tool_use_id>.txt` at 0600) on the matching activity row (`toolMessageByItem`); feed 0.1. Dedupe on `tool_use_id` (a retried hook never double-counts). |
| `PreToolUse` | `Bash` | Return `updatedInput` rewriting known noisy commands (`pnpm test`, `pytest`, `npm test`, `git log` without `-n`, package installs) to a filtered form (`… 2>&1 \| tail -n 200`, `--quiet`), from a small allowlist table in `server/hooks/filters.ts`. Never blocks; never rewrites commands it does not recognise. Off by default per bot until measured (see 0.6). |
| `PreCompact` | `*` | Return `additionalContext` = compaction guidance: "preserve decisions, unresolved errors, file paths, verification commands, the current PROGRESS goal; drop tool output". Log a `compaction.pending` event on the bus. (The OpenClaw-style *silent flush turn* is Phase 1; here we only steer the CLI's own summary.) |
| `SessionStart` | `source: compact` | Return `additionalContext` = the last digest(s) of this thread (≤ 1,500 bytes) so post-compaction context carries the work record. Log `compaction.completed`. |
| `Stop` | `*` | Bus event `turn.stop-hook` with the CLI's `stop_hook_active`; used only for a digest-vs-fold consistency counter in 0.6. No behaviour. |

Conventions, enforced by `omb-hook.ts` and its tests: exit 0 on every path; 5 s global timer;
stdin JSON parsed leniently; no network calls except loopback; no writes outside `DATA_DIR`. The
`--settings` file is part of `privateFileFlags` already, so a changed hooks block does not change
`argsKey` (no respawn of a healthy session) — but the hook *helper path* and the harness port are
stable for the life of the server, so this is safe. Feature flag `OMB_HOOKS=0` disables all of it;
Codex bots are unaffected (their digest stays `hookCoverage: "chips"`), and Phase 1 decides what
the Codex equivalent is.

Security notes: the hook payload is model-influenced data; it is stored under the same redaction
as every activity row and is never rendered into another bot's prompt (Phase 6 will fence it). A
hook cannot approve anything: `PreToolUse` here only ever returns `updatedInput`, never a
`permissionDecision`.

**Engines.** *Full:* Claude. *Equivalent through the protocol, no hooks needed:* Codex
(`aggregatedOutput`/`exitCode` per command, `fileChange.changes`), ACP (`rawOutput`), pi
(`result`) — the digest reads the same `activity.output` field for all of them; the only thing
Claude hooks add is the untruncated response when a result exceeds the 6,000-character preview,
so 0.2's spill-to-file is generalised: every driver's `item.completed` may carry
`outputPath` when the harness spilled the full text, and `hookCoverage` becomes
`"full" | "preview" | "none"`. Compaction observation: Claude via hooks; Codex, pi and ACP have
their own compaction the harness cannot observe today (`hookCoverage` stays `"preview"` and the
compaction-record path in 0.7 is used when the harness rebuilds); HTTP family — the harness *is*
the compactor (0.7). *Not supported:* box agent (no process on this machine). `OMB_HOOKS` is a
Claude-driver flag; no other driver reads it.

### 0.3 Typed turns (`SendTurnInput.outputSchema`, drivers)

`contracts.ts:SendTurnInput` gains `outputSchema?: JSONSchema` and `RuntimeEvent turn.completed`
gains `structured?: unknown`. Driver behaviour:

- **Claude:** if the live stream-json process supports `--json-schema` for the turn (to verify
  against the installed CLI version with `claudeCliSupports`, like `--autocompact`), pass it;
  otherwise run the schema-bearing turn through the existing one-shot path
  (`drivers/claude.ts:1836` pattern) on the same session id. Either way the driver parses
  `structured_output`, validates it in code (zod from the JSON schema), and emits it on
  `turn.completed.structured`; an invalid or missing object is emitted as `structured: undefined`
  with `structuredError`, never as a guess.
- **Codex:** `codex exec --output-schema <tmpfile>`; because Codex ignores the schema when MCP
  servers are active (upstream issue), schema-bearing Codex turns mount no agents MCP, and resume
  is not used for them.
- **Every engine, baseline:** the harness-side fenced-JSON path described under "Engines" below
  is what actually guarantees the contract; a driver-native path only replaces the extraction
  step. A missing or invalid object is `structured: undefined` with `structuredError`, and callers
  must treat that as "not done".

First consumer (in this phase, as the proof): `group-goal-run.ts` decision envelope gets a
schema-first path — `{status: "continue"|"done"|"needs-input"|"blocked", next?: string,
instruction?: string}` — with the existing `parseGroupGoalDecision` prose parser kept as the
fallback. No behaviour change for rooms beyond fewer "malformed envelope → safe pause" outcomes.
(This touches goal rooms only as a *reader* of the new field; the room engine itself is Phase 6.)

**Engines.** The baseline is engine-agnostic and lands first: the harness appends a fixed
instruction ("Reply with exactly one fenced ```json block matching this schema and nothing
else") to the turn text, extracts the last fenced JSON block from the terminal assistant text,
and validates it with zod; that path is *full* for Claude, Codex, pi, the ACP family, the HTTP
family and the box agent alike, and is what the tests run against every fake engine. Native
constrained decoding is an accelerator layered on top where it exists — Claude `--json-schema`
(version-gated, with the one-shot fallback), OpenAI-compatible `response_format: json_schema`
for endpoints that advertise it (probe once per instance; fall back silently) — and is never
required for correctness. No driver may report `structured` from anything other than validated
JSON.

### 0.4 Global launch budget (`server/launch-budget.ts`)

One fuse for every process the harness starts: `spawnCli` takes a `LaunchTicket` from
`launchBudget.acquire({ kind: "turn"|"helper"|"routine"|"wake"|"bench", botId })` and releases it
on exit. Pure decision function `(budget, request, now) → { ok } | { deny: reason; retryAfterMs }`
with defaults `maxConcurrent: 6`, `maxPerHour: 120`, `maxPerDay: 800`, plus a 15-minute pause
after a provider quota error (classified by `drivers/retry.ts:classifyError`). State in
`DATA_DIR/launch-budget.json` via `atomic.ts`. A denied launch surfaces as the existing typed
admission error family (`turn-dispatch-guard.ts`) so routines and wakes park instead of failing.
Settings UI shows the three numbers and the current pause; defaults are generous enough that a
person never notices them.

**Engines.** *Full:* every driver that spawns a process (Claude, Codex, pi, ACP family, the
one-shot helper, and the box agent's local control process) because the fuse sits in `spawnCli`.
*Full, by request count:* HTTP family — `launchBudget.acquire({ kind: "request" })` around each
chat-completions call, since there is no process; the same pause-on-quota rule applies from the
retry classifier these drivers already share (`drivers/retry.ts`).

### 0.5 The command + receipt rule for new mutations (`server/commands.ts`)

Not a rewrite. A ~150-line seam that every *new* mutation in this and later phases goes through:

```ts
export type Command = { kind: string; key: string; threadId?: string; payload: unknown };
export interface CommandReceipt { kind: string; key: string; at: number; result: unknown }
export function runCommand<T>(cmd: Command, apply: (tx: Tx) => T): T;  // idempotent on (kind, key)
```

Receipts live in a new `command_receipts` table in `messages.db` (`kind, key, at, result_json`,
PRIMARY KEY `(kind, key)`), written in the same SQLite transaction as the mutation's message rows.
Phase 0 uses it for exactly three commands — `digest.append`, `hook.ingest`, `launch.acquire` —
and the plan-of-record rule from here on is: new state changes are commands with receipts, new
side effects are bus subscribers. Existing paths are left alone until a later phase touches them.

### 0.6 Measurement: tokens per task, cache-hit share, prompt sections per turn (`server/metrics.ts`)

- **Per-turn prompt section bytes.** `buildSystemPrompt` already returns `bytes` per section; the
  dispatch path records `{threadId, turnId, sections: {id, bytes}[], stableBytes, volatileBytes,
  volatileChanged: boolean, transcriptReplayed: boolean, replayBytes}` on the bus as
  `turn.prompt-shape` and into the usage row (`usage-ledger.ts:UsageRow.promptShape?`). This is
  the per-turn version of the "what the model sees" preview and answers the owner's question with
  numbers instead of an argument.
- **Cache-hit share per bot** = `cachedInput / (input + cachedInput)` over a window, from the
  figures the fold already banks; surfaced on the bot's usage summary and as a sidebar tooltip
  ("cache 91%"). A drop below 60% on a bot for three consecutive turns emits a `notify`-free chip
  in the inspector ("prefix changed: …" naming the section whose bytes changed), which is the
  Manus/Claude Code "declare a SEV" idea at chip scale.
- **Tokens per task** = sum of `input + output` across the turns of one thread between the user
  message and settle, grouped by trigger; exported in the existing CSV.
- **Digest coverage** = share of settled turns with `hookCoverage: "full"`, per engine.

**Engines.** *Full:* all — prompt-shape bytes come from `buildSystemPrompt` before any driver is
involved; `input`/`output` are reported by every driver's `turn.completed`. *Degraded:* cache-hit
share needs `cachedInput`, which Claude and Codex report, the HTTP family reports where the
endpoint returns cached-token counts (OpenAI-compatible `prompt_tokens_details.cached_tokens`;
map it in `openai-chat.ts`), and ACP, pi and the box agent do not report — for those the sidebar
shows "cache: not reported by this engine" rather than a misleading 0%. The coverage metric is
reported per driver kind so a regression on one engine is visible.

### 0.7 Replay by tokens, not message count; summary record seam

- `buildTurnContext` and `serializeRoomContext` stop cutting at 40/30 *messages* and cut at a
  byte budget (default 24 KB, `config.contextRebuildBytes`), newest first, digests included
  (0.1). A rebuilt context now says how many older messages it dropped.
- A `Message.kind = "compaction"` record `{ summary, firstKeptId, tokensBefore }` is added to the
  schema (from `agent-harness-upgrades.md` item 7) and **written only by hand in Phase 0** (a
  `/api/internal/threads/:id/compact` route the owner can call), using the existing
  `ProviderInstance.generateText` seam. Automatic, hook-driven summaries are Phase 1; the schema
  and the rebuild's ability to *use* a compaction record (replay = summary + everything after
  `firstKeptId` + digests) land now so Phase 1 is data-only.

**Engines.** *Full:* HTTP family and box agent — these are transcript-replay drivers, so the byte
budget, digest inclusion and compaction record are their *only* context mechanism and apply on
every turn. *Full on the fallback path:* Claude, Codex, pi, ACP — the rebuild only runs on
rewind, engine switch, external update or resume rejection (`resume-recovery.ts`), and it now
carries digests and honours the byte budget. The manual `/compact` route works for every engine
because it uses the harness-side `generateText` seam, not the engine's own compaction.

### 0.8 Benchmark track: the headless driver (`scripts/bench/run.ts`, `POST /api/bench/run`)

`maus bench run --bot <id> --task <file|string> --cwd <dir> --budget "steps=200,tokens=400000,minutes=30" --out <dir>`
starts one fresh detached thread on one bot (exactly what routines do: `createTask(activate=false)` +
`startTurn(... { automationSource: "bench" })`), blocks until settle or budget, and writes
`trajectory.json` (the thread's messages + digests + usage + prompt shapes) and `result.json`
(`{status, turns, tokens, costUsd, durationMs}`). A `--network allow=host1,host2` flag threads
through to the engine environment where a driver supports it and is recorded in the result either
way. This is the adapter every leaderboard (Harbor / Terminal-Bench first) will call; it is also
the harness's own regression fixture from now on.

**Engines.** *Full:* every driver, by construction — the driver takes `--bot`, and the bot's
engine is whatever it is configured with; the result records `driverKind` and `model`. The
baseline run in step 10 is executed for at least Claude, Codex and one ACP engine so the
"tokens per task" numbers exist per engine from day one.

## Every engine, every item

| Item | Claude Code | Codex | pi | ACP family | HTTP family (OpenAI-compatible) | Box agent |
| --- | --- | --- | --- | --- | --- | --- |
| 0.1 digest | full | full | full | full | degraded: reply + usage only (no tools) | degraded: reply + usage only |
| 0.2 tool results | full (hooks, untruncated) | preview via protocol | preview via protocol | preview via protocol | n/a (no tools) | not supported |
| 0.2 compaction observation | full (hooks) | not observable | not observable | not observable | harness owns it (0.7) | not supported |
| 0.3 typed turns | full (fenced JSON; native `--json-schema` accelerator) | full (fenced JSON) | full (fenced JSON) | full (fenced JSON) | full (fenced JSON; `response_format` accelerator where advertised) | full (fenced JSON) |
| 0.4 launch budget | full (process) | full (process) | full (process) | full (process) | full (request) | full (process) |
| 0.5 commands + receipts | engine-independent | | | | | |
| 0.6 prompt shape, tokens/task | full | full | full | full | full | full |
| 0.6 cache-hit share | full | full | not reported | not reported | where endpoint reports | not reported |
| 0.7 replay by bytes + digests | fallback path | fallback path | fallback path | fallback path | every turn (primary) | every turn (primary) |
| 0.7 compaction record | manual route | manual route | manual route | manual route | manual route (only compaction they have) | manual route |
| 0.8 bench driver | full | full | full | full | full | full |

## Findings while building (hand-offs to later phases)

- **F1 (Phase 1, prefix and cache discipline): the Claude CLI is respawned on every turn
  whenever the agents tools are mounted.** `drivers/claude.ts` keys the live process on
  `argsKey`, which embeds `mcpServers` verbatim; `mcpServers.agents.env.OMB_COMMS_TOKEN` (and the
  computer/browser tokens) are minted per turn generation, so the key never matches and the
  "reuse the live process when it is idle and unchanged" branch is dead in practice. Proven in
  the hooks e2e: a `FAKE_CLAUDE_DUMP` (first prompt per process) written by the second turn held
  the second user message. Consequence: every turn is a fresh `--resume` launch, which the
  driver's own comment on the volatile split describes as re-uploading the conversation at the
  cache-write rate. Fix shape: key on the MCP server *identities and commands*, not on rotating
  secrets, and deliver rotating tokens the way hooks now do (a per-thread file the driver rewrites
  every turn), or pass them through the MCP config on reuse. Measure with 0.6 before and after.
  **Fixed in Phase 0 (Sep 15), pulled forward at the owner's request:** `server/turn-token.ts`
  writes each integration's per-turn bearer to a stable, private per-(kind, bot, thread) file
  and the environment names the file; the agents, browser and connector proxies read it on every
  request (`turn-token-read.ts`). The spawn contract now sees only stable paths, and the hooks
  e2e proves the second turn reuses the live CLI process. Still per-turn in env, by design:
  computer control tokens (`OMB_CONTROL_TOKEN`), because the container MCP runs inside the box
  where a host file path means nothing; a bot with a computer mounted still respawns per turn.
- **F3 (Phase 1, prefix discipline; measured by 0.6 from now on): bundled skills are selected
  by trigger terms in the user's text and inlined into the `skill-instructions` section of the
  STABLE prompt half** (`server/skill-library.ts:selectBundledSkills`, rendered at dispatch), so a
  message that trips a trigger changes the spawn contract and the cache prefix for that turn and
  the next. The `stablePrefixChanges` count per bot in `/api/metrics` makes this visible; the fix
  (Phase 1) is to deliver selected skill bodies through the volatile half or as a turn-text
  attachment, keeping the stable prefix stable.
- **F2 (Phase 0, item 0.4 as built): Claude Code's PreCompact hook cannot inject context and
  SessionStart accepts plain-text stdout, not `additionalContext`.** The hook helper therefore
  prints the harness's `context` string as plain text on SessionStart only; PreCompact is observed
  (a transcript chip) and compaction *guidance* has to travel through the CLI's own channels
  (`# Compact instructions` in the generated project instructions, or `/compact <focus>` when the
  harness triggers compaction itself in 0.7).

## Steps (each one PR-sized, in order)

1. `commands.ts` + `command_receipts` table + tests (0.5). No callers yet.
2. `digest.ts`: build from activity rows + memory-journal + checkpoint `diffStat`; `kind: "digest"`
   in `store.ts`/`message-db.ts`; fold writes it at settle; renderer chip; replay + room context
   admit digests. Tests: unit (`digest.test.ts`), e2e with the fake engine (`digest.e2e.test.ts`,
   modelled on `branching.test.ts`): a fake turn that edits two files yields a digest naming them.
3. `hooks/omb-hook.ts` + `/api/internal/hook` + `PostToolUse` ingest with dedupe and spill; the
   `--settings` file always written; `hookCoverage: "full"`. Tests: hook helper unit tests (exit 0
   on garbage stdin, 5 s timer), route tests with a forged token (must refuse), fake-engine e2e
   where `FAKE_CLAUDE_*` emits a hook call.
4. `PreCompact` / `SessionStart(compact)` / `Stop` hooks: compaction recorded as transcript
   chips, the last two digests re-sent as plain-text context after it (see F2).
5. `launch-budget.ts` at turn admission (unattended launches only: routines, wakes, peers,
   benches — a person's own turn is never held or counted, because a chat full of parked
   approvals is not autonomous work) plus a blunt process fuse in `spawnCli`; tickets expire
   after a bounded turn lifetime and are released on any terminal event, so a dispatch that
   dies mid-setup cannot starve the cap; typed `launch_budget` refusal that routines park on;
   `GET /api/launch-budget`; config `launches.{maxConcurrent,maxPerHour,maxPerDay}`.
6. `metrics.ts`: prompt shape per turn (stable/volatile bytes, replay, stable sections that
   changed since the previous turn) booked on the usage row with duration and evidence coverage;
   `GET /api/metrics` with per-bot, per-engine and per-trigger tokens per turn and per task,
   cache-hit share (honestly null where an engine reports no cached tokens), replays,
   stable-prefix changes and coverage. CSV columns and the sidebar tooltip are deferred to the
   Phase 1 UI pass; room turns record no shape yet (Phase 6).
7. Replay by bytes with digests; `compaction` message kind and manual compact route (0.7).
8. Typed turns: contract field, Claude and Codex driver paths, schema validation, goal-room
   schema-first decision with prose fallback (0.3).
9. `PreToolUse` command filters behind a per-bot flag, plus a before/after tokens-per-task
   comparison on the bench fixture (only ship enabled-by-default if it measures better).
10. Headless bench driver (0.8) and a first Terminal-Bench baseline through Harbor, recorded in
    `docs/bench/2026-09-baseline.md` with trials, N, budgets and cost.

## Verification

Follow `docs/verification/README.md`: every claim below is proven against an isolated fixture
(`scripts/control-omb.ts launch`), never the live app.

- **Matrix tests are mandatory for every item.** Each e2e case below runs as `describe.each` over
  the fake engines (`fake-claude-cli`, `fake-codex-app-server`, `fake-acp-cli`, `fake-agy-cli`,
  `fake-pi-cli`) plus the in-memory `fake-driver` standing in for the HTTP family and the box
  agent, in the style of `drivers/acp/approval-matrix.test.ts`. A case that legitimately cannot
  apply to an engine asserts the *degraded* or *not supported* behaviour named in the matrix
  above (for example: the HTTP fake yields a digest with no `tools`, and the cache tooltip reads
  "not reported"), never skips.
- Unit: vitest per new module; the pure functions (`decideLaunch`, digest rendering, replay
  budgeting, hook payload normalisation, fenced-JSON extraction) get table tests.
- E2E (real server, fake engine): (a) a turn produces one digest with correct tool counts and file
  names; (b) an engine switch mid-thread replays digests and the new engine's first reply can name
  the files the old one changed (the phase's "done when") — run for every ordered pair of fake
  engines, not only Claude→Codex; (c) a forged hook token is refused and
  logged; (d) a hook that hangs does not delay settle (5 s timer); (e) launching 7 concurrent turns
  parks the 7th with the typed reason and it runs when a slot frees; (f) a schema-bearing turn
  returns a validated object and an invalid one yields `structuredError`.
- Recipe added to `docs/verification/digests.md` and `docs/verification/hooks.md` with the exact
  `pnpm control:omb` commands.
- Measurement gates before merge of step 9: tokens per task on the bench fixture must not
  increase; cache-hit share must not decrease.

## Out of scope (deliberately)

- Team notebook, shared recall, delegation contract, bot state API, stateful rooms, goal-room
  graphs — Phase 6.
- Automatic compaction summaries and the silent pre-compaction flush turn — Phase 1.
- Task table, tool search, tool reliability layer — Phase 2.
- Verifier, graph runner — Phase 3.
- Decomposing `index.ts`. Phase 0 only guarantees the new pieces live in their own modules
  (`digest.ts`, `hooks/`, `launch-budget.ts`, `commands.ts`, `metrics.ts`) and reach `index.ts`
  through one bus subscriber each.

## Risks and how each is bounded

- **Hooks change CLI behaviour.** Mitigation: hooks only observe and inject `additionalContext`;
  `OMB_HOOKS=0` kill switch; the `--settings` file is already private per launch.
- **`--json-schema` may not compose with a long-lived stream-json process.** Mitigation: version
  gate plus the one-shot fallback on the same session; the contract makes "unsupported" explicit.
- **A second checkpoint per turn doubles git work on big folders.** Mitigation: the settle snapshot
  reuses the per-repo queue and 120 s timeout; `diffStat` is skipped when the dispatch snapshot
  was skipped; measured in 0.6 as `durationMs`.
- **Digest rows in FTS pollute recall.** Mitigation: digests are ranked below text hits in
  `recallMessages` (kind-aware boost) and rendered with a visible `[digest]` label.
- **Budget denies a human's turn.** Mitigation: `kind: "turn"` from a person is never denied by the
  hourly/daily caps, only by `maxConcurrent`; the sidebar shows why.
