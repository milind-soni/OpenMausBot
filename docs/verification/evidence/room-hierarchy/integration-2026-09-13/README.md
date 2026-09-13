# Integration with upstream coordination, 2026-09-13

Baseline: upstream `536b7893549924c3e2b71eb2e9564ea2986a146a`, including #1136,
#1153 and #1147. The containing merge commit retains upstream `coordinate_bots`,
direct-chat coordination, explicit Chief team grants and compact request receipts.
Structured room discussion and source-group restrictions are optional settings.

## UI comparison

The actual React application ran against disposable fixture servers on loopback.
The baseline used an independent worktree at the exact upstream commit. Both
settings fixtures contained Executive and Development groups with existing bots.
Screenshots were captured through the in-app browser at 1280 x 720.

| State | Screenshot | Supporting evidence |
| --- | --- | --- |
| Upstream baseline | [before-group.png](before-group.png) | [DOM](before-dom.txt) |
| Integrated default, collapsed | [after-default.png](after-default.png) | [DOM](after-default-dom.txt) |
| Discussion required; Executive allowed | [after-configured.png](after-configured.png) | [DOM](after-configured-dom.txt), [saved settings](after-configured-settings.json) |
| Incoming restriction disabled again | [after-unrestricted.png](after-unrestricted.png) | [DOM](after-unrestricted-dom.txt), [saved settings](after-unrestricted-settings.json) |

The saved settings were read back from the fixture API after browser interaction.
Disabling the restriction persists `incomingGroupIds: null`; enabling discussion
does not create or invite any members. Default upstream coordination remains
available when these settings are absent.

## Three-layer execution

```sh
pnpm exec vite build
node --experimental-strip-types scripts/verify-room-pyramid.ts .omb-scratch/integration-pyramid/verification.json --preview
```

The merged server and actual injected agents MCP proxy completed 45 scripted
provider turns in five groups with fifteen existing bots. The durable tree has
five work nodes (including the root), ten member assignments and seven discussion
rounds; every node completed. Existing memberships stayed unchanged.
[pyramid.json](pyramid.json) retains the rooms, request tree and transcripts.

| Layer | Group | Discussion | Decision / work / result |
| --- | --- | --- | --- |
| 1 | Executive | [screenshot](executive-discussion.png) | [screenshot](executive-results.png), [DOM](executive-dom.txt) |
| 2 | Development | [screenshot](development-discussion.png) | [screenshot](development-results.png), [DOM](development-dom.txt) |
| 2 | Sales | [screenshot](sales-discussion.png) | [screenshot](sales-results.png), [DOM](sales-dom.txt) |
| 3 | Implementation | [screenshot](implementation-discussion.png) | [screenshot](implementation-results.png), [DOM](implementation-dom.txt) |
| 3 | QA | [screenshot](qa-discussion.png) | [screenshot](qa-results.png), [DOM](qa-dom.txt) |

Executive's Aoi requests work from Development's Ren, while Yui requests Sales's
Kou. After Development's discussion, Ritsu requests Implementation's Sora and
Mako requests QA's Leo. Each lower group discusses and assigns its own members;
results resume the responsible members and then their chairs.

This is a deterministic workflow and UI regression, **not a new GLM-5.3 run**.
The scripted opinions and deliverables are placeholders. They prove ordering,
speaker identity, routing, and continuation, not useful deliberation or acceptance
of a generated CSV. The historical live-model evidence in the sibling directories
remains pinned to its earlier implementation and retains failed final CSV-column
acceptance. It must not be relabeled as evidence of this merged implementation.

## Validation

- Integration-focused scheduler/lifecycle/discussion/pyramid: 4 suites, 37 tests.
- Final review regressions after the atomic settings save, cancellation and
  original-request preservation fixes: 4 suites, 51 tests passed (116.42 seconds).
- Default upstream room-tool visibility regression: passed after making
  `discuss_room` visible only in rooms with the discussion setting enabled.
- Broader upstream direct coordination, Chief setup, MCP and room integration:
  175 tests initially passed; the one tool-visibility failure was fixed and its
  targeted test passed. Final full-suite/CI results are recorded in the PR.
- Typecheck, lint, locale validation and production UI build passed.
- Earlier review fixes were reproduced with Python 3.9.25 and real child-process
  exit tests; all 32 historical live-evidence manifest entries remained unchanged.

`sha256.txt` covers the captured screenshots, DOM, settings and request evidence.
