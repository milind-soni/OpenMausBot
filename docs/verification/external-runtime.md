# External runtimes

Run against disposable servers and repository-owned fake engines only:

```sh
pnpm exec vitest run server/external-runtime.test.ts server/external-runtime.e2e.test.ts server/external-runtime-timeout.e2e.test.ts
pnpm exec vitest run server/runtime-paths.e2e.test.ts -t "external runtime"
pnpm exec vitest run server/comms.test.ts server/routine-delegation.e2e.test.ts server/drivers/agents-proxy.test.ts
pnpm exec vitest run server/workspace-backup-policy.test.ts server/workspace-backup.test.ts
```

An external runtime is a bot's engine the server did not spawn (a Hermes
gateway, a Slack bot, an OpenClaw session) holding a standing agents
capability from `external-runtimes.json` for one pinned thread
(docs/self-hosting.md, "A bot that also runs outside the server"). It drives
the bundled MCP stdio bridge, `server/drivers/agents-proxy.ts`, with
`OMB_EXTERNAL_RUNTIME=1`. The bridge offers the one tool surface every turn
gets (docs/runtime-contract.md §9): `coordinate_bots` (work, or a question
with `consult: true`, or a one-way notice with `reply: "none"`) and the
read-only `assignment_status`. The server accepts only `GET /api/internal/agents`,
`POST /api/internal/coordinate-bots` and `GET /api/internal/assignment-status`
with that capability; every other internal route answers 403.

Each `coordinate_bots` call from a standing capability is its own root on the
job runtime: requester `external_runtime` (run id `external-runtime:<bot>:<thread>`),
origin `outside/external_runtime`, `reply: poll` on the root and its children.
The root is settled as the call returns and completes, without a turn, once
the children settle; the teammate's envelope says its reply waits in the
requester's inbox (§4). The runtime reads results with `assignment_status`,
long-polling `wait_ms` (at most 240 s) on the root (`rootId` in the answer) or
on a child (`requestId` in a receipt); a read of the root marks its inbox
lanes delivered, and a second read shows `deliveredAt`. Nothing wakes the
bot's own engine on the pinned thread.

The end-to-end fixtures use `launchVerificationServer`, a fresh home/data
directory and the fake Claude engine. They prove:

- Unknown/replaced credentials and impersonated bot/thread/depth claims fail.
- A revoked slow-body request cannot start a teammate.
- Explicit thread bindings survive sidebar selection; deleted or foreign
  bindings fail instead of adopting another conversation.
- The real MCP stdio bridge can list, hand work on and read its result from
  the same long-running process, through `coordinate_bots` and
  `assignment_status`. Other internal routes remain unavailable.
- Busy-target hand-offs queue on the runtime without needing a source turn;
  a free slot admits them once. Human approval remains required where
  configured, asked before anything is written, and never twice.
- `assignment_status` withholds a result when peer access was revoked
  meanwhile, refuses another conversation's assignment, and answers 404 for an
  unknown id.
- A handed-off turn that finishes, fails or expires before it starts never
  starts a turn on the bot's own engine in the pinned thread.
- Backup export omits credentials, restore preserves destination credentials,
  and archives containing those credential paths are rejected.

The shared fixture retains its server log; the main fixture prints an adjacent
`.external-runtime.json` request/status record. The busy fixture retains
`.external-busy.json` with queue states and bounded synthetic transcripts.
Cleanup stops only owned processes and removes only their temporary data.

This proves the local server and bundled bridge, not a live Hermes/Slack/Telegram
deployment, real provider billing, or remote network reachability. An operator
must configure the external client with the same pinned thread and a private
token; the feature does not provision that client or sync its filesystem.
