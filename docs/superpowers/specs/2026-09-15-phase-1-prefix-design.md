# Phase 1, part 3: prefix fixes — a stable prompt on every thread

Status: design taken on the recommendation (Omkar, Sep 15, 2026). Builds on Phase 0's prompt-shape metrics (`stablePrefixChanges`, `promptShape`) and parts 1–2. Plan pointer: `docs/plans/2026-09-15-phase-1.md`, part 3. Standing rules: every item works on every engine; correctness on T1–T6 and the recall set at 100% is the gate (decisions 19, 20).

## Goal

The stable half of a bot's system prompt is the same bytes on every thread and every turn of that bot, so a live CLI process is never relaunched by a prompt change and a provider's prompt cache is reused across threads. Measured by `stablePrefixChanges` (must be 0 on T2 and T5) and the first-turn cache write on a new thread (`input − cachedInput` on turn 1 of T6's second task, main versus branch), with T1–T6 and the recall set unchanged.

## Problem

Three things move the stable half today, each proven by a Phase 0 finding or by reading the call site:

1. **F3.** A message that trips a bundled skill's trigger term inlines that skill's whole body into the `skill-instructions` section of the STABLE half (`server/skill-library.ts:selectBundledSkills`, rendered at dispatch). The Claude driver keys its live process on the stable half, so the turn respawns the CLI and the whole conversation is re-uploaded at the cache-write rate; the next turn without the term respawns again.
2. **Per-thread paths.** The `files` section (`workspaceLocationsPrompt`) names the task's working folder, which for a bot without a configured project folder is its per-thread task workspace. Every new thread therefore has a different stable prefix from the first byte of that section on.
3. **No project channel for most engines.** Codex reads a folder's `AGENTS.md` natively and Claude Code reads `CLAUDE.md`; pi, the ACP family and the HTTP family read neither, so a project's standing instructions reach only two of six engine families.

Two items from the plan close as measured: the prefix audit (nothing in the stable sections carries a date or a live counter; the only per-turn facts already sit in the volatile `mentions` and `outstanding` sections), and F5's measurement gate.

## What earlier PRs taught (`AGENTS.md` rule 2)

- **#1243 (open, this account, Phase 0 part 2):** the stable/volatile split and the live-CLI reuse this part protects; `stablePrefixChanges` is the metric it added.
- **#1272 (open, Phase 1 part 1):** `sessionReset` for a deliberate fresh session; part 3 must never trigger one by accident.
- **#1275 (merged): `OMB_CLAUDE_INHERIT_USER_CONFIG`.** Claude's personal `CLAUDE.md` is deliberately not inherited unless that flag is set; part 3's project channel is the folder's `AGENTS.md`, never the person's home config, so the two do not overlap.
- No open or closed PR moves skill bodies or the file-locations block; searched `skills prompt`, `AGENTS.md`, `system prompt cache`.

## Decision

1. **Skill bodies travel in the turn text (F3).** `selectBundledSkills` keeps choosing by trigger term, but the rendered `<openmaus-skill>` blocks are appended to the turn text of that turn (after the recall block, before the message) instead of the system prompt. The `skill-instructions` section of the system prompt becomes empty on every turn; the skills index line (`skills` section, which lists names and descriptions) stays where it is. **Gate (decision 20):** a scorecard task that needs a bundled skill exists first: T7 runs with `OMB_SKILLS_DIR` pointing at a fixture skill whose instructions are verifiable ("when the person says zorblat, begin the reply with the word quantum-elk"), asked in a message that trips its trigger. Correct on the branch when the reply begins with the word; on main the same task passes today, so the gate is "still passes".
2. **Per-thread paths leave the stable half.** `workspaceLocationsPrompt` splits: the bot-level paths (shared bot folder, other-thread files folder, configured project folder) stay in the stable `files` section; the current working folder moves to a `folder` section that is added to `VOLATILE_SECTIONS`. A volatile section is re-sent to a live process only when it changes, which for a folder is once per thread, and it never enters the process key. Room turns and the preview follow the same split.
3. **`AGENTS.md` as the project channel.** When the task's working folder holds an `AGENTS.md`, its first 16 KB are added as a `project` section of the stable half ("Standing instructions from the project's AGENTS.md; a person wrote them for whoever works in this folder"), for every engine that does not read the file natively: Claude Code, pi, the ACP family, the HTTP family, the box agent. Codex is skipped (it reads `AGENTS.md` itself; injecting it twice would contradict itself on precedence). `CLAUDE.md` is untouched: Claude Code keeps reading it natively and the harness never copies it, so a project that keeps both gets `AGENTS.md` from the harness and `CLAUDE.md` from the engine, which is the "Claude-specific addition on top" the plan asks for. The section is stable per folder; a folder change is a thread change. Preview shows it. Secrets are redacted on the way in like every other file the harness reads into a prompt. **Gate:** T8, a folder whose `AGENTS.md` says "end every reply with the word ZEBRA"; correct when the reply ends with it, on every engine (Codex natively).
4. **Prefix audit, closed by a test.** A unit test renders the system prompt for one bot on two threads and on two turns of one thread (one with a skill trigger) and asserts the stable half is byte-identical. `stablePrefixChanges` on T2 and T5 must read 0; the scorecard prints it.
5. **F5's gate, closed by measurement.** T9: in a folder that is a git repository with a long history, "run exactly `git log` with no flags, then tell me the newest commit's subject" — once on a bot with `commandFilters: false` and once with `true`. The two rows' input tokens and the `filteredCommands` count are the measurement. The default stays off unless the filtered run is cheaper and still correct; the number goes in the plan either way.

## Non-goals

Moving `MEMORY.md` out of the volatile half. Trimming Claude Code's own 43k prompt (not ours). Changing what the skills index says. Deferred tool loading (Phase 2). Compaction of any kind (part 1).

## Engines

| Item | Claude Code | Codex | pi | ACP family | HTTP family | Box agent |
| --- | --- | --- | --- | --- | --- | --- |
| skill bodies in the turn text | full (and the reason: no respawn) | full | full | full | full | full |
| folder as a volatile section | full (no respawn on a new thread) | full (developer instructions resync on change, as for memory) | full | full | full | full |
| `AGENTS.md` project section | full (harness) | native (skipped by the harness) | full (harness) | full (harness) | full (harness) | full (harness; box folders read through the same path when the task folder is local) |
| command-filter measurement | measured (hooks) | n/a (no pre-tool hook) | n/a | n/a | n/a | n/a |

## Failure boundaries

A missing or unreadable `AGENTS.md` is an absent section. A skill body that does not fit the turn is cut at 24 KB with a note, never dropped silently. None of this touches the transcript store or the replay.

## Testing

- Unit: `system-prompt.test.ts` (stable half byte-identical across threads and across a skill trigger; `folder` volatile; `project` present for non-Codex, absent for Codex), `workspace.test.ts` (split of `workspaceLocationsPrompt`), `project-instructions.test.ts` (read, cap, redact, absent).
- E2E: the hooks e2e's live-process assertion extended: a second turn whose text trips a skill trigger reuses the Claude process (pid unchanged) and its prompt dump carries the skill block in the turn text.
- Scorecard: T7 (skill fixture), T8 (`AGENTS.md`), T9 (filters on/off), plus T1–T6 and the recall set unchanged; `stablePrefixChanges` printed per task.

## Acceptance

`stablePrefixChanges` 0 on T2 and T5; T7 and T8 correct on the branch on Claude and Codex; T1–T6 and the recall set unchanged; a Claude thread whose message trips a skill keeps its process; the F5 number recorded; all checks green.
