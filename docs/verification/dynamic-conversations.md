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

## Configurable meeting allowances

Run the related accounting, controller, HTTP, tool contract and persistence checks:

```sh
pnpm exec vitest run shared/meeting-limits.test.ts server/meeting-session.test.ts server/dynamic-conversation.test.ts server/dynamic-conversation.e2e.test.ts server/chief-rooms.e2e.test.ts server/drivers/agents-catalog-wire.test.ts server/store.test.ts server/group-goal-run.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/meeting-limits-ui.e2e.test.ts
```

The UI test uses `control-omb`'s disposable fake-engine server and real renderer,
never the installed app. It checks checkbox geometry, help, persistence after
reopening, invalid empty limits, Escape and fixture cleanup. Its screenshot is
written beside the persistent verification log.

Accounting checks cover cumulative usage deduplication, cached input, private
checks, persisted allowances, wall-clock interruption, earliest-limit precedence,
missing usage, and unsupported pricing. HTTP fixtures exercise custom reply caps
in Dynamic, everyone, mentions and lead modes, plus a token cap across private
and public turns and a timer interrupt while the provider is waiting.

The two new structured `meeting_limits` parameters add 2,957 measured wire
bytes to affected catalog profiles. The explicit budget baselines rise by 2,734
bytes to accommodate that feature. Their golden snapshots and baselines
are regenerated together; the existing 2% growth assertions remain enabled.
The external-only profile is unchanged. This is an accounted feature addition,
not a relaxed gate for an unexplained schema mismatch.

These fixtures do not establish live-model conversational quality, billing
accuracy across providers, or a hard provider-side spending guarantee. Dollar
accounting uses OpenRouter token rates and provider-reported usage; a request can
cross the allowance before its usage event arrives. Missing complete usage stops
further meeting turns. Unsupported tiered or fixed-request pricing fails before
dispatch. Existing scheduled Goal runs inherit their room's limits; this change
does not add new routine scheduling controls.
