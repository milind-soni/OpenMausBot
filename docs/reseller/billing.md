# Billing by workspace and user

You pay the vendor for each workspace you run and for each person who uses one
(the wholesale price). You charge your customers your own price (the retail
price). `openmausbot fleet billing` reports both for a month and the margin
between them.

The report is built from the usage ledgers the workspaces keep about
themselves. It is evidence for an invoice, not a meter the vendor enforces: a
workspace's owner could edit their own ledger. Treat the figures as the basis
for a conversation, not as a bill.

## Set the prices

Amounts are in major units with at most two decimals. They are stored as whole
minor units (cents), so nothing is ever rounded.

```sh
openmausbot fleet rates --currency USD \
  --wholesale-workspace 20.00 --wholesale-user 5.00 \
  --retail-workspace 50.00 --retail-user 15.00
```

`--wholesale-*` is what you owe the vendor, as you assert it; the CLI cannot
check it against your contract. `--retail-*` is the default price to your
customers. Only currencies with two decimals are accepted (USD, EUR, GBP, AED
and similar).

One customer can have a different retail price. `NAME=WORKSPACE/USER` replaces
those fields for that customer and either amount may be left empty to keep the
default for it:

```sh
openmausbot fleet rates --retail-override acme=100.00/12.00
openmausbot fleet rates --retail-override acme=/9.00     # only the per-user price
openmausbot fleet rates --clear-override acme
```

`openmausbot fleet rates` with no flag prints the current prices. Run as root it
writes the registry; with `--dry-run`, or as anyone else, it only prints what it
would write.

## Read the report

```sh
openmausbot fleet billing                       # this month so far, as text
openmausbot fleet billing --month 2026-08       # a past month
openmausbot fleet billing --csv > 2026-08.csv   # for a spreadsheet
openmausbot fleet billing --detail              # one line per person as well
```

Months are UTC calendar months. The current month is "as of" now: run it again
later and the numbers grow. A month in the future is refused.

The command needs a licence key that grants both `admin` and `billing`
(`--license-key-file`, `--license-key` or `OMB_LICENSE_KEY`) and names the one
that is missing. This is a product gate, not a security boundary: the report
reads files root already owns. In the operator workspace the same report is at
`GET /api/fleet/billing?month=YYYY-MM&detail=true`, for an admin with the same
two features.

### What is charged

A workspace is charged its workspace price for a month when it was running at
any moment of that month, or when it has any usage in that month. A workspace
suspended all month with no usage is not charged. There is no proration: a
workspace created on the 28th pays the full workspace price. A retained
workspace follows the same rule. The registry records each status change with
its time (the last 100 are kept), which is how "running at any moment" is
known; a registry written before this feature falls back to the current status
and the creation time.

A workspace is also charged the user price for each **active user**: a distinct
person who asked it something and got an answer during the month.

- A signed-in person counts once under their email address, whatever the case
  (`Ada@X.test` and `ada@x.test` are one person).
- A paired phone or Slack person without an email counts once under the device
  or name it carries, lowercased.
- "This computer" (the owner), routines, bot-to-bot turns and helper models are
  never a person. When one of them works for a named person, its cost is added
  to that person only if they already count as a user.
- A turn that failed does not make anyone an active user.
- Addresses are never merged: `ada@x.test`, `ada+work@x.test` and
  `ada@mail.x.test` are three people, and so are a person's phone and their
  email. A customer who wants fewer users should remove the extra sign-ins.

The report also shows how many addresses and `@domain` entries each workspace
lets sign in. That is a seat count for your information; it is not what you pay
for.

### The figures

For each workspace: `wholesale = workspace price (if charged) + users x user
price`, and `retail` the same with the retail prices (an override replaces its
fields). `margin = retail - wholesale`, and is negative when you sell below
cost. The totals are the sum of the printed lines.

### When a ledger cannot be read

A workspace whose ledger cannot be read safely (a link where a file should be,
a file over 256 MiB, more than 1000 distinct people in the month, a read that
takes over 20 seconds) is shown as `unavailable`. Its user count and every
amount are blank, not zero. Totals that depend on it are blank. The report says
`INCOMPLETE`, the other workspaces are still shown, and the command exits 1.

### CSV columns

`month,row_type,workspace,host,user,user_kind,asked_turns,attributed_turns,cost_usd,billable,ledger,wholesale_minor,retail_minor,margin_minor,currency`

`row_type` is `workspace`, `user` (only with `--detail`) or `total`. Amounts are
whole minor units. On a workspace row `attributed_turns` is all the workspace's
turns; the number of active users is the count of its `user` rows with
`--detail`. Text cells that start with a spreadsheet formula character are
prefixed with an apostrophe; numbers, including a negative margin, are not.

## Deleting a workspace

`fleet delete` first writes a root-only closing snapshot of the current month
to `/var/lib/openmausbot-billing/closing/NAME@CREATED.json`, because deleting
removes the ledger. If the snapshot cannot be written the workspace is not
deleted. A report for that month includes the snapshot. `--keep-data` keeps the
workspace and its ledger, so no snapshot is needed.

## What it does not do

- Earlier months of a deleted workspace are gone unless you saved that month's
  report (`--csv`) before deleting. Closed months are not frozen: a report for
  a past month is recomputed from the ledger each time.
- Wholesale prices are your assertion, not a vendor-signed rate.
- There is no included-users allowance and no per-reseller discount tier.
- One server is one reseller.
- The Settings screen has no billing view yet.
