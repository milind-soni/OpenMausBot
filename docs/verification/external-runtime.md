# External runtimes

Run against disposable servers and repository-owned fake engines only:

```sh
pnpm exec vitest run server/external-runtime.test.ts server/external-runtime.e2e.test.ts server/external-runtime-busy.e2e.test.ts
pnpm exec vitest run server/comms.test.ts server/delegations.test.ts server/routine-delegation.e2e.test.ts server/peer-allowlist.e2e.test.ts server/drivers/agents-proxy.test.ts
pnpm exec vitest run server/workspace-backup-policy.test.ts server/workspace-backup.test.ts
```

The end-to-end fixtures use `launchVerificationServer`, a fresh home/data
directory and the fake Claude engine. They prove:

- Unknown/replaced credentials and impersonated bot/thread/depth claims fail.
- A revoked slow-body request cannot start a teammate.
- Explicit thread bindings survive sidebar selection; deleted or foreign
  bindings fail instead of adopting another conversation.
- The real MCP stdio bridge can list, delegate and read its result from the
  same long-running process. Other internal routes remain unavailable.
- Busy-target asks enter the delivery queue without needing a source turn;
  release runs exactly once. Human approval remains required where configured,
  without asking twice after an already-approved ask encounters a busy target.
- Delegation status is withheld when peer access is revoked.
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

2026-09-21: all 321 tests in the ten-file set above passed on macOS after
integrating current main. Typecheck, repository lint and locale validation
passed. Cross-platform CI is still required before merge.
