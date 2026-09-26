# Behavior evals

Offline behavior evals for the OpenMausBot harness (upstream issue #1503, tiers 1-3). The unit and e2e suite tests code paths; these scenarios test what the harness *does*: which tools a turn's model was allowed to call, where work was dispatched, what the handoff tree looks like, how routines defer, and when the computer claim fires.

The principle: evaluate the harness, never the models. A scripted engine replays deterministic turns (tool calls, text, refusals) from a plan file; no external API is called; a run is hermetic and repeatable.

## Run

    pnpm eval                     # all scenarios, JSON + markdown report under evals/reports/runs/
    pnpm eval --scenario lazy-computer-claim
    pnpm eval --golden            # tier 2: replay redacted golden threads against committed trace baselines
    pnpm eval --live              # tier 3: opt-in live-model smoke (skips unless OMB_EVAL_LIVE=1)
    pnpm typecheck && pnpm exec tsc -p evals/tsconfig.json   # evals are also typechecked standalone
    npx vitest run --config evals/vitest.config.ts   # the same scenarios as a test gate

## Layout

- `scenarios/` — fixture files, one JSON per scenario. Pure data: bots, scripted turns, driver steps, assertions.
- `providers/mock/` — the deterministic scripted engine: builds the plan the fake provider replays turn by turn, with `@key` bot references resolved to live ids.
- `runners/` — boots a real harness server per world (scripted coordination server; Local VM fixture world), interprets steps, freezes the evidence.
- `scorers/` — pure assertion evaluation against the frozen snapshot; scorers never touch a server.
- `reports/` — per-run JSON and markdown artifacts (gitignored).
- `golden/` — tier 2: the redaction pipeline (raw samples in, synthetic scenarios out), behavior-trace extraction, and replay against committed trace baselines.
- `live/` — tier 3: opt-in live-model smoke scenarios, thresholds, and reporting; live baselines are gitignored.

## Scenario anatomy

Each fixture declares a `world`, the `bots` to create with their scripted `turns`, optional gate names (files that hold a turn open, for deterministic busy windows), `steps` that drive the real server, and `assertions` checked against the frozen evidence. Assertions cover tool call sequences and arguments, dispatch targets, handoff tree shape, system prompts, routine deferral stamps, computer-gate answers, and transcript facts.

## Current pins

- `dispatch-supersede` — a message sent while coordinated work is outstanding runs immediately, the assignment stays attached, and the steered turn is told which work is outstanding. (Current semantics: steering is not cancelling.)
- `routine-deferral` — a routine due behind a busy target is stamped `deferredAt` while staying queued, then dispatches and completes when the target frees.
- `lazy-claim-screenless` (issue #1361) — a screen-less Auto turn mounts computer tools without claiming the VM and completes while another thread holds it; no wait activity appears.
- `lazy-computer-claim` (issue #1361) — the first screen call fires the deferred claim, is honestly refused while another thread holds the VM, shows the existing wait activity, and proceeds on release.
- `lazy-claim-rejection` (issue #1369) — a VM that dies between dispatch and the first screen call rejects the fired claim: the call is refused honestly instead of as contention, exactly one terminal computer-unavailable error lands, the turn ends instead of staying busy, and a later screen call fails closed after teardown revokes the bridge capability.

## Worlds

- `coordination` — the packaged verification server with the scripted room engine: ordinary chat, `coordinate_bots` handoffs, routines.
- `localVm` — the real server with the container boundary replaced by the in-repo VM fixture (`server/testing/group-local-vm-hooks.mjs`): hermetic Local VM lifecycle, no Podman. The runner plays the bridge's computer-control poll, which is the seam the lazy claim lives at.

## Tier 2 — golden-thread replay

Turn a real coordination thread into a synthetic fixture, then replay it through the scripted engine:

    node --experimental-strip-types evals/golden/redact/redact-cli.ts \
        --input evals/golden/samples/<raw-thread>.json \
        --out evals/golden/scenarios/golden-<name>.json
    pnpm eval --golden --update-baseline --scenario golden-<name>

The redaction step rewrites ids, names, and free text into stable synthetic placeholders and runs a leak scan before writing anything, so a real thread becomes reviewable, committable data. Commit both the redacted scenario and the regenerated baseline under `evals/golden/baselines/`; replay asserts the stable tool traces and outcomes — turn order, tool-call names, dispatch targets, handoff-tree shape — against that baseline.

## Tier 3 — opt-in live-model smoke

Live-model runs never execute by default: `pnpm eval --live` prints one skip line and exits 0 unless the gate is open.

    OMB_EVAL_LIVE=1 OMB_EVAL_LIVE_CONFIG=/path/to/instance.json pnpm eval --live

The instance file (or inline `OMB_EVAL_LIVE_INSTANCE` JSON) uses the product's own instance shape — `instanceId`, `driver`, `model`, optional `config` and `environmentFrom` — so credential variables are copied from the launching shell (`OMB_EVAL_LIVE_PASS_ENV` lists names to forward) and never inlined. Thresholds live in the committed `evals/live/config.json`: minimum suite score, maximum drift from the last recorded baseline, and turn and judge timeouts. Scenarios run cheap real models with state-based waits, deterministic checks (`botReplied`, tool traces), and a versioned judge whose prompt files are pinned by sha256 in a manifest; drift against the gitignored `evals/live/baselines/` baseline fails the suite.
