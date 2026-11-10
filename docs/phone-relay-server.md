# Phones through MausBot Relay on a self-hosted server

`openmausbot serve --relay` lets the MausBot phone app pair with a server on a
VPS by scanning a QR code, from anywhere: no domain, no open port, no VPN and
no tunnel address. The server dials out to MausBot Relay, the phone dials the
relay, and the relay passes sealed bytes it cannot open. It is the same
end-to-end encrypted connection the desktop app gives phones; the wire spec is
[`companion/src/e2e/README.md`](../companion/src/e2e/README.md).

It is off unless asked for, and it changes nothing about `--tunnel`, your own
domain, `--public-url`, `--lan` or `--tailscale`.

## Use it

```sh
npx openmausbot login --relay   # once: an emailed code signs this machine in; no tunnel address is reserved
npx openmausbot serve --relay   # prints a QR for the phone app once the relay connects
npx openmausbot pair --phone    # a QR for another phone, later
npx openmausbot devices         # every paired device; `devices revoke ID` removes one
```

`--relay` can join `--domain`, `--public-url`, `--tailscale` or `--lan`: those
stay the way in for browsers and the desktop app, and the QR also names the
server's HTTPS address for a phone app that has no encrypted connection yet. It
cannot join `--tunnel` (see "The control plane" below). As a service:
`openmausbot service install --relay`.

With Docker, set `OMB_PHONE_RELAY=1` in `.env` (both compose files pass it
through), `docker compose up -d`, then:

```sh
docker compose exec omb openmausbot login --relay
docker compose exec omb openmausbot pair --phone
```

A fleet container that already has an installation credential can set
`OMB_INSTALLATION_CREDENTIAL` instead of signing in.

A phone code is chat and approvals only (`pair --phone`), as on every other way
in. Up to 20 phones pair through the relay per server.

## What the phone talks to

Over the relay a phone speaks plain HTTP/1.1, carried in yamux streams inside a
Noise session. On a desktop each stream lands on the companion sidecar, which
checks its allowlist and device token and forwards to the harness over
loopback. The sidecar answers three things itself: `POST /api/pair`,
`GET /api/companion/endpoints`, and its computer-viewer relay. Everything else
is the harness's own API.

A self-hosted server is that harness, and the phone app already talks to it
directly over HTTPS: the server answers `POST /api/pair` in the shape the
companion apps decode (`token`, `device`, `serverName`), and the phone then
sends `Authorization: Bearer <session>` on the same API routes. So the server
needs no sidecar. It runs the same end-to-end responder and relay client (the
same code, imported from `companion/src/e2e/`) and hands each stream to its own
request handler. It adds the `e2e` descriptor to the `/api/pair` answer and
answers `/api/companion/endpoints` itself, as the sidecar does.

The QR is the desktop's: an `openmausbot://pair` link with the one-time pairing
credential and `e2e={v:1,k,h,r}` (the server's connection key, its relay host
id and the relay nodes). With a public HTTPS address it has the shape of the
desktop's default QR: that address as the hosted endpoint, which a phone
without the encrypted connection uses and one with it never does. With no
address it names `relay-only.invalid:443`, a name that never resolves
(RFC 6761), so the relay is the only way in.

### Does today's phone app pair with it unchanged?

Probably, and nothing on the server side waits for a phone change; it is not
proven end to end, because the phone apps live in another repository. What
this repository shows:

- The desktop's default QR already leaves the relay as the phone's only
  encrypted route: it carries a hosted address and `e2e`, and the phone never
  uses a hosted address for the encrypted connection, so it pairs through the
  relay with the pairing credential (`companion/src/e2e/README.md`, sections 3
  and 4; `companion/test/e2e/sidecar.test.ts` does exactly this).
- The server presents the same responder, key schedule, relay protocol,
  descriptor and `/api/pair` shape. The tests here pair the reference phone
  (`companion/src/e2e/phone.ts`) with the real server through a relay.
- The server already answers the companion apps' own pairing route, so the
  phone apps pair with servers today through the same `/api/pair` the relay
  carries.

Not verifiable here: whether the store build starts a relay pairing when the
QR's direct address cannot be resolved (the relay-only QR), and whether it
reads a server's answers on routes the sidecar would have filtered. The first
real check is one phone scanning a relay QR from a server; if the store build
refuses the relay-only QR, the change it needs is to try the relay when no
direct route resolves, which is what the spec's route order already says.

Computer viewing and live browser views use WebSocket upgrades. Over the relay
these answer `501` for now, so a phone shows computer access as unavailable;
chat, approvals, events and files work.

## Shared code; the desktop is unchanged

Nothing had to move out of `electron/`. The relay client and the whole
encrypted stack are already plain Node in `companion/src/e2e/`, and the token
refresher (`electron/relay-token.mjs`) and the control plane client
(`electron/control-plane-client.mjs`) import nothing from Electron. The server
already imports both folders (`server/tunnel.ts`, `server/request-auth.ts`).

The one change to shared code: `E2ERegistry` took the sidecar's
`DeviceRegistry`; it now takes the `E2EDevices` interface that registry
already satisfies, and a pairing window may carry the credential's SHA-256
instead of the credential, because a server stores only the digest. The
desktop computes the same values as before; its end-to-end, relay-client,
malicious-relay, vector and sidecar tests pass unchanged. `relay-token.d.mts`
and `relayToken` in `control-plane-client.d.mts` are type declarations only.

## The control plane

`openmausbot login` registers the server as an installation (its platform, and
`appVersion` the npm package's version) and keeps its `omb_install_…`
credential in `tunnel-account.json`, mode 0600. Plain `login` also reserves a
tunnel address; `login --relay` reserves none (the account service's on-demand
path, the one the desktop takes when the relay carries its phones), so a
relay-only server never takes one of the scarce tunnels. A machine that already
ran plain `login` can use the relay as it is. The server asks
`POST /v1/installations/self/relay-token` with exactly the body the desktop
sends, `{appVersion, devices: {e2e, legacy}}`, hourly.

A server qualifies today; no control plane change is needed to get a token:

- The token route takes any installation credential, desktop or server.
- `relayAdmits` asks only whether the relay is on, the installation is not
  blocked, and it is inside `RELAY_ROLLOUT_PERCENT` (100 in `wrangler.jsonc`)
  or named in `RELAY_ALLOW_INSTALLATIONS`.
- `RELAY_CAPABLE_MIN_VERSION` gates tunnel provisioning (`409 relay_capable`),
  not tokens. A published server reports a version such as `0.1.152`, which the
  route accepts; a development build reporting `unknown` is refused (400).

What does need a control plane change, not in this pull request:

- **Servers must be exempt from giving their tunnel back.** The tunnel release
  cron and the legacy-phone cutoff treat an installation that holds a recent
  relay token as carried by the relay. A server's tunnel also serves browsers
  and the desktop app, so once `TUNNEL_LEGACY_PHONE_CUTOFF_PERCENT` is raised,
  a server that has used the relay would be answered `409 relay_capable`
  ("retired") on its next `serve --tunnel`. Until the control plane can tell a
  server apart, `--relay` and `--tunnel` cannot be combined, and a server
  reports every non-relay session as `legacy`, which keeps
  `relay_adoption.legacy_clear_at` empty so the release cron never picks it.
- **The change:** record the kind of installation (`"server"` from
  `openmausbot login` and the fleet; desktop otherwise), and leave servers out
  of the release cron, the cutoff and `relay_capable`. The relay-token schema
  is strict, so the server must not send any new field until a Worker that
  accepts it is deployed; registration is the safer place for it.
- `relay_adoption` and `/healthz relayAdoption` now count servers with
  desktops; the kind above would let them be reported apart.

## Security

**The connection key.** `<data dir>/phone-relay-key.json`, mode 0600, made the
first time the relay runs and never replaced: every phone pinned its public
half from the QR. A file that cannot be read turns the relay off with a log
line rather than making a new key. It is part of the data directory, so a
backup restores it and a restored server keeps its phones. The list of relay
phones is `phone-relay-phones.json`, also 0600; it holds session ids only.

**A compromised relay** sees the host id, the SHA-256 of each admission value,
IP addresses, timing and sizes. It can drop, delay or close sessions and write
any close code. It cannot read or change a byte (Noise `NKpsk0` with AES-GCM
and per-direction counters: a dropped, reordered or replayed record ends the
session), cannot pose as the server (it has no private key), cannot pair a
phone (it never holds a pairing credential, only a digest of a value derived
from it), and cannot mint a relay token (the control plane holds the signing
key). A phone treats only the authenticated GoAway(3) inside the session as
"removed", so a forged 4001 cannot make it forget the server.

**Pairing proves the owner.** The QR carries a 256-bit, single-use pairing
credential that only the owner can mint: `openmausbot pair --phone` on the
machine (the owner, or on a shared server the per-launch owner token `serve`
holds), or a signed-in admin in the web UI. It is both the handshake's key and
the credential `/api/pair` redeems, so only someone holding the QR completes a
handshake at all. The 12-character typed code never works through the relay. A
window lasts 10 minutes unless `--ttl` says otherwise, and the session that
redeems it closes after 150 seconds if it has not paired.

**Not a way around the server's sign-in.** A relayed request reaches the
server's request handler with no peer address, which `request-auth.ts` always
treats as remote; its `Host`, proxy headers, cookies and every
`x-openmausbot-*` header are replaced or removed first. So it is never loopback,
never owner or service trust: it needs a session bearer, the session's scopes
apply (a chat-only phone stays chat-only), and a Team server's per-person rules
apply. Inside one encrypted session only the session whose key opened it is
accepted; before pairing, only `POST /api/pair` and `GET /api/health` are.

**Another account.** The relay identity (`h`) belongs to the installation, so
signing the machine in to a different account gives it a new one, and phones
paired before then pair again. Signing in again to the same account keeps it.

**Removal.** `openmausbot devices revoke ID` (or the web UI) ends the session,
and the phone hears GoAway(3) inside the encryption, then 4001; the relay stops
admitting it at once. A session that expires is removed the same way.

**Shared and Team servers.** A phone acts as the person whose pairing window it
redeemed, exactly as over HTTPS: a member's own phone code makes a phone that is
that member. Service trust is untouched, because no relayed request is local.

**Rate limits.** The relay: 60 new sockets a minute and 256 open per IP; per
server one control socket, 16 phone sessions and 32 admission values. The
server: 16 handshakes at once; 20 relay phones; the pairing lockout (5 wrong in
5 minutes locks pairing for 5 minutes) applies with the relay as one source.
The control plane: 60 relay tokens an hour per installation.

It never runs on a MausBot Cloud, a hosted workspace or the desktop app (whose
companion already carries phones), whatever the environment says.

## When the relay cannot be reached

The server keeps working on every other way in; the relay only adds one. What
`serve --relay` and `pair --phone` say:

| Situation | Line |
|---|---|
| Not signed in, or the sign-in expired | MausBot Relay needs this machine signed in to a MausBot account: `openmausbot login --relay` |
| The control plane says no (rollout, blocked, switched off) | MausBot Relay is not available for this machine right now. The server keeps working here; it asks again every half hour. |
| The control plane does not answer | The MausBot account service did not answer. The server keeps working here and keeps trying. |
| The relay does not answer | Can't reach MausBot Relay yet. The server keeps working here and keeps trying; phones pair once it connects. |

The server log says `phone relay: connecting`, `phone relay: connected via
relay2.openmausbot.com` and `phone relay: relay token …`. It redials at once,
then backs off to a minute, moves to the next node on a restart or refusal, and
renews its token hourly; sessions already open survive a token renewal. A phone
that cannot reach the relay shows "Can't reach MausBot Relay right now. Trying
again…".

## Not yet

- WebSocket routes through the relay (Local VM and computer viewing, live
  browser): they need the upgrade path to accept a socket that is not a TCP
  socket. Medium.
- The web UI: a relay QR in the server's own Settings → Remote access, and the
  relay's state there. Medium.
- `openmausbot setup` and `start` offering the relay, `status` showing it, and
  saving it with the startup choices. Small.
- Moving a phone already paired over HTTPS onto the relay without pairing
  again (trust on first use of `k` from `/api/companion/endpoints`). Small to
  medium, and needs the phone apps' behaviour confirmed.
- The control plane's installation kind and its exemptions, then allowing
  `--relay` with `--tunnel`. Small, plus a migration.
- Renewing the installation credential before its 90 days end. `serve
  --relay` does not run the account service that renews it, so after 90 days
  the relay reports "needs this machine signed in" until `login --relay` is run
  again. Small.
- A check with the store phone apps against a real relay. Small, by hand.
