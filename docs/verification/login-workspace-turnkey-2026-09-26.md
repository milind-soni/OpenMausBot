# Email sign-in, a workspace per account, and the NATION wallet — 2026-09-26 record

A dated fixture run of public sign-up on the founder's server: anyone signs in
with an emailed link and gets a workspace of their own, isolated from the
founder desk and from every other account, on the free plan with starter
credit; Full Plans can be paid from a passkey-held NATION wallet. The last
sections are the deploy settings and the check the founder runs after the
deploy; nothing here proves real email delivery, the real wallet service or
live Robinhood Chain credit.

## How it works

- **Sign-in.** `POST /api/auth/magic/start` emails a link to
  `OMB_PUBLIC_URL/#login=<token>`. The token is 256 random bits stored as a
  sha256 only; it lives 15 minutes and works once, and using it retires the
  other open links for that address. The app asks "Continue as …" before
  using it, so a mail scanner that opens links cannot spend it. Limits: 3 links
  per address per 15 minutes, 20 per network per hour, 500 per hour in all.
  The link is only ever built from the configured app address, never from
  request headers.
- **Who goes where.** An address on the desk's own sign-in list
  (`OMB_SIGNIN_EMAILS`, `OMB_SIGNIN_MEMBER_EMAILS`) gets an ordinary desk
  session, as the emailed-code sign-in gives today. Everyone else gets an
  account cookie (`nation_account`) and their own workspace, created on first
  sign-in. Pairing codes are not part of sign-up; `/pair` is unchanged for the
  founder's own devices. A second device joins an account's workspace by
  signing in with the same email.
- **Isolation is a separate data root.** Each workspace is its own server
  process over `<data dir>/workspaces/<workspace id>/`, started on first use
  on loopback ports. The public server forwards every API request that carries
  an account cookie to it, with a `client`-scope session it minted there over
  loopback (a key made for that start), never as the loopback owner. An
  account cookie never reaches the desk: a stale, cross-site or forged one is
  refused. A workspace runs NATION API only (no command-line engines, desks,
  browser or computers; since the
  [member workspace computers record](workspace-computers-2026-09-27.md), a
  cloud computer and a guarded browser), gets an explicit list of environment
  values (model, search, connected-app, wallet and credit settings; never the
  desk's data directory, sign-in lists, mail or desk credentials), and is
  never the product owner.
- **Credits.** Each account's credit id is `email:<sha256(email)>`. Workspaces
  share the public server's ledger file, so invoice amounts stay unique and
  the one payment scan (on the public server) credits every account. Starter
  credit follows the existing rules: once per account, one per device, a
  per-network daily cap.
- **NATION wallet.** A Turnkey sub-organization per credit account whose only
  root credential is the person's passkey, with one Ethereum account. The
  server can create the wallet but never move its funds. To pay, the server
  prepares the exact transfer for one open invoice (token, treasury, amount,
  chain 4663), the passkey approves that request in the browser, and the
  server forwards it only if it is still exactly that transfer, checks the
  signed transaction again, and broadcasts it. The payment scan credits it like
  any other transfer; paying from a connected wallet and pasting a transaction
  hash work as before.
- **For members.** Settings shows who is signed in with Sign out, and Billing &
  Credits leads with the plan and balance. A member never sees the operator's
  controls (group turns, parallel threads, log cleanup, diagnostics, People,
  Backups) or desk setup. In their own workspace a member saves their own
  welcome-flow progress, language and name through
  `PATCH /api/workspace/preferences`, so the Nation welcome shows once.

## Setup

- The real server (`server/index.ts`, via `launchVerificationServer`'s new
  `accounts` option) in a temporary home and data directory with the hermetic
  environment, plus: `NATION_ACCOUNTS=1`, sign-in mail to the fixture's own
  outbox, `founder@example.test` on `OMB_SIGNIN_EMAILS`,
  `NATION_PRODUCT_OWNER=1`, a loopback model provider, treasury
  `0x85E3C2D8f776d9D05b14E108F368070CbD8C1639`,
  `NATION_TOKEN_USD_PRICE=0.000286`, one confirmation and a 5 s scan.
- Loopback stand-ins: Robinhood Chain (4663) with balances, raw-transaction
  broadcast and the Transfer logs, receipts and blocks the scan reads
  (`server/testing/fake-robinhood-chain.ts`); and the wallet service
  (`server/testing/fake-turnkey.ts`), which verifies our API-key stamp
  (P-256 over the exact body) and that each sign request carries the wallet's
  own passkey approval over hex(sha256(body)), then signs with a local key.
- The founder desk seeded with "Desk Echo", "Desk Pebble", "Desk Yuki" and a
  conversation.
- The production build (base `/swarm/`) behind a proxy that adds
  `X-Forwarded-For/Proto/Host` as the production path does, so no browser is
  ever the loopback owner. Driven by headless Chromium; Alice's passkey is a
  CDP virtual authenticator (a platform passkey on `localhost`).

## Browser checks — 38 of 38 passed, no page errors

| Check | Result |
| --- | --- |
| A stranger sees the Nation sign-in page, not the desk | pass |
| The email is a Nation Team Chat sign-in link to the app, no other name | pass |
| The confirm screen names the address before the link is used | pass |
| A new workspace opens with the Nation welcome | pass |
| The welcome is Nation-branded with no engines step | pass |
| Alice's session is an account session, `client` scope only | pass |
| Alice's desk is new: no founder teammates, no shared ids | pass |
| The founder's conversation is not reachable from Alice's browser (404) | pass |
| The welcome flow is saved: it does not reopen after a reload | pass |
| Alice's workspace config: member, personal workspace, onboarding saved | pass |
| Her teammate answers (NATION API, in her own workspace) | pass |
| Settings → General: signed in as Alice, with Sign out | pass |
| Settings: no operator controls or desk setup for a member | pass |
| Settings → Usage: "Free plan · $3.00 credit left", with Top up | pass |
| Full Plans offers USDG (the default) and $NATION with its saving | pass |
| Full Plans: Free is Alice's current plan with $3 starter credit | pass |
| Credits status: `exempt: false`, `onFreePlan: true`, `starterCreditUsd: 3`, granted | pass |
| Starter checkout: USDG to the treasury on Robinhood Chain | pass |
| Checkout offers the NATION wallet next to a connected wallet and paste-a-hash | pass |
| A passkey on this device created a NATION wallet | pass |
| The passkey-approved payment is credited by the payment scan (9 s) | pass |
| The wallet service saw one API-key request and one passkey approval | pass |
| The treasury received exactly the invoice amount | pass |
| After paying: `plan: "paid"`, `onFreePlan: false` | pass |
| Bob has his own new workspace: none of Alice's or the founder's teammates | pass |
| Alice's conversation is not reachable from Bob's browser | pass |
| Bob: free plan, $3 starter credit, none of Alice's payment | pass |
| Bob has no NATION wallet (Alice's is hers) | pass |
| The founder's email signs in to the desk with admin scope | pass |
| The founder desk is unchanged: its teammates, none of Alice's | pass |
| The founder's own history is there | pass |
| The founder is exempt and still sees Top up | pass |
| The founder's Settings keep every operator section | pass |
| 390 px: the sign-in page fits without horizontal scrolling | pass |
| The sign-in page offers email only: no access codes or pairing | pass |
| No server log (public server or either workspace) records a listener error or crash | pass |
| Three accounts, two workspaces: the founder's email never got one | pass |
| Every account request went through the proxy with an account cookie | pass |

The brief's acceptance tests map to these: user A sees a new desk, not the
founder's history; user B sees none of A's teammates, conversations, wallet or
credit; the founder's email reaches the founder desk only; A's credits read
`exempt: false`, `onFreePlan: true`, starter $3.

Starter teammates are named from a pool of 64 names (`server/names.ts`), so a
new workspace can have its own "Echo" (Bob's did in one run). It is a new
teammate with no history; the checks compare ids, not names.

## Found on the way, and fixed

- **Hundreds of empty conversations on a first visit.** A member's first look
  at a teammate creates that account's own conversation with it. The store
  announced the new conversation before it was claimed, and projecting that
  announcement for the same account's open event stream created another, and
  so on until the stack ran out ("store: change listener threw RangeError").
  A new account's first load left 436 conversations behind. The same path
  exists on main for members of a shared desk. Creation is now guarded per
  account and teammate; the end-to-end test finds 415 without the guard and 1
  with it.
- **A sign-in link opened in the same tab.** Opening a `#login=` link in a tab
  that already shows the app or the sign-in page changes only the fragment,
  which reloads nothing, so the page kept saying "Check your email". The app
  now starts again when a login fragment arrives.

Harness notes: the first browser run stopped on the driver's own parse of the
checkout amount (the fixture's control route then crashed on it); the driver
now reads the invoice from the API and the route rejects bad input. A second
run had two driver mistakes (an upper-cased label read by `innerText`, the
founder's account menu labelled with the profile name). The run above is a
clean start.

## Screenshots

| Sign in | Check your email | Confirm the link |
| --- | --- | --- |
| ![Nation sign-in page](images/login-workspace-turnkey/sign-in.jpg) | ![Check your email](images/login-workspace-turnkey/check-email.jpg) | ![Continue as alice@example.test](images/login-workspace-turnkey/confirm-link.jpg) |

| Welcome | New workspace | First chat |
| --- | --- | --- |
| ![Nation welcome flow](images/login-workspace-turnkey/welcome.jpg) | ![A new workspace with one teammate](images/login-workspace-turnkey/new-workspace.jpg) | ![First chat in her own workspace](images/login-workspace-turnkey/first-chat.jpg) |

| Member Settings: account | Member Settings: billing |
| --- | --- |
| ![Signed in as alice, Sign out](images/login-workspace-turnkey/member-account.jpg) | ![Free plan and $3 credit, Top up](images/login-workspace-turnkey/member-billing.jpg) |

| Full Plans, free plan | Checkout with the NATION wallet |
| --- | --- |
| ![Full Plans, Free is current, USDG and $NATION](images/login-workspace-turnkey/full-plans-free.jpg) | ![Starter checkout offering the NATION wallet](images/login-workspace-turnkey/checkout-nation-wallet.jpg) |

| NATION wallet funded | Payment verified | Full Plans after paying |
| --- | --- | --- |
| ![Wallet address and balances, Pay from NATION wallet](images/login-workspace-turnkey/nation-wallet-funded.jpg) | ![Payment verified](images/login-workspace-turnkey/payment-verified.jpg) | ![Full Plans after the Starter payment](images/login-workspace-turnkey/full-plans-after-payment.jpg) |

| Second account | Founder desk | Founder Settings |
| --- | --- | --- |
| ![Bob's own workspace](images/login-workspace-turnkey/second-account.jpg) | ![The founder desk, unchanged](images/login-workspace-turnkey/founder-desk.jpg) | ![The founder's Settings keep every section](images/login-workspace-turnkey/founder-settings.jpg) |

![Sign-in at 390 px](images/login-workspace-turnkey/sign-in-390.jpg)

## Automated tests

- `server/accounts.test.ts`: addresses, link lifetime and single use,
  retiring other links, rate limits per address, network and hour, only
  digests stored, one user and one workspace per address, the workspace limit,
  session renewal and the absolute cap, restart.
- `server/account-mail.test.ts`: the email names only Nation Team Chat,
  escapes HTML, SMTP with the configured sender, an owner-only outbox.
- `server/account-gateway.test.ts`: links only from the configured address
  (a forged Host is ignored; nothing is sent through a proxy without one), the
  founder and invited members go to the desk, a full workspace limit does not
  spend the link, wrong tokens count against the caller, account requests are
  forwarded with the caller's address, cross-site, stale and signed-out cookies
  never reach the desk.
- `server/workspace-host.test.ts`: what a workspace server inherits and never
  inherits, its config (NATION API only, desks and keys dropped), the
  forwarding boundary in both directions, one start for concurrent requests,
  event streaming, idle stop unless busy or kept awake by a routine, the
  running limit, crash restart, a refused credential re-minted without a
  sign-in error.
- `server/routes/nation-wallet.test.ts`: off without Turnkey credentials, the
  API-key stamp, one wallet per account named without the person, balance and
  fee checks, USDG and $NATION payments credited by the scan, nothing
  forwarded that is not exactly the invoice's transfer, nothing broadcast that
  the wallet service signed differently, a sign request finished later.
- `server/routes/workspace-preferences.test.ts`: allowed in one's own
  workspace, refused on a shared desk, an admin anywhere, three settings only.
- `server/nation-accounts.e2e.test.ts`: the whole flow through the real HTTP
  API with the real workspace servers: two strangers, the founder, separate
  data roots, the shared ledger, a NATION-wallet Starter payment credited by
  the public server's scan, preferences, one conversation per first look, and
  refused cross-site, stale and forged requests.
- `src/components/NationWalletPay.test.ts`,
  `src/components/nation-account-settings.test.ts`: the wallet panel's states,
  the passkey challenge format, member Settings for one's own workspace, a
  shared desk and the owner.
- Baselines: `server/index.test.ts` has the same 47 failures as main, and the
  client suite the same 86; none is new.

## What this does not prove

- No real mail provider or inbox: the email is read from the fixture's
  outbox. Send one real link to yourself after configuring SMTP.
- No real Turnkey API. The stand-in checks our API-key stamp
  cryptographically and the passkey challenge binding, following Turnkey's
  published request types (`@turnkey/http` 6.6.0) and stampers
  (`@turnkey/api-key-stamper` 0.6.17, `@turnkey/webauthn-stamper` 0.6.0), but
  not Turnkey's own WebAuthn verification or organization policies. Create the
  first real wallet and pay a Starter from it before announcing the wallet.
- A virtual authenticator, not a phone or laptop. Passkeys belong to the site's
  host (`thenation.city`); a preview domain gets its own and cannot use the
  production wallet.
- No real Robinhood Chain: fee estimation and gas came from the stand-in.
- The production proxies were not used; the stand-in adds the same kinds of
  forwarded headers.
- Capacity: one workspace server measured about 200 MB after a turn (the
  public server about 190 MB). The running limit defaults to 8.
- Existing, not addressed here: default teammate faces are addressed as
  `/bot-faces/*.svg` and a tour image as `/nation-logo.svg` at the site root,
  which the web build does not serve (the app falls back to its mascots), and
  one English settings string contains mis-encoded punctuation.

## Deploy settings

On the API server (see `deploy/nation.env.example`; secrets only in the process
environment):

- `NATION_ACCOUNTS=1`
- `OMB_PUBLIC_URL=https://thenation.city/swarm`
- `OMB_SIGNIN_EMAILS=<the founder's own address(es)>` so the founder lands on
  the desk; `OMB_SIGNIN_MEMBER_EMAILS` keeps any invited desk members there
- `NATION_SMTP_URL=smtps://user:password@host:465` and
  `NATION_MAIL_FROM="Nation Team Chat <login@thenation.city>"`
- `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`,
  `TURNKEY_API_PRIVATE_KEY`: NATION's parent organization and a P-256 API key
  for it that may create sub-organizations; all empty hides the NATION wallet
- Already set for the web app: `NATION_TRUSTED_ORIGINS=https://thenation.city`,
  the Robinhood treasury, RPC and `NATION_TOKEN_USD_PRICE`
- Optional: `NATION_WORKSPACE_MAX_RUNNING` (8), `NATION_WORKSPACE_IDLE_MINUTES`
  (30), `NATION_WORKSPACE_MAX_TOTAL` (500), `NATION_MAGIC_LINK_TTL_MINUTES`
  (15), `NATION_MAGIC_LINKS_PER_HOUR` (500)
- Each workspace server is started with this server's own entry point and
  Node flags. Under PM2 the script path is read from PM2; any other wrapper
  needs `NATION_WORKSPACE_SERVER_ENTRY=<path to server/index.ts or
  dist-server/index.js>`. A workspace stops by itself when the server that
  started it is gone.
- `NATION_TRUST_PROXY`: behind the web app's rewrite, every browser reaches the
  server from the proxy's few addresses, so per-network limits (sign-in links,
  starter credit per network per day) count the proxy. Set it to 1 only if the
  proxy in front overwrites `X-Real-IP` with the browser's address.

New data under the data directory: `nation-accounts.db` (accounts, links,
account sessions) and `workspaces/` (one folder per account). Include both in
backups. The web app needs no change: `/swarm/api/*` already reaches the server.

## Check after the deploy (founder)

Record each step's screenshot, and the values asked for, in this file.

1. Open `https://thenation.city/swarm` in a private window: "Sign in to Nation
   Team Chat", email only.
2. Enter a test address you can read (not on `OMB_SIGNIN_EMAILS`). Open the
   email ("Your Nation Team Chat sign-in link"), then Continue. A new workspace
   opens with the Nation welcome and one new teammate, none of the desk's.
3. Settings shows "Signed in as …" and Billing & Credits "Free plan · $3.00
   credit left". Full Plans: Free is the current plan, "$3 starter credit".
4. Choose Starter with USDG. Either create the NATION wallet (a passkey prompt),
   send it the USDG amount plus a little ETH for the fee on Robinhood Chain and
   pay from it, or pay from a connected wallet. Within about a minute: "Payment
   verified". Record the transaction hash and the minutes from send to credit.
5. In a second private window, sign in with a second address: another new
   workspace, with none of the first one's teammates or payment.
6. Sign in with the founder's address: the desk, unchanged.
7. On the server: `ls <data dir>/workspaces` lists two folders; the log has
   `email sign-in: new workspace …` twice and, for a wallet payment,
   `NATION wallet: payment for invoice … sent in 0x…`.

## Not in this change

- Google sign-in (no stub was added).
- Recovering a NATION wallet without its passkey: the passkey is the only way
  in, by design for now; keep balances small until recovery is added.
- Deleting or exporting an account, an admin list of accounts, and a member
  deleting their own teammates (a member session cannot delete bots yet).
