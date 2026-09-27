# Credits and VPS review — Base USDC launch candidate

This branch starts at the preserved billing commit and replaces its expiring
allowance design. It also carries the reviewed branding and connector changes.
No merge, deployment, production purchase, or live VPS modification was made.
The combined candidate at `d8fab572acd9fa21795b7490387c906410ca4abc` passes the strict public asset and captured member API guard. Browser and production smoke gates remain pending; this is not a deployment record.

## Current payment configuration (2026-09-26)

This supersedes the Base launch notes further down. Top-up runs on **Robinhood
Chain (4663) only**; Base (8453) is retired and the server ignores
`NATION_TREASURY_BASE`. Both tokens pay the founder's treasury
`0x85E3C2D8f776d9D05b14E108F368070CbD8C1639` (supplied 2026-09-24, confirmed for
Robinhood Chain 2026-09-26). The addresses below pass EIP-55 checksum validation;
their on-chain decimals were not queried from this environment.

| Token | Contract | Decimals | Buyer sends |
| --- | --- | --- | --- |
| USDG (default) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | 6 | the pack price |
| $NATION | `0xc839A88A05B231515a82c71EE97b4F18973C1340` | 18 | pack price × (1 − `NATION_TOKEN_DISCOUNT`) at `NATION_TOKEN_USD_PRICE` |

$NATION is offered only while `NATION_TOKEN_USD_PRICE` is set. A $NATION invoice
records its discount in `discount_bps` and credits the full pack either way; the
status response reports the discount as `nationInvoiceDiscount`, which is what
the Full Plans page shows as "Save 20%". Invoice creation names the token, and
a request without one (an older client) is billed in USDG. The payment scan keeps
one block cursor per chain + token (`credit_scan_cursors`): the former cursor per
chain id let the first token's pass skip blocks for the second, so USDG transfers
were only credited through a pasted hash while $NATION was enabled. How a pass
chooses its blocks, and what it logs when an RPC fails, is under "Payment
scanner" below.
The overlay with the approved values is `deploy/nation-robinhood.env`.

## Payment scanner

`server/nation-payments.ts` scans every 30 seconds, one chain + token pair at a
time, and only while that pair has an unpaid request that is still *fresh*:
unexpired, or expired less than 24 hours ago (`LATE_PAYMENT_WINDOW_MS`).

- **Isolation.** Each token is scanned in its own try/catch. When one fails (RPC
  down, a rejected `eth_getLogs`, a chain id that is not 4663) the others are
  still scanned, the failed token keeps its cursor, and the next pass retries it.
- **Logs.** A failure is one `console.error` line naming the token, chain and
  token contract, with the RPC's own reason, for example
  `NATION payment scan failed for $NATION on Robinhood Chain (chain 4663, token 0xc839…): Request exceeds defined limit. (…)`.
  The RPC URL, request bodies and anything secret-shaped are removed first, so a
  provider key in `NATION_RPC_ROBINHOOD` never reaches the log. A wrong network
  reads `payment RPC reports chain id N, expected 4663; refusing to scan the wrong network`.
- **Cursor lag.** The cursor only moves while a token has fresh requests, so it
  can sit far behind the head after a quiet spell. A pass starts at the later of
  the cursor and the earliest block of any fresh request (no transfer before a
  request's own block can pay it), then scans up to 20 chunks of 500 blocks
  (10,000 blocks), saving the cursor after each chunk. A long gap therefore closes
  in a few passes, and history is never rescanned.
- **Expired requests.** A request that expired more than 24 hours ago no longer
  draws the scan back to its block and never holds up a fresh one; it is still
  matched in any range scanned for a fresh one. Full Plans lists an expired request
  as an inert "Expired" row for 24 hours, then drops it.
- **Transfers that can never pay.** A matching transfer that predates its
  request is logged as "set aside" and skipped, so it cannot pin the cursor; a
  receipt that is not yet visible is retried on the next pass instead.
- **Paying twice.** A second transfer of exactly a credited request's amount is
  never credited again. It is logged as `found a second transfer … already
  credited by …` so the owner can refund it or credit it by hand. A transfer
  already credited from its pasted hash is skipped quietly.

If a transfer for a stale request did land while the scanner was stopped, check
the transaction on the explorer (treasury, token, exact `token_amount`), then
credit the account with Admin → credits adjust, citing the transaction hash in
the reason. The scanner does not do this automatically.

## Stale payment requests (manual, optional)

Full Plans and `/api/credits/status` already hide unpaid requests on Base (8453)
or on any token that is no longer offered, so they need no cleanup. An operator
who wants them out of the table can archive them by hand. Nothing runs this
automatically, and it must never run from CI or against a database you have not
backed up. The API can keep running: SQLite's online backup is safe meanwhile.
Checked against a scratch ledger on 2026-09-26: the preview picks exactly the
Base row and the unpaid request expired over 7 days, the archive moves those two,
paid requests and ledger rows are untouched, and a second run changes nothing.

```sh
cd "$NATION_DATA_DIR"   # the directory holding nation-credits.db
sqlite3 nation-credits.db ".backup 'nation-credits.pre-archive.db'"
sqlite3 nation-credits.db <<'SQL'
-- 1. Preview: unpaid requests on a dropped chain, or expired over 7 days ago.
SELECT id, user_id, chain, token, amount_micros, datetime(expires_at / 1000, 'unixepoch') AS expired
FROM credit_invoices
WHERE paid_tx IS NULL
  AND (chain <> 4663 OR expires_at < (strftime('%s', 'now') - 7 * 86400) * 1000);
SQL
```

Only after reading that list, archive the same rows (the archive keeps every
column, so a row can be copied back):

```sh
sqlite3 nation-credits.db <<'SQL'
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS credit_invoices_archived AS SELECT * FROM credit_invoices WHERE 0;
INSERT INTO credit_invoices_archived SELECT * FROM credit_invoices
WHERE paid_tx IS NULL AND (chain <> 4663 OR expires_at < (strftime('%s', 'now') - 7 * 86400) * 1000);
DELETE FROM credit_invoices
WHERE paid_tx IS NULL AND (chain <> 4663 OR expires_at < (strftime('%s', 'now') - 7 * 86400) * 1000);
COMMIT;
SQL
```

An archived request is no longer matched by the scanner, so a transfer for it
that arrives later is credited by hand as above. Paid requests are never touched.

## Accounting and payment behavior

The authoritative balance is SUM(amount_micros) in `nation-credits.db`, in the
existing resolved data directory. Integer microdollars avoid floating-point
ledger drift. Each free grant, purchase, usage charge or manual adjustment is
one immutable balance row. There is no expiry job, recurring charge, allowance,
approval transaction, or billing contract.

Managed chat requests, every tool round, text helpers and avatar images request
usage accounting and charge actual `usage.cost` multiplied by the configured
markup. `server/spend.ts` owns the admission/settlement path; both the displayed
balance and zero-credit gate use this ledger. All managed turns, including owner/admin turns, are routed
to NATION API; billing exemption does not select a legacy engine. In-flight requests may
finish over the remaining balance; subsequent requests stop. Owner/admin
exemption requires an authenticated admin scope AND a product owner/admin flag.
Exempt calls still record actual provider cost for the daily report.

Missing costs are never estimated as zero. A pending receipt blocks further
spending. The server reconciles provider generation IDs every 30 seconds. After
a crash, unresolved active calls block admission too; automatic reconciliation
waits ten minutes before inspecting abandoned active calls. Across processes,
an unresolved call owned by another worker conservatively blocks concurrent
admission for that account. Admin can resolve a missing receipt only by entering
the confirmed actual cost and an audit reason. Confirm no billing before using
zero. Normal settled usage is never edited by that operation.

An email must come from the existing verified sign-in session. A paired device
alone is not a verified account. Wallet verification uses a five-minute,
single-use, session-bound signed nonce; it authorizes no payment. Starter grants
are unique by account and by inbox (a +tag, and dots in a Gmail name, reach the
same inbox), limited by IP per UTC day and in all per UTC day, and unique per
device cookie. Behind the web app on Vercel the IP is the visitor's only when
`NATION_CLIENT_IP_HEADER` names Vercel's visitor header; otherwise every visitor
counts as Vercel's few addresses. Anyone who reaches the server directly can
write that header, which the inbox and daily limits bound.
IP and device values are hashed in storage. Known disposable email domains and
operator additions are blocked. The bundled disposable-domain list is finite;
maintain the additional list as abuse patterns change. Clearing cookies can
change a browser device identifier; this is not hardware attestation.

Invoices store chain, token, treasury, unique exact microtoken amount and the
creation block. The small matching suffix is added to the selected pack and is
fully credited. Amounts are never reused, even after the 30-minute invoice
window. Late matching transfers remain claimable and are scanned automatically
with persisted block cursors. Payment RPC verifies chain, successful canonical
receipt, token Transfer event, destination, amount and confirmation depth.
Transaction hashes have a unique index. The browser cannot mint credit.

The first launch candidate enabled Base USDC only (chain 8453) with the same
treasury; that path is retired, see "Current payment configuration". A checksum
check does not prove wallet ownership or a completed transfer.
The payment screen offers exact address/amount, an ERC-681 QR, injected-wallet
ERC-20 transfer, and transaction-hash fallback. Wallet network gas is separate.

## Environment and founder decisions

| Setting | Default |
| --- | --- |
| NATION_FREE_CREDIT_USD | 3, allowed 2–5 |
| NATION_CREDIT_MARKUP | 1.0 |
| NATION_LOW_BALANCE_USD | 0.50 |
| NATION_PACKS_USD | 15,49,99 |
| NATION_FREE_GRANTS_PER_IP_PER_DAY | 2 |
| NATION_FREE_GRANTS_PER_DAY | 1000 |
| NATION_CLIENT_IP_HEADER | unset; x-vercel-forwarded-for behind the web app on Vercel |
| NATION_CONFIRMATIONS | 3 |
| NATION_TREASURY_ROBINHOOD | unset; top-up hidden (NATION_TREASURY_BASE is ignored) |
| NATION_TOKEN_USD_PRICE | unset; $NATION not offered |
| NATION_TOKEN_DISCOUNT | 0.2 ($NATION buyers send 20% less), allowed 0–0.9 |
| NATION_RPC_ROBINHOOD | https://rpc.mainnet.chain.robinhood.com |
| NATION_IMAGE_MODEL | openai/gpt-image-2, server-only |
| NATION_TRUST_PROXY | 0 |
| NATION_DISPOSABLE_EMAIL_DOMAINS | empty, extends bundled block list |
| NATION_PRODUCT_OWNER / NATION_PRODUCT_ADMIN | 0; existing authenticated admin scope also required |
| NATION_DATA_DIR | new directory if present, otherwise existing legacy data in place |

The reviewed non-secret overlay is `deploy/nation-robinhood.env`. Apply its
values to the API process configuration during the approved release; it is not a
complete .env file and must not replace existing credentials, owner flags or data
paths. The overlay has not been applied to production by this work. Existing defaults remain as shown
above. RPC capacity, additional disposable domains and proxy configuration remain
operator settings.
The unique amount suffix can be up to $0.999999 and is fully credited; review
that UX before launch. Default markup 1.0 does not cover other operating costs.
Public RPCs may throttle historical receipt scans; retained invoices and pasted
transaction hashes remain available.

## Local validation

Run `pnpm typecheck`, then the focused tests:

```sh
pnpm exec vitest run server/nation-credits.test.ts server/nation-credits.e2e.test.ts server/drivers/openai-chat-tools.test.ts server/spend.test.ts server/avatar-image.test.ts server/request-auth.test.ts
pnpm exec vitest run server/connector-policy.test.ts server/workspace-backup.test.ts server/message-db.test.ts
pnpm exec vite build
pnpm brand-guard
```

The isolated HTTP fixture uses a temporary data directory, a freshly generated
test-wallet signature and a loopback mock provider. It proves $3 free credit,
$0.60 chat debit, $0.10 image debit, the remaining $2.30 chat debit, then HTTP 402
with no further model request. It records actual-cost ledger evidence. RPC tests
cover wrong chain/token/destination/amount, reused hashes, reorgs, failed
receipts and insufficient confirmations. No live keys or paid services are used.
Final independent run on `d8fab572`: frozen dependency install and `pnpm build`
(including both TypeScript checks, Vite and the strict guard) passed. The guard
reported 88 built assets / zero matches, and 89 files / zero matches when adding
the captured member API responses. Eighteen tests across the credit ledger,
real HTTP credit flow and real HTTP import/routine/webhook flow passed in 7.77s.
Earlier focused protocol, workspace restore, privacy and UI checks are recorded
in `branding-audit.md`. No full test suite, real payment or paid model call was
run. Browser verification and founder production smoke remain outstanding.

## Founder-run VPS smoke

Before deployment, preserve the current data inventory:

```sh
cd /opt/nation-team-chat
scripts/smoke-live.sh --record-data
```

After founder deployment, supply a **fresh verified regular test account** token
and a separate owner/admin token through the shell environment, then run:

```sh
scripts/smoke-live.sh --exercise
```

Required settings: `NATION_SMOKE_MEMBER_TOKEN`, `NATION_SMOKE_ADMIN_TOKEN`.
Optional locations: `NATION_SMOKE_SITE` (live /swarm/ URL), `NATION_SMOKE_API`
(http://127.0.0.1:8799), `NATION_SMOKE_OUTPUT` (/tmp/nation-smoke),
`NATION_SMOKE_BASELINE` (saved data-before.json).
For the desktop check supply `NATION_SMOKE_DESK_CONTAINER` for the created bot
and `NATION_SMOKE_WALLPAPER_SHA256` for the approved iOS 27 silver-ribbon asset.
The script saves a desk screenshot, checks the active wallpaper hash and Chrome
process, and requires a working VPS viewer. Review the screenshot too. The
requested wallpaper is not present as a verifiable asset in this checkout;
its live appearance has not been certified or replaced by this work.

The exercise creates a clearly named test bot, spends real test-account credit,
temporarily removes the remainder to test zero, and restores that adjustment
in a finally block. It prints the bot ID for founder cleanup. It never deletes
bots, messages, data directories or production settings. Missing prerequisites
print FAIL, not PASS. Read-only mode also reports unexecuted exercise checks as
FAIL. HTTP failures, unavailable PM2, or a mismatched wallpaper exit nonzero.

The script checks retained bot IDs and message IDs against the before inventory,
plus SQLite quick_check and WAL mode. New credit data has owner-only file
permissions, busy timeout and synchronous FULL. The message DB now sets a
five-second busy timeout before enabling WAL. No specific live WAL warning was
available to reproduce; this change is not a claim that an unseen warning is
fixed. Never delete a WAL file to silence a warning.

## Financial backup and restore

Workspace backups exclude the financial DB and its WAL/SHM and preserve the
current ledger during restore. Rolling back a workspace must not roll back
payment replay protection or credit balances. Back up the financial DB
separately with SQLite's online backup API into an owner-only, encrypted backup
destination. Do not copy only the main file while the API is running. For a
disaster recovery restore, stop spending first and reconcile transfers and usage
since the backup before reopening the service. This PR does not configure an
off-site backup service or migrate data.

## Duplicate nginx server name — inspect, do not apply

The live warning mentions duplicate `hermes.thenation.city` server names. The
actual enabled nginx files were not accessible here, so no filename is invented.
On the VPS, `sudo nginx -T 2>&1` shows each `# configuration file ...` boundary.
Find all `server_name` declarations containing that hostname and compare their
`listen` address/port pairs. Keep the hostname in exactly one server block for
each listen pair (one port-80 and one port-443 block are normal).

The exact directive correction in each **duplicate** block is:

```diff
- server_name hermes.thenation.city other.example;
+ server_name other.example;
```

If the duplicate block serves only that hostname, disable that duplicate enabled
site instead of leaving an empty server_name. Preserve the canonical block's
TLS certificate, locations and upstream. Then the founder runs `sudo nginx -t`
and, only after reviewing the chosen file, reloads nginx. No config edit, reload,
DNS change, or deployment was executed by this work.

Provider reference: https://openrouter.ai/docs/cookbook/administration/usage-accounting
and https://openrouter.ai/docs/guides/overview/multimodal/image-generation.

## Final browser verification

The combined code at `dcea19e5` passed 18 focused ledger/payment and real HTTP
checks, including owner NATION API routing, zero owner deduction and recorded
actual mock cost. TypeScript and the strict public-assets/member-API guard pass.
Brave verified chat submission, code and diagram rendering, neutral unavailable
voice text, hosted settings, and the retained owner credit report. See the dated
evidence in `branding-audit.md`.

Production is unchanged and the Base overlay is not installed in the live API.
Founder review, authenticated live smoke, and the required managed desktop/
approved wallpaper check remain before a complete production-readiness claim.
