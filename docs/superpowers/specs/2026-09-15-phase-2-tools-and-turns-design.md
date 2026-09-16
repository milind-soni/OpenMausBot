# Phase 2, parts 3 and 4: tools, and turns that run unattended — built and deferred

Status: built overnight Sep 15–16, 2026 on `phase-2/tools`, stacked on part 2. This document says which of the plan's items are built, with the file that proves each, and which are deferred with the reason, so nothing reads as built that is not.

## Part 3 · tools

| Item | State | Where |
| --- | --- | --- |
| **Deferred tool loading:** a small core plus `search_tools` and `use_tool`; every other tool found by what it does and called by name, on every engine, no dependence on `tools/list_changed` | built, behind `tools.deferred` (off by default) | `server/drivers/agents-proxy.ts` (`TOOLS_DEFERRED`, `searchTools`), config `tools.deferred`, env `OMB_TOOLS_DEFERRED`; proxy suite "deferred tool loading" |
| The tool ladder (`need_tool`: use / connect / find / build, proposals with a hash-bound approval, remote servers written inert) | deferred: #1009 stays its own PR. Its first commit conflicts in four files on this chain, two of them UI (`ChatView.tsx`, `state/store.tsx`); rebasing it is a task of its own, not a side effect of part 3 | #1009 |
| Composio through meta-tools with the connect-link loop; the gap detector | deferred with the ladder (they are rungs 2 and 3 of it) | #1009 |
| **Remote HTTP MCP servers** behind Test-then-enable with the rug-pull hash | **landed on main as #1297 (Sep 15) on the transport side**; the Test-then-enable + hash check part stays open (Phase 3 tail). Original reason for deferring: custom MCP servers are stdio-only through the registry (`mcp-registry.ts`), the probe (`mcp-probe.ts`) and every driver's mount (`customMcpServers` skips `url` entries). Adding the transport means a per-driver change in Claude, Codex, pi, the ACP family and the box path, each to be verified on a real server; not a change to make unmeasured overnight | `server/config.ts:customMcpServers` states the skip |
| Per-connector "where it runs, where data travels" | deferred with the policy chain (carried from Phase 0) | — |
| The five-section description contract, linted | partly: the four tools added in Phase 2 (`tool_result_read`, `search_tools`, `use_tool`, and `task_create`'s new fields) are written to it; the lint over every tool waits for the ladder's rebase so descriptions are not rewritten twice | proxy tool descriptions |

## Part 4 · turns that ask and run unattended

| Item | State | Where |
| --- | --- | --- |
| **The unattended rule as prompt text** (decision 13): no clarifying questions, the most reversible reading named, stop with a short failure summary when a sign-in, file, tool or permission is missing | built | `server/system-prompt.ts:ROUTINE_EXECUTION_PROMPT` |
| **Mention tokens** `@name [[omb:type:id]]` in routine instructions and delegation briefs, resolved at run time to one line each with the id | built | `server/mentions.ts` (+ test), `RoutineManagerOptions.resolveMentions`, the delegate-bot route |
| **Run record fields for routines:** a skipped occurrence is counted on the routine (`skippedRuns`, `lastSkippedAt`) under the default overlap policy rather than written as a run row, so a five-minute routine cannot flood the run log; `overlap: "queue"` per routine lets the next run wait instead; `failureStreak` on the routine, cleared by a completed run; the prompt snapshot per run already existed (`RoutineRun.prompt`) | built | `server/routines.ts` (+ tests) |
| `cancel_requested` and `dead_letter` run states | deferred: `cancelled` exists and is set when the interrupt lands; a `cancel_requested` interim needs the interrupt path's own bookkeeping, and `dead_letter` (a routine paused after N failures) is a policy the person should set, which belongs with the board view | — |
| **Package export keeps the engine preference** (§16c) | built for export and the manifest; applying it at import waits for the team-setup flow that creates bots from a manifest | `server/package-export.ts`, `server/bot-package.ts`, `server/team-manifest.ts` |
| Structured `ask_user` with named options and a typed answer; the availability flag | deferred: there is no harness `ask_user` tool today (Codex has its own, #1250 refuses multi-question asks); the option card exists (`OptionCard`, `fixedOptions` from #1184) and is the surface to build it on, with the availability flag deciding assume-and-note versus block | #1184's card, #1250 |
| F4's native structured-output accelerators | deferred, as Phase 0's F4 said: after typed turns are the common case and metrics can show the saving | Phase 0 plan, F4 |

## Every engine

Everything built here is harness-side: the proxy (every engine mounts the same proxy), prompt text, routine records, the export. Full on every engine; nothing degraded.

## Testing

Proxy suite (deferred loading, the bounds, the cap), `mentions.test.ts`, `routines.test.ts` (mention resolution at run time; overlap, skipped runs and the failure streak), `package-export.test.ts` (the engine preference), typecheck, lint, i18n; the scorecard unchanged because every switch is off by default.
