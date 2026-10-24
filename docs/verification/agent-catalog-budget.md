# Agents catalog wire budget

The office cancellation change adds one native Chief tool, `cancel_job`.
Its serialized definition is 470 UTF-8 bytes; the containing tools array grows
by 471 bytes including its separator. The bridged Chief list grows by 12 bytes
for the hidden tool name. Non-Chief and standing external runtime lists do not
gain the tool.

The baseline module at `108036a` has SHA-256
`7acf9bb1327097fba37e2fac0b048168266a7ff4e4842251f400d4102ac9eda5`.
The HEL1 comparison imports that exact source and the changed catalog and
requires every profile to be identical after removing `cancel_job`.

| Profile | Baseline bytes | Changed bytes | Delta |
| --- | ---: | ---: | ---: |
| Native Chief, default | 57,871 | 58,342 | 471 |
| Native Chief, fullest | 68,862 | 69,333 | 471 |
| Non-Chief, default | 48,104 | 48,104 | 0 |
| Standing external runtime, default | 57,871 | 57,871 | 0 |
| Bridged native Chief, default | 15,194 | 15,206 | 12 |
| Bridged Non-Chief, default | 15,083 | 15,083 | 0 |

The previous Chief budget constants were set at `27da335e5a`, while the
checked-in wire goldens already included later inbox-code sign-in and
own-webhook-address changes (`d7720dc19`, `548cd682f`, merged at `2b3f75b82`).
Their definition deltas total 1,053 bytes: `request_sign_in` 170, `fill_login`
112, `list_triggers` 259, and `create_trigger` 512. Non-Chief constants were
already refreshed by the later merge. This accounts for the stale Chief
constants independently of cancellation.

Both catalog and bridged goldens are regenerated on HEL1. Budget constants
are set to their exact measured current profile sizes; the existing upper and
lower 2% checks remain unchanged.

## Project memory and job usage

The reliability extension adds one native `project_memory` tool and expands
the existing `assignment_status` description to explain measured usage and
unknown observations. On HEL1 the native profiles grow by 1,908 UTF-8 bytes;
bridged profiles grow by 16 bytes for the hidden tool name. Standing external
runtimes do not receive project memory and grow only by the 134-byte status
description change (their bridged list remains unchanged).

All 21 full and 21 bridged wire profiles are regenerated on HEL1. Their exact
measured sizes replace the previous baselines; the 2% regression checks remain.
