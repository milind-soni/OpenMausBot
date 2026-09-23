# Dynamic group conversations

Run only disposable fixtures:

```sh
pnpm exec vitest run server/dynamic-conversation.test.ts server/dynamic-conversation.e2e.test.ts server/chief-rooms.e2e.test.ts server/channel-queue.test.ts server/drivers/agents-catalog-wire.test.ts server/drivers/agents-proxy.test.ts src/lib/group-routing.test.ts
```

The controller tests cover non-roster speaker order, a return to a previous
speaker, public first-turn routing, silent routing and ending checks, unanswered
participation, cancellation, new-message yielding, busy/unknown members, invalid
decisions and provider failure. Reply accounting excludes private work, posted
invitations and system notices, and deduplicates multi-item provider turns.

The HTTP fixture uses the actual room runtime with a scripted engine. It checks
the stored Dynamic setting, Ada → Bo → Ada replies, private output suppression,
the final request's contribution counts, all seven 16–22 notices, the absence of
a 23rd provider request, and a new allowance after a human message. The Chief MCP
fixture verifies room creation, response-mode changes, a single bot-authored
opening invitation, starting the selected mode, and Stop without cancelling the
Chief's separate conversation.

These deterministic tests verify routing and persistence, not a live model's
conversational quality. No provider keys or live user conversations are required.

The catalog checks compare the shipped tool schemas with the checked-in wire
snapshots for every mount profile, including the packaged proxy, and enforce
the existing size budgets. After an intentional schema change, regenerate with
`UPDATE_AGENTS_CATALOG_GOLDENS=1` for `agents-catalog-wire.test.ts`, inspect the
snapshot diff, then rerun without that environment variable. Do not skip the
checks or raise the budgets just to pass them.
