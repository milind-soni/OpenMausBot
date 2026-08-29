# Agent Centipede benchmark lab

This is a deterministic benchmark harness with an opt-in live adapter seam for
arbitrary agent topologies. Fixtures remain network-free; live runs can invoke
a benchmark-aware process (Cursor, browser/computer runner, or other agent) or
an HTTP endpoint using only explicit sandbox paths.

The benchmark treats agents as configurable workers, not hard-coded product
roles. Required deterministic coverage includes a renamed solo generalist,
independent agents, a coordinator with specialists, and a peer team without a
coordinator. Chief + Capture is retained only as an optional compatibility
template (`chief-capture-template`).

## Safety boundary

Every run creates a disposable `omb-agent-centipede-*` directory with separate
profile, storage, database, config, fixture, and trace paths. The path guard
proves all generated paths are beneath that root; it does not reject user
chosen agent or directory names. Environment values are returned to the caller;
the runner never mutates `process.env`. The deterministic adapter never opens a
real browser or sends a message. External side effects require an explicit
approval; all side effects can be forced to `--dry-run`.

## Scenarios

The fixture suite covers product build/QA, browser receipts and draft-not-send,
Windows software operation, research→decision→draft→approved execute, auth and
tool failure recovery, multi-hour unattended checkpoints, and privacy/approval
boundaries.

## Running

```text
pnpm bench:agent-centipede
pnpm bench:agent-centipede -- --dry-run
pnpm bench:agent-centipede -- --scenario=auth-tool-recovery --json
pnpm bench:agent-centipede -- --topology=peer-team
pnpm bench:agent-centipede -- --all-topologies --json
pnpm test:agent-centipede
```

The report includes criteria score, outcome-evidence quality, retry count,
cost, latency, token usage, failures, and blocked/dry-run actions. Criteria
score answers “did the scenario-shaped events occur?” independently from
outcome score, which answers “how many completed actions have a fresh,
independent postcondition proof?” A fixture can therefore score 100% on its
scenario criteria while correctly reporting `e2eVerified: false` and an
outcome score of 0. This prevents deterministic fixtures or adapter-reported
success from being presented as real end-to-end proof.

The promotion gate requires `e2eVerified` for every scenario. An independent
adapter must perform a fresh read against the disposable target and emit
`outcomeVerified: true` plus a non-empty `verificationRef` on every completed
action. The built-in deterministic, process, and HTTP adapters do not claim
that mode; they remain useful for safe regression, routing, and failure tests.

`--topology=<id>` routes every neutral scenario action through one topology.
`--all-topologies` runs the four required topologies plus the optional
Chief/Capture compatibility template and reports each topology's result. The
router records the selected `agentId` in every event, making delegation and
renamed-agent coverage replayable.

## Opt-in live adapters

Live mode requires all three explicit paths. The process adapter starts with
`shell=false`, passes `OMB_BENCHMARK=1`, and writes a replayable NDJSON trace
per action. Side effects are dry-run by default; adding
`--allow-side-effects` still requires each action in `--approve`.

```text
pnpm bench:agent-centipede -- --live-process=C:\\tools\\cursor-agent.exe \
  --profile-dir=C:\\temp\\omb-bench\\profile \
  --data-root=C:\\temp\\omb-bench\\data \
  --trace-dir=C:\\temp\\omb-bench\\traces \
  --dry-run --json
```

The HTTP adapter is similarly opt-in and requires `--allow-network`:

```text
pnpm bench:agent-centipede -- --http-endpoint=http://127.0.0.1:8787/benchmark/action \
  --profile-dir=C:\\temp\\omb-bench\\profile \
  --data-root=C:\\temp\\omb-bench\\data \
  --trace-dir=C:\\temp\\omb-bench\\traces \
  --allow-network --dry-run
```

Agents must return JSON on stdout (process) or in the HTTP response, for
example `{ "status": "ok", "tokens": 120, "costUsd": 0.01, "data": { "proof": "..." } }`.
The harness is live-capable at this adapter boundary, but it does not provide
Cursor/browser/computer credentials, application login, visual proof, or a
remote service. Those integrations still need their own sandbox and service
setup before a run can claim end-to-end coverage.

## Baselines and promotion

Create a baseline with `--write-baseline=baseline.json`, compare with
`--baseline=baseline.json`, and use `--promote` for a fail-closed gate. The gate
blocks on missing baselines, failed scenarios, unverified outcomes, safety
violations, budget breaches, dry-run evidence, or
score/evidence/latency/cost/token/attempt regressions.
