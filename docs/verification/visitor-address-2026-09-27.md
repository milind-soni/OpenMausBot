# Visitors behind the web app: sign-in and starter credit — 27 September 2026

A dated fixture run of why new accounts from paid ads opened with "$0.00 credit
left", and of the change that lets the server tell those visitors apart. The
live site and API were not touched.

## What was wrong

Browsers reach the API through the web app on Vercel (thenation.city, then
nation-team-chat.vercel.app, then the API machine's own proxy). That proxy sees
only Vercel's few addresses and writes one of them into `X-Forwarded-For`, so
every per-network limit counted Vercel instead of the visitor:

- Starter credit is given at most twice per network per UTC day
  (`NATION_FREE_GRANTS_PER_IP_PER_DAY`, default 2). After the first couple of
  sign-ups through the same Vercel address, every new account opened with
  $0.00 and "Starter credit is unavailable for this device or network."
- Sign-in emails are limited to 20 per network per hour, so a busy hour of ads
  could stop sign-in links for everyone behind the same Vercel address.

`NATION_TRUST_PROXY=1` did not help: it reads `X-Real-IP` as the proxy on the
API machine writes it, which names Vercel as well.

## The change

- `NATION_CLIENT_IP_HEADER` names the header in which the front end names the
  visitor; behind Vercel, `x-vercel-forwarded-for`. It is read only from a
  request that came through the proxy on the API machine, first entry only,
  and only if it is an IP address (`server/request-auth.ts` `clientAddress`).
  The account gateway's sign-in limits and lockout, the address it hands each
  workspace, and the starter-credit grant all use it.
- Anyone who reaches the API machine without Vercel can write that header too.
  Two starter-credit limits do not depend on any header
  (`server/nation-credits.ts`): one grant per inbox (a +tag, and dots in a
  Gmail name, reach the same inbox) and a daily total
  (`NATION_FREE_GRANTS_PER_DAY`, default 1000).
- `NATION_MAGIC_LINKS_PER_NETWORK_PER_HOUR` (default 20) sets the per-network
  sign-in limit, for a front end whose visitors cannot be told apart.
- `GET /api/admin/credits/client-address`, owner/admin only, shows the address
  the owner's own request is counted as, which rule chose it, and the
  candidate headers as they arrived.

## Fixture run

The real server was started twice with `launchVerificationServer`'s `accounts`
option (sign-in mail in the fixture's outbox, a workspace per account, the
founder on the desk) behind a loopback edge that stands for Vercel and the proxy
on the API machine together: it writes `x-vercel-forwarded-for` and
`x-real-ip` as the visitor, and `X-Forwarded-For` as one fixed Vercel address
(`76.76.21.9`) for everyone. Each run: three new people on three networks sign in
by emailed link and open Billing (`/api/credits/status`); the founder signs in
and opens the owner's check; a member tries it; then 25 more people on 25
networks ask for sign-in links in the same hour. The harness was a
session-local script, not a `control-omb` command.

| | A: today's settings | B: `NATION_CLIENT_IP_HEADER=x-vercel-forwarded-for` |
| --- | --- | --- |
| Starter credit, three new accounts | $3, $3, **$0** ("unavailable for this device or network") | $3, $3, $3 |
| Owner's check `address` / `from` | `76.76.21.9` / `proxy` | the founder's own `192.0.2.50` / `x-vercel-forwarded-for` |
| A member opens the owner's check | 403 | 403 |
| 25 more sign-in links in the hour | 15 sent, then 429 "Too many sign-in emails. Try again in 60 minutes." | 25 sent |

(Run A had already sent 5 links through the shared address: three new accounts,
the founder and the member.)

## Unit tests

`server/routes/nation-credits.test.ts` (three visitors through one front end:
[3, 3, 0] before, [3, 3, 3] with the header; the owner's check and its refusal
for members), `server/account-gateway.test.ts` (sign-in limits per visitor; the
visitor's address handed to the workspace; the header ignored unless it came
through the proxy on this machine, is an address, and is named), and
`server/nation-credits.test.ts` / `server/accounts.test.ts` (one grant per
inbox, the daily total, the per-network link setting).
`server/remote-sessions.test.ts` and `server/hosted-access.test.ts` fail the
same 8 tests on main without this change.

## What this does not prove

- That Vercel still names the visitor in `x-vercel-forwarded-for` after the
  request passes through both Vercel projects. The owner's check answers it on
  the live server in one request (below).
- That the API machine's proxy passes `x-vercel-forwarded-for` through
  unchanged (Caddy and nginx do unless told otherwise).

## After the deploy (founder)

1. Deploy the API server with `NATION_CLIENT_IP_HEADER=x-vercel-forwarded-for`
   and restart it; workspaces pick it up as they restart.
2. Signed in as the owner, on a phone with Wi-Fi off, open
   `https://thenation.city/swarm/api/admin/credits/client-address`.
   - `address` is the phone's own public address and `from` is
     `x-vercel-forwarded-for`: done.
   - `address` is a Vercel address although `from` is
     `x-vercel-forwarded-for`: Vercel did not keep the visitor through both
     projects. Look under `headers` for one that holds the phone's address and
     name that one instead; if none does, raise
     `NATION_FREE_GRANTS_PER_IP_PER_DAY` and
     `NATION_MAGIC_LINKS_PER_NETWORK_PER_HOUR` for now. The inbox and daily
     limits stay in force.
3. Sign up with a new address on a phone that has never signed up: Billing
   shows $3.00 credit left.
