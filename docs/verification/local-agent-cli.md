# Tracked local agent CLI verification

```sh
node node_modules/vitest/vitest.mjs run server/local-agent-handoff.e2e.test.ts src/components/SidebarBotActivity.test.ts
node node_modules/vitest/vitest.mjs run server/local-agent-jobs.test.ts server/runtime-coordinator.test.ts -t 'unknown|local process|Ask-level assignment|tracked local|bounds even escaped'
node node_modules/vitest/vitest.mjs run server/host/bot-wire.test.ts src/components/ChatView.cancelled-turn.test.ts
```

The end-to-end fixture launches an isolated server with a temporary home and data directory, a sealed executable path, the scripted fake conversation engine, and browser support disabled. Its two fake child CLI variants use an owned loopback gate and different output shapes. The test ends the launching turn, checks the server's thread projection and rendered activity row, releases the child, holds the resumed turn while it validates an artifact, and checks exit 0, nonzero, and unknown status. It also stops a child and revokes access through an isolated Claude policy file both before and during validation. No vendor credentials, browser engine, installed application, or external service are used.

The focused coordinator tests exercise assignment ownership, duplicate and unrelated completion signals, cancellation, revocation and the Full-access requirement. The fixture's server log includes the path to its retained evidence file. It does not test a real vendor CLI, native browser rendering, or processes that detached themselves from the tracked tree.
