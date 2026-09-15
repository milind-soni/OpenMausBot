# Scorecard record — Phase 1 parts 2 and 3 (recall, prefix fixes), main vs branch

Date: 2026-09-15 (evening). Engine: Claude Code (live, subscription), Codex for T4. Harnesses started standalone
(`docs/verification/harness-scorecard.md`), main on port 28813 from a worktree at upstream `4005d09f`,
the branch (`phase-1/recall`, parts 1–3 stacked) on port 28811, run one after the other. Both with
`OMB_SKILLS_DIR=server/testing/skills` for T7; the branch with `recall.captures: false` (F14). T5 was not
rerun (part 1's record stands; nothing in parts 2–3 touches a single long thread: the current thread
is excluded from recall and a one-bot-one-thread scorecard has no other thread to recall from).

## The numbers that matter

| Measure | main | branch |
| --- | --- | --- |
| Recall set, passed (24 cases, no tools on the asking turn) | 16/24 | **23/24** |
| by kind: conversation / memory / log / corrected / mixed / distractor / negative | 5/10 · 4/5 · 0/1 · 3/3 · 1/1 · 1/2 · 2/2 | 9/10 · 5/5 · 1/1 · 3/3 · 1/1 · 2/2 · 2/2 |
| asking turns that used a tool | 0 | 0 |
| input on the asking turn (typical) | ≈43,850 | ≈44,200 (the block: 300–600 tokens) |
| T6 recall (told in one thread, asked in a new one) | correct | correct, chip "recalled …", 1 step (the chip) |
| T7 bundled skill: reply begins with the skill's word; second turn keeps the process | yes / yes | yes / yes |
| T8 a folder's `AGENTS.md` obeyed (Claude) | **no** | **yes** |
| T9 command filter: input off → on | 90,095 → 90,116 (filter absent on main) | 92,368 → 98,265 (no saving on this task; default stays off) |
| stable prompt sections changed between turns | none | none |
| T1–T4 | all correct | all correct; tokens within noise (T1 132,486 vs 131,895; T2 turn 3 44,303 vs 43,758; T3 89,165 vs 88,670) |

What the two recall-set failures on the branch are: `told-two-turns` (finding F12: "the trip is to
Lisbon" versus "where am I travelling" share no word; the lexical gap §11b says to measure before any
embedding work) and, on the first branch run, `told-name` (one distinctive word, "dog", dropped by the
two-term rule; fixed by dropping how-to-answer words from the terms instead, F15, and rerun below).

## Recall set, main (16/24)

main (claude) — recall set
| Case | Kind | Pass | Wall s | In | Steps | Recalled | Used | Reply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| told-hint | conversation | yes | 4.6 | 43,778 | 0 | — | — | blue-falcon-42 |
| told-name | conversation | NO | 7.6 | 43,739 | 0 | — | — | I don't have any record of your dog's breed or name. |
| told-port | conversation | yes | 2.3 | 43,847 | 0 | — | — | 8443 |
| told-preference | conversation | yes | 3.1 | 43,870 | 0 | — | — | pnpm, tabs. |
| told-deadline | conversation | yes | 3.8 | 43,891 | 0 | — | — | Friday, 2026-09-19. |
| told-two-turns | conversation | NO | 6.0 | 43,784 | 0 | — | — | I don't have any travel details in this conversation to answ |
| told-code-fact | conversation | NO | 9.2 | 43,817 | 0 | — | — | I can't determine that without inspecting the repo, and you' |
| told-person | conversation | NO | 7.6 | 43,812 | 0 | — | — | I don't have that information — no name for onboarding scree |
| told-decision | conversation | yes | 3.0 | 43,928 | 0 | — | — | settings_v2 |
| told-number-list | conversation | NO | 7.6 | 43,805 | 0 | — | — | I don't have any prior context specifying launch markets in  |
| memory-db-name | memory | yes | 3.0 | 43,842 | 0 | — | — | moonbase |
| memory-style | memory | yes | 7.6 | 43,863 | 0 | — | — | One line, imperative mood, no emoji. |
| memory-topic-pointer | memory | NO | 6.8 | 43,875 | 0 | — | — | I only have a pointer to that checklist (memory/release.md), |
| memory-contact | memory | yes | 3.1 | 43,895 | 0 | — | — | 4471 |
| memory-two-facts | memory | yes | 3.1 | 43,861 | 0 | — | — | #1F4FD8 |
| memory-log-event | log | NO | 3.0 | 43,857 | 0 | — | — | I have no record of a 2.3.1 release or rollback for this pro |
| corrected-fact | corrected | yes | 3.0 | 43,881 | 0 | — | — | Vega |
| corrected-port | corrected | yes | 3.0 | 43,923 | 0 | — | — | 3100 |
| memory-then-told | corrected | yes | 3.0 | 43,975 | 0 | — | — | buildbox-2 |
| mixed-sources | mixed | yes | 3.8 | 43,945 | 0 | — | — | The staging database is called moonbase, and its backup runs |
| distractor-similar | distractor | yes | 3.1 | 43,951 | 0 | — | — | moonbase |
| distractor-many | distractor | NO | 9.1 | 43,878 | 0 | — | — | I don't have a parking code stored anywhere for you — nothin |
| negative-unknown | negative | yes | 3.0 | 43,982 | 0 | — | — | I don't know. |
| negative-empty | negative | yes | 3.0 | 43,816 | 0 | — | — | I don't know. |

passed 16/24; by kind: conversation 5/10, memory 4/5, log 0/1, corrected 3/3, mixed 1/1, distractor 1/2, negative 2/2; asking turns with tools 0

## Recall set, branch (after F15's second tuning)

recall-branch2 (claude) — recall set
| Case | Kind | Pass | Wall s | In | Steps | Recalled | Used | Reply |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| told-hint | conversation | yes | 3.8 | 44,160 | 0 | 0n 1c 0x | 1 | blue-falcon-42 |
| told-name | conversation | yes | 3.0 | 44,262 | 0 | 0n 2c 0x | 1 | Biscuit is a beagle. |
| told-port | conversation | yes | 3.8 | 44,182 | 0 | 0n 1c 0x | 1 | 8443 |
| told-preference | conversation | yes | 3.1 | 44,341 | 0 | 1n 1c 0x | 2 | pnpm, tabs. |
| told-deadline | conversation | yes | 3.0 | 44,177 | 0 | 0n 1c 0x | 1 | Friday the 19th (2026-09-19). |
| told-two-turns | conversation | NO | 3.8 | 43,970 | 0 | — | — | I don't have any prior information about your travel plans — |
| told-code-fact | conversation | yes | 4.5 | 44,173 | 0 | 0n 1c 0x | 1 | API routes live under server/routes, with the database helpe |
| told-person | conversation | yes | 3.0 | 44,163 | 0 | 0n 1c 0x | 1 | Priya |
| told-decision | conversation | yes | 2.3 | 44,215 | 0 | 0n 1c 0x | 1 | settings_v2 |
| told-number-list | conversation | yes | 3.0 | 44,193 | 0 | 0n 1c 0x | 1 | Germany, Brazil, and Japan. |
| memory-db-name | memory | yes | 3.0 | 44,243 | 0 | 1n 0c 0x | 1 | moonbase |
| memory-style | memory | yes | 3.1 | 44,303 | 0 | 1n 1c 0x | 1 | Imperative mood, no emoji. |
| memory-topic-pointer | memory | yes | 3.0 | 44,284 | 0 | 2n 0c 0x | 2 | Tag as v-<version>. |
| memory-contact | memory | yes | 4.6 | 44,245 | 0 | 1n 0c 0x | 1 | 4471 |
| memory-two-facts | memory | yes | 5.3 | 44,271 | 0 | 1n 0c 0x | 1 | #1F4FD8 |
| memory-log-event | log | yes | 3.8 | 44,197 | 0 | 1n 0c 0x | 1 | The login regression. |
| corrected-fact | corrected | yes | 3.1 | 44,431 | 0 | 1n 2c 0x | 2 | Vega |
| corrected-port | corrected | yes | 3.1 | 44,499 | 0 | 1n 3c 0x | 2 | 3100 |
| memory-then-told | corrected | yes | 3.1 | 44,475 | 0 | 1n 1c 0x | 2 | buildbox-2 |
| mixed-sources | mixed | yes | 4.0 | 44,312 | 0 | 1n 1c 0x | 2 | Staging database is moonbase, with backups running every Tue |
| distractor-similar | distractor | yes | 3.8 | 44,233 | 0 | 0n 2c 0x | 1 | Moonbase |
| distractor-many | distractor | yes | 3.8 | 44,194 | 0 | 0n 1c 0x | 1 | 7781 |
| negative-unknown | negative | yes | 4.6 | 44,002 | 0 | — | — | I don't know. |
| negative-empty | negative | yes | 3.8 | 44,039 | 0 | — | — | I don't know. |

passed 23/24; by kind: conversation 9/10, memory 5/5, log 1/1, corrected 3/3, mixed 1/1, distractor 2/2, negative 2/2; asking turns with tools 0

## Scorecard rows, main

| Task | Turn | Engine | Wall s | In | Cached | Steps | Correct |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T1 file-task | 1 | claude | 8.3 | 131,895 | 87,667 | 2 | yes |
| T2 follow-ups | 1 | claude | 3.8 | 43,634 | 0 | 0 | yes |
| T2 follow-ups | 2 | claude | 3.8 | 43,695 | 43,632 | 0 | yes |
| T2 follow-ups | 3 | claude | 3.0 | 43,758 | 43,693 | 0 | yes |
| T3 big-output | 1 | claude | 14.3 | 88,670 | 43,735 | 1 | yes |
| T6 recall | 1 | claude | 4.5 | 87,625 | 43,673 | 1 | yes |
| T6 recall | 2 | claude | 3.8 | 43,739 | 31,326 | 0 | yes |
| T7 skill | 1 | claude | 7.6 | 43,655 | 0 | 0 | no |
| T7 skill | 2 | claude | 3.8 | 43,980 | 43,653 | 0 | yes |
| T8 agents-md | 1 | claude | 3.0 | 43,070 | 0 | 0 | no |
| T9 filter-off | 1 | claude | 6.0 | 89,814 | 44,345 | 1 | yes |
| T9 filter-on | 1 | claude | 6.8 | 89,806 | 44,342 | 1 | yes |
| T4 engine-switch | 1 | codex | 9.8 | 22,371 | 12,032 | 0 | yes |
| T7 skill | 1 | claude | 3.8 | 43,992 | 0 | 0 | yes |
| T7 skill | 2 | claude | 3.0 | 44,200 | 43,990 | 0 | yes |
| T8 agents-md | 1 | claude | 3.0 | 43,234 | 0 | 0 | no |
| T9 filter-off | 1 | claude | 6.0 | 90,095 | 44,458 | 1 | yes |
| T9 filter-on | 1 | claude | 6.1 | 90,116 | 44,469 | 1 | yes |

## Scorecard rows, branch

| Task | Turn | Engine | Wall s | In | Cached | Steps | Correct |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T1 file-task | 1 | claude | 14.3 | 132,486 | 88,009 | 2 | yes |
| T2 follow-ups | 1 | claude | 9.1 | 43,699 | 0 | 0 | yes |
| T2 follow-ups | 2 | claude | 3.0 | 44,240 | 43,697 | 1 | yes |
| T2 follow-ups | 3 | claude | 3.0 | 44,303 | 44,238 | 0 | yes |
| T3 big-output | 1 | claude | 13.6 | 89,165 | 44,049 | 2 | yes |
| T4 engine-switch | 1 | codex | 8.3 | 22,528 | 12,032 | 1 | yes |
| T6 recall | 1 | claude | 3.0 | 43,921 | 0 | 0 | yes |
| T6 recall | 2 | claude | 3.0 | 44,161 | 31,418 | 1 | yes |
| T7 skill | 1 | claude | 6.1 | 44,169 | 0 | 0 | yes |
| T7 skill | 2 | claude | 1.5 | 44,473 | 44,167 | 0 | yes |
| T8 agents-md | 1 | claude | 4.5 | 43,525 | 0 | 0 | yes |
| T9 filter-off | 1 | claude | 7.6 | 92,368 | 45,599 | 1 | yes |
| T9 filter-on | 1 | claude | 6.8 | 98,265 | 45,560 | 1 | yes |

## T10 — a standing rule across a compaction (part 4, goal recitation)

Twelve turns of T5's growing file, with "begin every reply with the word LANTERN" given at turn one.
Correct = the reply starts with LANTERN and gives the count. Three runs, one after the other:

| Run | Kept the rule | Compactions (input drops) | Input at turn 12 |
| --- | --- | --- | --- |
| branch, recitation on | **12/12** | turn 9 (128k → 96k) | 131,580 |
| branch, recitation off (`context.recite: false`) | 11/12 — lost the rule at turn 12, the turn right after the second compaction (127k → 97k) | turns 8 and 12 | 96,979 |
| main (no compaction) | 12/12 | none; input climbs to 173,949 | 173,949 |

This is the case recitation exists for: after a compaction the rule lives only inside the summary,
and the second time round the model dropped it. With the first request restated in the turn text
after every compaction, all twelve replies kept it, at the cost of about 60 tokens on those turns.
Main keeps the rule only because it never compacts, and pays 174k input by turn 12.

## Reading the numbers honestly

- The recall set is where parts 2–3 show: eight more cases answered from the bot's own notes and
  conversations with no tool call, at about 400 extra input tokens on the asking turn. Main's bot never
  called `session_search` on its own in 24 tries; the block is what makes the earlier conversation
  reachable.
- T8 is a capability main does not have on Claude (Claude Code reads `CLAUDE.md`, not `AGENTS.md`).
- T9 closes F5's measurement gate against the branch's own filter: on an unbounded `git log` the
  filtered turn cost more, not less (Claude Code already truncates long tool output; the rewrite note
  and the bounded log added tokens). The filter stays off by default; the number is recorded.
- T7 on main passes too: the skill reached the model through the system prompt there. The branch's
  gain is not correctness but that the second turn keeps the live process and no stable section moved;
  the scorecard's last line says "none" on both because neither run's second turn carried a trigger.
  The prefix e2e (`server/prefix.e2e.test.ts`) proves the pid is unchanged on the fake.
- Wall times ran with the full vitest suite in the background on the same machine; they are not the
  measure here.
