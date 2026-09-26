# Live verification after review fixes — 2026-09-12

The reviewed implementation preserves three organizational layers within one
company section. Five groups retain their original three members each. Chairs
discuss and decide, assign existing members, and those members request downstream
work. Results return through those owners before their chairs consolidate them.

- Upstream base: `2f91c462926bee70242c42a4e3443b19d0a13a0c`.
- Tested implementation: `d75b009b15a561e09873961d548e89a619464efe`.
- Provider: **Claude Code 2.1.251 / GLM-5.3 / low** for all fifteen bots.
- Time: **04:55:00–05:02:10 UTC**, about 7 minutes 10 seconds.
- One isolated fixture; all fifteen bots are in section `検証会社`.
- **45 provider turns**, all completed successfully; **5 work nodes, 7 discussion
  rounds, 10 member assignments**, all completed. The scheduler accounts for 44
  executions after the original user-started turn.
- **15 failed tool calls** occurred during execution; later calls recovered and
  the workflow settled. These are not counted as successful tool calls.
- No agents were invited, moved or added to downstream groups.

This run follows the section-isolation review fix. The earlier
[live run](../live-2026-09-12/README.md) remains historical evidence for its pinned
implementation; its separate-section fixture is not the current configuration.

## What each group discussed

| Layer / group | Discussion, decision and resulting responsibility |
| --- | --- |
| 1 / Executive | Aoi opposed exporting every field and row because of scope and sensitive fields. Yui required seven sales fields. Minato revised the plan to a limited three-month / 10,000-row release, collected a second round of responses, then assigned Aoi to Development and Yui to Sales. |
| 2 / Development | Ritsu requested fixed headers and conditional loss reasons. Mako identified missing post-write counts, restart behavior and date boundaries. Ren revised the acceptance criteria, obtained second-round agreement, then assigned Ritsu to Implementation and Mako to QA. |
| 2 / Sales | Saki proposed three FAQ answers. Towa required restrictions on data handling and an explicit customer-ID matching explanation. Kou incorporated the amendment and assigned Saki the FAQ and Towa a five-item checklist. |
| 3 / Implementation | Hina proposed covering three deal statuses and defining single-character surname handling. Nagi requested both date boundaries and fixed reason vocabulary. Sora decided on a five-row sample, assigned Hina the CSV and Nagi inspection of that actual CSV. |
| 3 / QA | Leo identified a seven-versus-eight-column ambiguity in Mako's brief. Mei and Haru discussed boundaries, empty output, partial failures and restart behavior; Leo assigned them three boundary and three failure cases respectively. |

The branching path is Executive → Development/Sales → Implementation/QA.
Member assignments stay inside their existing group and do not add a layer.

## Actual UI screenshots

The screenshots are from the real renderer connected to the disposable live
fixture. They show discussions, decisions, work results and the final idle state.

| Group | Discussion | Results |
| --- | --- | --- |
| Executive | [Discussion](executive-discussion.png) | [Final consolidation](executive-results.png) |
| Development | [Discussion](development-discussion.png) | [Decision and assignment](development-decision.png), [upstream report](development-results.png) |
| Sales | [Discussion](sales-discussion.png) | [FAQ/checklist review](sales-results.png) |
| Implementation | [Discussion](implementation-discussion.png) | [CSV](implementation-csv.png), [result review](implementation-results.png) |
| QA | [Discussion](qa-discussion.png) | [Inspection cases](qa-results.png) |

## Artifact acceptance remains incomplete

Workflow completion is not proof that the generated artifacts meet the final
decision. This run exposes a concrete failure of cross-team acceptance:

1. Hina produced a **seven-column** CSV with the customer ID embedded in the
   customer-name cell. Nagi inspected that version. The source message is
   `8e73f4de-8afc-4045-86bf-adb382dc5d34`.
2. QA interpreted the brief as **eight independent columns**. Ren, Aoi and Minato
   subsequently approved eight columns as the formal specification, but did not
   request or produce a revised CSV. The final executive reply nevertheless
   claims the artifacts are consistent. They are not.
3. Sales kept the seven-field language, and its FAQ used a June–August example
   while Development fixed the interval to June 12–September 12 inclusive.
4. QA's overflow case combines 10,001 rows with two out-of-range dates; excluding
   those rows would leave 9,999 eligible rows. The count at which the limit is
   applied needs an explicit decision before this is a usable acceptance test.

The independent [checker](check_csv.py) parses the actual chat CSV and reproduces
nine checks against the implementation's draft contract. Its
[result](csv-checks.json) also explicitly records **`passesFinalColumnContract:
false`** (expected 8, actual 7). No bot-created file bytes, export implementation,
privacy guarantee, or autonomous production readiness are validated here.

```sh
python docs/verification/evidence/room-hierarchy/review-live-2026-09-12/check_csv.py
```

## Records and review regression checks

- [Transcripts, addresses, section/model selections and request tree](transcripts.json).
- [Provider start/completion events](provider-turns.json).
- [Extracted draft CSV](sample.csv), [independent draft/final checks](csv-checks.json).
- [SHA-256 manifest](sha256.txt) covers screenshots, JSON and CSV. Text artifacts
  are pinned to LF for Windows checkout consistency.

Typecheck and lint passed. The six other focused suites passed, and all 17
lifecycle tests passed with `--pool=threads --maxWorkers=1`: 134 focused tests
combined. The section-change regression also passed separately with the default
fork pool. Some local Windows fork-pool attempts exited unexpectedly; these are
not reported as green suite runs. Full cross-platform CI is recorded on the PR.

New regression coverage includes duplicate routes through real MCP validation,
foreign recipients and silent readers, mixed-section discussions/assignments,
discovery filtering, section changes while queued with withheld results, the
4,000-character boundary, incidental mentions, and terminal group notifications.

```sh
pnpm exec vitest run server/room-handoffs.test.ts server/mcp-server.test.ts server/drivers/agents-proxy.test.ts server/room-handoffs.e2e.test.ts server/room-discussion.e2e.test.ts server/room-pyramid.e2e.test.ts --maxWorkers=1
pnpm exec vitest run server/room-handoffs-lifecycle.e2e.test.ts --pool=threads --maxWorkers=1
```

The live command was:

```sh
node --experimental-strip-types scripts/verify-room-pyramid.ts .omb-scratch/review-live-20260912/verification.json --live --preview
```

The configured Claude/GLM profile was copied into the disposable fixture using
the documented environment allowlist. Credentials and machine paths are omitted
from these public records. The fixture and preview are stopped after capture;
the user's live app/data are not modified.
