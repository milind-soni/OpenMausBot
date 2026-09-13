# Live three-layer verification — 2026-09-12

The latest fetched upstream `main` was
`2f91c462926bee70242c42a4e3443b19d0a13a0c`. The experiment ran PR #1126 head
`454aa82296fed62ffcba6ae8cb028bc01eb99ad0`, which already contains that base.
No production source changes were needed for this run. The files added here
record the result; they do not change the tested implementation.

**Orchestration passed. Artifact acceptance remains incomplete.** All five
groups discussed proposals with their existing members, made decisions, assigned
responsibilities, and returned results to the requesting member and then chair.
Actual model responses also exposed cross-team inconsistencies that the leaders
accepted incorrectly. A completed scheduler node does not certify a deliverable.

## Engine and execution evidence

- Claude Code **2.1.251**, **GLM-5.3**, effort **low** for all fifteen bots.
- Fresh isolated `launchVerificationServer`, separate home/data/ports, actual
  server and injected agents MCP proxy. Existing provider configuration was read
  for this engine; the user's application, conversations and settings were not
  modified. There were no scripted model replies or interventions in the run.
- Started **2026-09-12 03:59:33 UTC**, finished **04:08:44 UTC** (about 9m11s).
- **45 provider turns completed successfully**: the initial turn plus 44
  scheduler executions. **5 work nodes, 7 discussions, 10 assignments** all
  completed. Membership stayed at three existing members per group.
- **14 tool calls reported failure** during the run. The model subsequently
  completed the workflow; this was not an error-free tool-selection run.
- [transcripts.json](transcripts.json) contains the selected model for each bot,
  actual text messages, tree edges, node states and failed-tool metadata.
  [provider-turns.json](provider-turns.json) contains canonical turn start/end
  events from the real `claudeAgent` driver. Machine paths and credentials are
  excluded. All room transcripts reported `hasMore: false`.

## What each group actually discussed

| Layer / group | Discussion and resulting decision | Ownership / result |
| --- | --- | --- |
| 1 / 経営会議 | ミナト proposed all fields/all records. アオイ objected to release delay and proposed roughly ten fields/three months; ユイ required twelve fields/six months. ミナト revised to twelve fields/six months/three weeks; a second round added fixed formats and mandatory order/update dates. | アオイ sent the development brief to レン; ユイ sent the sales brief to コウ. Both reviewed returned reports before ミナト integrated them. |
| 2 / 開発部 | リツ proposed fixing fields/formats and excluding free text. マコ raised partial output, date basis, counts and unique IDs. レン revised the brief and held a second round, adding header order and failure reporting criteria. | リツ requested CSV/schema work from ソラ. マコ requested the QA table from レオ. レン consolidated their reviews. |
| 2 / 営業部 | サキ proposed a concise explanation, freshness guidance and no promised expansion date. トワ added allowed devices/storage, transfer restrictions and a usage log. コウ adopted these changes. | サキ wrote three FAQ answers; トワ wrote a five-item operational checklist. コウ returned the reviewed work to ユイ. |
| 3 / 実装チーム | ヒナ asked for numeric types, amount calculation and allowed statuses. ナギ built on this with order-number format, update/order-date consistency and delimiter checks. ソラ fixed the twelve-field schema. | ヒナ produced three synthetic CSV rows. ナギ read that actual CSV and checked it before ソラ returned the result to リツ. |
| 3 / QAチーム | メイ challenged the incomplete date boundaries and added empty/date-validity cases. ハル added concurrent changes, partial failure and permission denial. レオ expanded the table from three sections to four. | メイ wrote boundary cases; ハル wrote failure cases. レオ integrated the table, including explicit questions for マコ, and returned it. |

Assigning a same-room owner did not create another organizational layer or add
members to a group. Downstream work originated from those owners, not the chairs.

## Screenshots from every group

These are unmodified 1280 × 720 browser captures of the actual live fixture.
Discussion images were taken during execution; result images show the completed
conversations. The earlier [before/after UI comparison](../README.md#ui-comparison)
remains separate from this live-model run.

| Group | Discussion / decision | Result |
| --- | --- | --- |
| 経営会議 | [Revised proposal](executive-revision.png) | [Integrated report](executive-results.png) |
| 開発部 | [Concerns and revision](development-discussion.png) | [Return to アオイ](development-results.png) |
| 営業部 | [サキ's opinion](sales-discussion.png), [トワ's challenge and decision](sales-challenge.png) | [Return to ユイ](sales-results.png) |
| 実装チーム | [Schema decision after discussion](implementation-discussion.png) | [CSV and inspection report](implementation-results.png) |
| QAチーム | [メイ and ハル's opinions](qa-challenge.png), [revised structure](qa-discussion.png) | [Table and unresolved questions](qa-results.png) |

## Independent artifact checks and unresolved findings

The [CSV text](sample.csv) was extracted unchanged from ヒナ's chat code block.
[check_csv.py](check_csv.py) independently parses it with Python's CSV parser.
All **nine checks** in [csv-checks.json](csv-checks.json) passed: header order,
three data rows, twelve columns, unique consecutive IDs, assigned date interval,
update-date ordering, integer/amount arithmetic, allowed statuses, and no embedded
delimiters/quotes/newlines. This file is an extracted artifact, not proof that the
bot wrote a BOM-bearing file. Rerun with:

```sh
python docs/verification/evidence/room-hierarchy/live-2026-09-12/check_csv.py
```

Manual review found these unresolved acceptance issues in the actual conversation:

1. **A one-day disagreement was accepted.** Implementation used
   **2026-03-12 through 2026-09-11**. QA B-3 includes the date six calendar months
   before the base date, i.e. **2026-03-11**. マコ incorrectly declared those
   definitions consistent; レン, アオイ and ミナト accepted the report.
2. **The limit remains undefined.** QA used a provisional 100,000 rows and asked
   for the actual limit. マコ chose “all rows plus a warning” while leaving the
   threshold unspecified. A boundary test cannot have a final expected result
   without that threshold. The final integrated report still says ready.
3. **Chat content is not file-encoding proof.** リツ accepted UTF-8 BOM compliance
   without a file-byte check. The supplied chat block has no BOM. The independent
   checks cover the extracted content only.
4. **Corrections were not propagated to the original QA table.** マコ changed the
   reporting/restart owner to レン in the review text, but the QA room's completed
   table still names マコ/レオ. A reviewer or document assembly step must reconcile
   these versions before using the deliverables.

The run therefore demonstrates substantive discussion, delegation, real generated
work and upstream review. It does not demonstrate dependable autonomous acceptance
of all cross-team requirements or production readiness of the synthetic CSV task.

## CI follow-up

At tested head, Linux and macOS `typecheck + test` jobs passed. Windows run
[34671190267](https://github.com/milind-soni/OpenMausBot/actions/runs/34671190267)
finished with **5,939 passed, 2 failed, 176 skipped, 1 todo**. Both failures were
20-second timeouts in `server/workspace-backup.test.ts` (backup round-trip and
restoring pending follow-ups). The relevant source/test files are unchanged from
the upstream base. Running those two cases independently passed on both the
unmodified base and feature head (11.69s and 14.64s total test time respectively):

```sh
pnpm exec vitest run server/workspace-backup.test.ts -t 'round-trips WAL|also pauses pending' --reporter=verbose
```

This narrows the failure to a timing-sensitive CI observation; it does not prove
the cause or turn the failed Windows job green. Vercel separately requires the
upstream team's deployment authorization. Neither condition is hidden by this
live workflow result.

[sha256.txt](sha256.txt) records the screenshot, transcript, provider-event and
CSV-check hashes.
