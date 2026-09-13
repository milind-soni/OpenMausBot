# Coordination regression coverage

Ordinary chats use `coordinate_bots`: the source finishes its provider turn,
the harness dispatches a pinned recipient task, and the result resumes the
source conversation. `ask_bot`, `delegate_bot` and teammate `start_thread`
remain on the separate legacy completion path used by routines. Ordinary
direct user turns can open bounded self-owned jobs with `start_thread`, as
restored by upstream #1166. Coordinated child turns cannot recursively open
self-owned jobs, and ordinary teammate handoffs use `coordinate_bots`.

The former ordinary-chat tests still called those hidden legacy tools. This
migration originally kept all 25 cases together (9 pure tests and 16 server/MCP
tests). After upstream #1166, `server/comms.test.ts` retains the upstream pure
and actual-routine legacy tests, including removed-tool protocol errors.
`server/coordination-acp.e2e.test.ts` retains the 16 ordinary ACP coordination
cases separately. Shared fixture code replaces repeated setup and polling;
no behavioral scenario is removed or skipped. The 15 changed scenarios map as follows:

| Previous scenario | Current contract and retained checks |
| --- | --- |
| ACP synchronous question and reply | Real injected MCP request; actual recipient result in resumed context; sender/recipient attribution; linked request/result receipts; recipient's old conversation unchanged |
| Gemini/Antigravity peer call | Real temporary ACP MCP mount and result return; no global Gemini MCP configuration written |
| Chief creates and delegates to an operator | Actual `create_bot`; same section/model; no Chief, automatic approval or connected-app privilege; actual subsequent addressed work |
| Asynchronous handoff after source settles | Child stays queued until source provider finishes; exactly one request and result receipt; source resumes on its original task |
| Chief stays available while peer works | A separate Chief task answers while the recipient runs; returned report reaches only the original task |
| Busy peer fallback | Work queues into a separate recipient task; its current conversation and output are preserved |
| Busy fallback across provider reload | Approved queued work completes after reload; no second approval or duplicate delivery |
| Synchronous timeout converts to durable work | Coordinated work outlives the old ask timeout; actual late result returns once |
| Empty successful reply | Completed child and successful terminal receipt, even without text |
| Provider reload interrupts work | Running child reaches a failed/cancelled terminal state; failure reaches the resumed source context |
| Crashed peer | Failed child, failed receipt and failure details in resumed source context |
| Target cannot start | Deleting a queued recipient prevents execution and recreation of its task |
| Allow contact | Real approval card and exact authorization key; no recipient execution before Allow; exactly one execution and approval |
| Deny contact | Actual MCP error; no recipient task created or provider started |
| One-hop recursion guard | Bounded multi-hop work succeeds; return to an ancestor is rejected; legacy tools remain hidden from coordinated child turns |

`server/independent-threads-api.test.ts` retains its actual provider approval
socket and verifies waiting, one delivery, a separate recipient task, and
automatic return through coordination. `server/peer-allowlist.e2e.test.ts`
asserts the current prompt's restriction on granting access, impersonating
peers and creating bots; all existing endpoint/allow-list checks remain.

`server/routine-delegation.e2e.test.ts` keeps all eight cases. A new human
request in a finished routine's execution thread now uses coordination and
must not alter that routine's recorded output or completion timestamp.

`server/thread-aware-bots.e2e.test.ts` retains upstream's nine cases for
self-owned ordinary jobs and coordinated teammate work. The separate
`server/legacy-thread-tools.e2e.test.ts` retains ten legacy admission,
concurrency, approval, notification, deletion and visibility cases. Before
testing retained legacy endpoints with its existing scoped-capability fixture,
it verifies that a real ordinary-chat capability cannot create a legacy
teammate thread. An additional case obtains a **real routine provider capability**,
verifies `start_thread` delivery and result return, and verifies that the
routine cannot invoke `coordinate_bots`. The synthetic capability does not
replace this real mode-boundary check.

The fake ACP adapter calls the real agents MCP subprocess from its supplied
entry, including its turn-scoped credentials. It reuses the existing scripted
coordination provider, rather than synthesizing successful tool responses.
It also retains updated MCP entries on ACP session load/resume, so subsequent
user turns exercise the fresh capability. All files and processes belong to
disposable fixture homes.

Run the migrated cases with:

```sh
pnpm exec vitest run server/comms.test.ts server/coordination-acp.e2e.test.ts server/legacy-thread-tools.e2e.test.ts server/independent-threads-api.test.ts server/peer-allowlist.e2e.test.ts server/routine-delegation.e2e.test.ts server/thread-aware-bots.e2e.test.ts
```

The scheduler's depth, request and execution budgets remain covered by
`server/room-handoffs.test.ts`; ordinary direct coordination, permission
revocation and cancellation remain covered by
`server/direct-coordination.e2e.test.ts`. Run these and the ACP driver contract
alongside the migrated cases, then run the normal full CI including broker,
Electron, packaged-server and native smoke stages. Do not treat a focused
pass as a successful full suite.
