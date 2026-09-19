# Behavior evals

Offline behavior evals for the OpenMausBot harness (upstream issue #1503, tier 1). The unit and e2e suite tests code paths; these scenarios test what the harness *does*: which tools a turn's model was allowed to call, where work was dispatched, what the handoff tree looks like, how routines defer, and when the computer claim fires.

The principle: evaluate the harness, never the models. A scripted engine replays deterministic turns (tool calls, text, refusals) from a plan file; no external API is called; a run is hermetic and repeatable.

## Run

    pnpm eval                     # all scenarios, JSON + markdown report under evals/reports/runs/
    pnpm eval --scenario lazy-computer-claim
    pnpm typecheck && pnpm exec tsc -p evals/tsconfig.json   # evals are also typechecked standalone
    npx vitest run --config evals/vitest.config.ts   # the same scenarios as a test gate

## Layout

- `scenarios/` — fixture files, one JSON per scenario. Pure data: bots, scripted turns, driver steps, assertions.
- `providers/mock/` — the deterministic scripted engine: builds the plan the fake provider replays turn by turn, with `@key` bot references resolved to live ids.
- `runners/` — boots a real harness server per world (scripted coordination server; Local VM fixture world), interprets steps, freezes the evidence.
- `scorers/` — pure assertion evaluation against the frozen snapshot; scorers never touch a server.
- `reports/` — per-run JSON and markdown artifacts (gitignored).

## Scenario anatomy

Each fixture declares a `world`, the `bots` to create with their scripted `turns`, optional gate names (files that hold a turn open, for deterministic busy windows), `steps` that drive the real server, and `assertions` checked against the frozen evidence. Assertions cover tool call sequences and arguments, dispatch targets, handoff tree shape, system prompts, routine deferral stamps, computer-gate answers, and transcript facts.

## Current pins

- `dispatch-supersede` — a message sent while coordinated work is outstanding runs immediately, the assignment stays attached, and the steered turn is told which work is outstanding. (Current semantics: steering is not cancelling.)
- `routine-deferral` — a routine due behind a busy target is stamped `deferredAt` while staying queued, then dispatches and completes when the target frees.
- `lazy-claim-screenless` (issue #1361) — a screen-less Auto turn mounts computer tools without claiming the VM and completes while another thread holds it; no wait activity appears.
- `lazy-computer-claim` (issue #1361) — the first screen call fires the deferred claim, is honestly refused while another thread holds the VM, shows the existing wait activity, and proceeds on release.

## Worlds

- `coordination` — the packaged verification server with the scripted room engine: ordinary chat, `coordinate_bots` handoffs, routines.
- `localVm` — the real server with the container boundary replaced by the in-repo VM fixture (`server/testing/group-local-vm-hooks.mjs`): hermetic Local VM lifecycle, no Podman. The runner plays the bridge's computer-control poll, which is the seam the lazy claim lives at.

Tier 2 (golden-thread replay) and tier 3 (live-model smoke) extend this directory; CI wiring lands after the current upstream merge window.
