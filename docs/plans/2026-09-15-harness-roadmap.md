# Harness programme — roadmap for the phases after Phase 1

Status: written Sep 15, 2026 from `../../../harness-gap-analysis.md` §17 (the plan of record)
after §16c (a user's roadmap suggestion) and §16d (Overlay) were folded into it. This file is the
repo's copy of what comes next so a session can plan a phase without the external document; when
the two disagree, the gap analysis wins and this file is updated. Built phases have their own plan
files: `2026-09-14-phase-0-foundation.md`, `2026-09-15-phase-1.md`.

Order, decided by the owner: a solid single-bot foundation first (Phases 0–5), the team last
(Phase 6). Nothing here is a rewrite; each item reuses a seam that exists. A benchmark track runs
beside every phase on one bot doing one task.

## Standing rules (every phase, every PR)

1. **Every engine.** Claude Code, Codex, pi, the ACP family, the OpenAI-compatible HTTP family
   and the box agent each get a stated decision per item: full, degraded (what is lost), or not
   supported behind a capability flag. Claude hooks are accelerators; the baseline is the
   canonical event stream. The HTTP family is the reference implementation where we own the loop
   (decision 14).
2. **Correctness first.** Any change that cuts context is kept only if T1–T5 and the recall set
   stay at 100% correct; tokens are the second number (decision 19).
3. **Workflow.** `AGENTS.md` "Harness work": start from current main, check open and closed PRs
   and say so, test and measure locally (fakes, side-by-side build, scorecard on main and branch),
   real checks, PRs last, stacked and small.
4. **Overlay.** AGPL-3.0; items marked **(16d)** are rules, fields and orderings written fresh
   against our own seams and tests, never copied code (decision 22).

## Carried open from Phase 0

Specified for Phase 0, not on the built branches: the policy chain (redaction, egress allowlist,
destructive-command class, per-bot deny list, connector permission verbs read / draft / send /
modify / delete, **(16d)** per-server default and per-tool override MCP policy with an execution
log row), the hard per-task budget in tokens and money, and the in-memory sandbox backend. Phase 1
part 2's fingerprint rule is the first piece of the budget seam; the chain lands with Phase 2's
tool work unless pulled forward.

## Phase 2 — one task object and tools (M)

- Task table as an adapter over the existing ledgers (routine runs and threads first), with
  `owner` and `dueAt` columns (§16c); board view; `list_tasks`; results stored as digests on the
  task.
- Remote HTTP MCP servers behind the existing Test-then-enable flow with the rug-pull hash check
  (hash the tool list at approval, re-prompt on change), and per-connector "where it runs, where
  data travels" rendered from the egress allowlist (§16c).
- Deferred tool loading with a harness `search_tools` and a 3–5 tool core; tool description
  expansion at mount; Composio through meta-tools only with the connect-link loop; a gap detector
  that proposes a missing tool with provenance for approval.
- Tool reliability layer: four timeouts, retries only for idempotent tools, errors that teach,
  output cap with spill to file.
- Engine reliability layer (§16b Gap A): a fallback ladder declared per bot (primary, named
  alternate, degrade to a cheaper engine, park and tell the human), reason recorded on the task
  row; live swap for HTTP bots; for CLI engines fail the turn cleanly and restart on the
  alternate from the last checkpoint (decision 12).
- Structured `ask_user` with named options and a typed answer, an availability flag so an
  unattended routine assumes-and-notes instead of blocking, and the ambiguity protocol: search
  first, ask second, act third (decision 13). **(16d)** The unattended rule as prompt text for
  routine runs: do not ask clarifying questions; if auth, context or tool access is missing, stop
  and write a concise failure summary.
- **(16d)** Mention tokens: a reference serialised as `@name [[omb:type:id]]` inside routine
  instructions and delegation briefs (types: file, skill, routine, MCP server, connector, room,
  task, capture), resolved at run time into one line with the id and a short summary.
- **(16d)** Run record fields for routine runs: states `cancel_requested`, `skipped`,
  `dead_letter`; a per-routine concurrency policy (skip or queue while the last run is going); a
  failure streak; the exact prompt snapshot each run executed with.
- F4 from Phase 0: wire the native structured-output accelerators (Claude `--json-schema`, Codex
  `--output-schema`, OpenAI `response_format`) once typed turns are the common case and the
  metrics can show the saving.
- Small (§16c): package export keeps the engine preference as setup intent.
- **Benchmark track:** persistent terminal (tmux) tool, output cap, backgrounding; second
  Terminal-Bench run.

## Phase 3 — verification and graphs v1 (M)

- A declared gate sequence per project (typecheck, lint, test, build) that runs as code; every
  completion claim states its scope ("typecheck and tests pass; I did not run the build").
- Tool-less verifier with strict JSON; completion-audit prompt when a bot tries to stop with an
  open task; stall counter and tool-loop breaker (warn at 3, block at 5 identical failing calls).
- Graph runner: node checkpoint tables in SQLite, replay from checkpoints, the handoff tree
  generalised into a scheduler with node kinds `bot_turn / decision / code / check / approval /
  verify`. First graph: routines with continuity, intake → work → check → judge → ship (single
  bot, unattended). **(16d)** The routine's instructions stay the source; the graph is derived
  from them and refined, never a second truth.
- Recording driver so harness tests replay recorded node outputs with zero model calls.
- **Benchmark track:** planner/executor split, model fallback; SWE-bench Pro standardised run;
  best-of-N with a judge on a hard subset; and the **engine bake-off** as a named deliverable
  (§16c): the same task through N bots differing only in `modelSelection`, scored on tokens,
  cost, latency, correctness, human interventions, policy violations and judge quality, averaged
  over trials and surfaced in the app.

## Phase 4 — learning loop (M)

- Automatic fact capture at turn end into the bot's own notebook, opt-in per bot (decision 16),
  writing *candidates* in a fixed shape, single-pass and ADD-only, deduped, consolidated by a
  small graph (collect → dedupe → consolidate → apply with hash check → journal).
- **(16d)** Two extraction prompts by speaker: human-authored text (preferences, facts, standing
  instructions) and bot-authored text (only explicit decisions, verified outcomes and stable
  facts; never speculation, suggestions, secrets or unverified claims that an action occurred),
  each reading prior messages from the same author only; drop candidates under 0.4 confidence;
  keep at most 8 per message; every extraction call charged to the task budget under the Phase 1
  part 2 fingerprint rule.
- **(16d)** A skill import lock recording source repository, path and content hash for every
  imported skill, beside the hash check `syncSkillLinks` already runs.
- Post-task reflection into candidate skills (when to use / procedure / pitfalls / verification);
  promotion ladder with usage counters and one human approval (decision 8); `run_code →
  save_skill → run_skill` with sandboxing and a supply-chain policy; offline mini-benchmark before
  promotion; taint gating and secret redaction; the capture rule from §11c (a capture's transcript
  is the person speaking; window text and screenshots never become a standing fact without
  confirmation).
- Memory freshness: `confidence` and `last_confirmed` columns; nightly consolidation that
  supersedes contradicted lines and archives untouched ones, snapshotting first, with a hard
  floor on how much one pass may remove.
- Routine "note for the next run" and "already scheduled" block.
- **Benchmark track:** HAL submission; an auto-research loop where a research bot runs harness
  experiments against the headless driver.

## Phase 5 — computers and browsers (M)

- One `Sandbox` interface over local, in-memory and remote backends with `afterStart`,
  `beforeStop`, `onTimeout` as the home for golden-image restore, the session reaper and
  snapshot-on-timeout.
- Browser tool snapshot-first with a condenser, screenshot on demand, actions as code, per-site
  action cache (decision 10); computer-use screenshot discipline (1280x720, text before image,
  zoom, batched actions, medium effort).
- Golden-image snapshots for the Local VM and cloud desktop with restore per task and one
  durable machine per bot; git worktree per thread.
- Heartbeat routine on a light context (reply NO_REPLY or post once); its first job an
  open-loops routine over recent captures, threads and digests that extracts commitments and
  posts them once (§11c).
- **Benchmark track:** Online-Mind2Web with the standard judge, then OSWorld 2.0.

## Phase 6 — the team (M)

- Team notebook (section and room scope) with provenance tags on every entry (user said it, a
  bot inferred it, a tool result) and team recall with disclosure chips. **(16d)** Bot-inferred
  entries land in the shared scope by default with the writing bot as author, rendered with
  attribution and a per-author filter; any member may copy a note, only the author may delete
  it (decision 21).
- Bot state API (`get / wait / subscribe`) carrying the bot's location as a field (§16c), and the
  attention queue with guarded prompting (refuse if blocked, require activity within 5 s, then
  wait).
- Delegation contract: structured brief, delegates in their own thread with a restricted tool
  set, access-list inputs, summary plus artifact references back, cancel and steer, durable
  delegation watch; the three delegation paths unified on the task object.
- Stateful rooms (one resume cursor per bot and room). Goal rooms as the second graph (plan →
  fan-out → verify → decide, coordinator consulted once per phase).
- **Benchmark track:** multi-bot runs on the same boards to prove the team beats one bot on cost
  or accuracy, or is turned off where it does not.

## Later (L, only on evidence)

- Engine routing by kind of job: a graph `decision` node over a per-bot table seeded from
  bake-off data (§16c; not before the data exists).
- **(16d)** The ranked memory slice experiment: inject only the top N entries by importance then
  recency with the rest reachable through Phase 1 part 2 recall; kept only if the recall set and
  T1–T5 stay at 100% (decision 19; not before the recall set exists).
- Hybrid search with local embeddings (`sqlite-vec`, only if lexical recall measurably fails);
  a harness-side compressor for engines that allow it; nightly "dreaming" consolidation with
  scoring; team-scoped skill library; claim-level memory with contradiction reports;
  decomposing `server/index.ts` seam by seam as each phase touches it.

## Not taken (so nobody re-proposes it)

A curated connector catalog with guided OAuth (product surface; Composio carries OAuth); moving
live jobs between machines; the in-turn "save anything personal" memory protocol; two extractors
on every turn; "newest 100, then filter" memory listing; a project object beside `AGENTS.md`;
per-model context summaries with a "summarised through" cursor for the CLI families; any hosted
memory dependency (decision 15) or engine-side memory plugin by default (decision 17).

## Decisions (gap analysis §18–§21; 7–14 taken on the recommendation, Sep 15)

| # | Question | State |
| --- | --- | --- |
| 7 | Benchmark first target | decided: Terminal-Bench 2.1 |
| 8 | Who may author skills, who approves promotion | decided: any bot writes a candidate; promotion needs one human approval and a passing mini-benchmark; MCP auto-install from an allowlist only |
| 9 | Graphs start with routines or goal rooms | decided: routines (Phase 3), goal rooms (Phase 6) |
| 10 | Browser snapshot-first | decided: yes; screenshot on demand; code over the page |
| 11 | Per-task budget default and who raises it | decided: money cap, warn at 70%, pause at 100%, only the owner raises; lower default for unattended bots |
| 12 | Engine fallback or park | decided: silent same-class fallback recorded on the task; approval before degrading; park on side effects |
| 13 | `ask_user` when nobody is there | decided: assume the most reversible option and write it to the task; block only before destructive actions |
| 14 | HTTP family first class | decided: yes, the reference implementation; CLI families get the best degraded version |
| 15 | Memory dependency | decided: none |
| 16 | Automatic capture | decided: opt-in per bot |
| 17 | Engine-side memory plugins | decided: no by default; surfaced as an unowned source if installed |
| 18 | SupaMaus intentional capture only | decided: yes |
| 19 | Ranked memory slice | decided: order now, cut later on evidence |
| 20 | F3 without a skill scorecard task | decided: no |
| 21 | Bot-inferred memories shared by default | decided: yes, with attribution |
| 22 | Code from Overlay | rule: none |
