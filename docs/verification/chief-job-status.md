# Current Chief job status

The footer reads `/api/threads/:id/job?since=0`. Its `current` summary is
the most recent visible source job on the selected transcript branch,
computed before node clipping. Aggregate job status remains available for
existing wait clients. Saved cancellation receipts remain in the transcript;
they do not determine the current job's status.

The mounted footer revalidates after a branch change, reconnect, focus or
receipt update. While native source jobs remain active it uses the API's
bounded version wait, with an abort signal tied to the mounted conversation.
Settled views stop waiting. These reads invoke no model and start no job.

Native uncertainty is reported separately by source job. A historical partial
receipt stays visible as a past report; it cannot establish current process
state. Cancel actions retain exact native root IDs for overlapping work.

## Isolated verification

Run on the eligible execution worker with repository dependencies installed:

```sh
pnpm exec vitest run src/components/ChiefJobCancel.test.ts \
  src/components/ChiefJobCancel.status.test.ts server/job-view.test.ts \
  server/routes/jobs.test.ts
OMB_UI_E2E=1 pnpm exec vitest run server/job-cancellation-api.test.ts
```

The browser case launches a temporary fake-engine server, private browser
home and real renderer. It cancels an older source job while a newer source
job runs, verifies the newer running status, completes it, reloads the page,
and checks that the completed status returns while the old receipt persists.
It retains screenshots, API evidence and console output at the paths printed
by the test. The fixture closes its browser, preview and server in `finally`.

On a Linux fixture host without usable Chrome sandbox support,
`OMB_UI_NO_SANDBOX=1` applies only to the disposable test browser. It changes
no deployed browser, worker or application permission.

Component cases cover fresh mount, active and completed transitions, partial
history, native uncertainty outside loaded history, reconnect/focus, stale
thread responses and cancellation races. API cases cover active-path
selection, source visibility, clipping and held-read version changes.


## Task disposition and legacy rows

An engine turn can finish while its requested action remains blocked. The existing
assignment JSON stores an explicit `disposition` of `{ state: "completed" }` or
`{ state: "blocked", reason: string }` separately from lifecycle status and engine
outcome. `HostTurnResult`, `EndResult` and completed `RunResult` accept that union.
Store validation retains it after restart. No second task store or history rewrite
is involved. A successful engine turn alone never records a task disposition.

All ordinary first root, resumed root, direct delegated and room prompt builds
include the same Task outcome reporting system section. Text-only engines finish
a final report with one column-zero terminal line, after a blank line if human
prose precedes it:

```text
OPENMAUS_TASK_RESULT: {"state":"completed"}
```

or:

```text
OPENMAUS_TASK_RESULT: {"state":"blocked","reason":"Missing authenticated publication tool"}
```

These are protocol examples in documentation, not task reports. The parser accepts
only one terminal assertion of at most 1200 characters, strict JSON with exactly
the indicated keys in the shown order, no duplicate keys, no trailing text, no fence, quote or indentation, and a nonempty single-line reason of at most
1000 characters (the existing runtime bounds its stored detail). A final newline is
allowed. The marker must occupy its own paragraph. Quoted/fenced/embedded examples,
nonterminal lines, multiple markers, unknown states and extra keys are rejected.
Hypothetical or example text must never emit an unquoted terminal assertion: a
syntactically valid terminal assertion is an explicit claim by the producer, not
independent proof. The parser does not classify the preceding prose or verify
external actions. The previous whole-reply `BLOCKED: reason` form remains supported.
A question uses existing cards/terminal `NEEDS INPUT:` instead. Provider failures
still fail the turn; no keyword guessing translates errors into task outcomes.

Untyped historical rows remain unmodified. Their completed engine lifecycle stays
completed, and `current.legacyTaskOutcome` survives store/server restart and reload
with source identity. The primary footer says "Engine turn finished. Task outcome
unrecorded and unverified." It never says "Job completed" for an untyped legacy
completion. Historical publishing prose is not reclassified. Explicit new completion
renders "Job completed." Older history cannot replace the selected newer request.

Current job selection uses the selected transcript's request order, including
out-of-order job creation, before clipping. A delegated assignment is eligible in
its own visible destination thread. Completed parents with unresolved awaited
children remain running/needs-input; child blockers and failures prevent a green
job result. An explicit rework supersedes only an exact task identity (same parent,
assignee destination, mode and brief), matching runtime deduplication; unrelated
failures are retained. Raw historical nodes and counts remain available, but the
current footer uses only its selected job. Waiting parents owe continuation.

The isolated cancellation fixture also captures native delegated cancelled status,
blocked status, restart/reload persistence, and a newer success after restart.
It uses only the existing `control:omb` fixture, fake engines and real renderer;
it does not test an external GitHub provider or alter any live data.


The shared `shared/job-state.ts` terminal contract also ends MCP waits and headless
`events --until-settled` on blocked/cancelled. A previously observed version still
waits for a change. Events exits 3 for blocked (action/input needed), 130 for
cancelled, and retains its existing failed/completed exit codes.


## Full conversation status and unrecorded tools

The current-job footer is visible in every authorized bot conversation, including delegated non-Chief threads and read-only viewers. Cancellation buttons still require a Chief, write permission, and an exact current source-job identity. The existing native API owns the current job; older cancellation receipts remain historical warnings.

Tool calls without a terminal receipt are running only while they belong to the displayed thread's recorded live turn start. A tool from an earlier turn displays “Result/status unrecorded and unverified.” This presentation does not change its raw messages or claim completion, cancellation, or an OS process stop. Inspector uses the selected task's runtime state, matching ChatView, rather than the profile's aggregate busy state.

Run `server/full-thread-status.test.ts` through the existing native verification harness with cached agent-browser and Chrome. It serves the production `dist` bundle from the disposable fake-engine server, opens the normal application, follows a real delegated thread link, and retains screenshots, DOM, API receipts and console output. Its synthetic provider emits an unfinished tool call before a gate; cancellation leaves that call without a terminal result. A newer gated turn proves the old call stays unverified while the new call remains live. The read-only browser case substitutes a synthetic cloud-guest session response solely in the fixture browser; backend authorization remains covered separately by the existing runtime/API checks.
