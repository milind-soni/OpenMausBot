# Vendor-Neutral Control Plane — Roadmap

> **For agentic workers:** this is the sequencing document, not an executable plan.
> Each numbered plan below is its own file and its own working, testable deliverable.
> Execute them with superpowers:subagent-driven-development, one plan at a time.

**Goal:** Close the gap between what OpenMausBot already is (an engine-neutral harness
that owns memory, skills, permissions, and computers) and what it is not yet packaged
as (a portable Bot Profile, a real connections surface, and a machine that stays on).

**Why these seven and not the community's list verbatim:** the community proposal asks
for a multi-engine architecture, harness-level memory, engine-independent learning, and
a vendor-neutral control plane. Those exist today — `server/contracts.ts` makes the model
a data value rather than a service binding, `server/workspace.ts` owns memory outside any
engine, `server/skills.ts` owns skills, and a mid-thread engine switch already replays the
thread into the new engine (`server/branching.test.ts:253`). The gap is packaging and
surface area, not architecture. Every plan below is scoped to that gap.

---

## Global Constraints

These apply to every task in every plan. They are copied from the conventions the
codebase already enforces; a task that violates one is wrong even if its tests pass.

- **TypeScript strict**, Node 24+, pnpm. `pnpm typecheck` covers app + server.
- **Vitest**, `fileParallelism: false`, `testTimeout: 20_000`. Server tests are
  `server/**/*.test.ts` and colocate with their module.
- **The test floor.** `pnpm test` runs `scripts/test-floor.mjs` with
  `TEST_COUNT_FLOOR = 1070`. Adding tests never touches it. Only a plan that
  deliberately removes tests may lower it, in the same PR, as a reviewed decision.
- **Secrets are write-only.** The UI only ever sees a `configured` boolean. No
  endpoint may return a key, token, or secret it stores. This is why
  `server/config.ts` splits `appConfigSchema` from `appConfigPatchSchema`.
- **Persisted files are `0600`**, written through `writeFileAtomic`
  (`server/atomic.ts`), and anything agent-authored passes `redactSecrets`
  (`server/redact.ts`) before it reaches disk.
- **The capability rule.** Never offer a control, tool, or attachment a driver
  cannot actually mount. `ProviderAdapter.capabilities` exists for this — see
  `agentsMcp`, `computerMcp`, `composioMcp`, `images` in `server/contracts.ts:205`.
  A new integration means a new capability flag, and the UI reads the flag.
- **Unknown config round-trips.** A config written by a newer build must load in an
  older one and degrade to "unavailable" rather than throwing. `InstanceConfig.driver`
  is deliberately unvalidated for this reason.
- **Exports never carry** credentials, transcripts, memory, grants, absolute paths,
  engine bindings, or a schedule's active state. `server/package-export.ts` states
  this as its contract; every new export path inherits it. The one deliberate
  exception is the private team backup (`server/team-backup.ts`): it exists to
  move a person's own fleet between their own machines, so it carries transcripts
  and memory — redacted — and is never a shareable package.
- **Imports land disabled.** Skills, connectors, routines, and MCP servers arriving
  from outside are inert until a person enables them after reading. See the policy
  comment at the top of `server/skills.ts`.
- **Audit what you authorize.** Any new allow/deny decision writes a row through
  `appendDecision` (`server/decision-log.ts`), fire-and-forget — an audit log must
  never take down the decision it audits.

---

## Dependency order

```
P1 usage-accounting-and-budgets ──┬─▶ P2 bot-profile ──┬─▶ P6 memory-review-loop
                                  │                    │
                                  └─▶ P7 task-board ◀──┘
P3 mcp-registry ──▶ P4 connector-scopes
P5 headless-harness  (independent)
```

| # | Plan | Depends on | Why this order |
|---|---|---|---|
| 1 | [Usage accounting and budgets](2026-08-31-01-usage-accounting-and-budgets.md) | — | Budgets built on today's `input` field would cap on cache reads. Must split the number before anything enforces on it. |
| 2 | [Bot Profile](2026-08-31-02-bot-profile.md) | P1 | The keystone. Consolidates five stores into one addressable, versioned object. P6 and P7 both write into its version log. |
| 3 | [MCP registry](2026-08-31-03-mcp-registry.md) | — | Independent of P1/P2. Promotes MCP from plumbing to product surface. |
| 4 | [Connector scopes](2026-08-31-04-connector-scopes.md) | P3 | Reuses the per-tool policy gate P3 builds into `createGateInterceptor`. |
| 5 | [Headless harness](2026-08-31-05-headless-harness.md) | — | Largest, fully independent. Can run in parallel with 1–4 by a second worker. |
| 6 | [Memory review loop](2026-08-31-06-memory-review-loop.md) | P2 | Needs the profile version log to record an approved memory diff. |
| 7 | [Delegation task board](2026-08-31-07-delegation-task-board.md) | P1, P2 | Needs budgets for concurrency caps and the profile for supervisor roles. |

---

## Explicitly deferred: engine bake-off and intelligent routing

The community proposal's headline feature. It is deferred, not rejected, for three
reasons that should be revisited after P1, P2, and P7 land:

1. **Nothing to score against.** There is zero eval code in the tree. A bake-off
   without a rubric is a novelty — it produces four answers and no verdict.
   P2's profile gives it success criteria to attach to; P7 gives it tasks to run.
2. **The comparison needs honest cost.** Most engines never report a price at all
   (`TaskUsage.costUsd` is `null` for the majority — see the field comment in
   `server/store.ts:205`). Comparing cost across engines needs the pricing table P1
   introduces, or the winner is just "the one that reported a number".
3. **Per-task routing has an unadvertised tax.** CLI engines carry their own session
   state. The replay path exists (`server/branching.test.ts:253`), but every switch
   rebuilds context from scratch. Routing a classification to a local model and the
   next step back to Claude pays a full context rebuild each way. That may still be
   worth it — but the plan must measure it, not assume it.

When it is picked up, it is one plan: a `bake-off` routine kind that fans one prompt
across N instances, banks each run's `TaskUsage` and receipt separately, and renders a
comparison. Routing rules come after, driven by that data.

---

## What is deliberately NOT in scope

- **Rebuilding Composio as the architecture.** It stays one connection method. P3
  makes direct MCP a peer of it, which is the community's actual ask.
- **A hosted multi-tenant backend.** P5 ships a daemon the user runs. The existing
  `cloudflare/control-plane` worker keeps its current job — identity, installation
  ownership, and one managed tunnel per install — and gains nothing that stores bots,
  chats, prompts, or tool output.
- **Raising the delegation depth cap globally.** P7 raises it only behind an explicit
  supervisor role with a concurrency cap. `MAX_COMMS_DEPTH = 1` is what makes
  recursive delegation structurally impossible today (`server/delegations.ts:29`), and
  that property is worth keeping by default.
