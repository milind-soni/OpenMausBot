# companion

The sidecar a phone talks to.

OpenMausBot's harness listens on `127.0.0.1` and nothing else, which is the
right default and one it has recently gone out of its way to enforce: it now
rejects any request whose `Host` is not loopback, defeating DNS rebinding.

This is a separate process that sits in front of it. A paired device reaches
*this*, over the LAN or a tailnet; this reaches the harness over loopback, as
a request from the machine the harness already trusts. The harness keeps its
loopback-only bind and gains only the paged/read/approval verbs the native
client needs; pairing, device tokens, network exposure, and response scrubbing
remain entirely in the sidecar.

That is the entire point of the design. The alternative — teaching the harness
to bind a second socket — means a patch to somebody else's request handler,
carried across every release, and it is the patch that broke the first time
upstream hardened its loopback gate.

```text
  phone ──HTTPS/LAN/tailnet──▶ companion :8810 ──loopback──▶ harness :8799
                          ▲                             ▲
                          │ token, allowlist,           │ unmodified,
                          │ Origin refused              │ loopback-only
```

## What it is responsible for

| | |
|---|---|
| **Pairing** | A high-entropy QR credential plus a six-digit manual fallback, valid two minutes and single-use. Redeeming either returns a device token stored only as a SHA-256 digest. |
| **Authorisation** | Every request needs that token. Full cloud-desktop access is a separate per-device capability, off by default. A rebinding page cannot obtain either. |
| **The allowlist** | Default deny, per method and path (`src/routes.ts`) — the list is every request the app makes, and nothing else. General bot/room PATCH routes stay closed; read state and approval grants use narrow verbs. A route that appears in the harness later is closed to devices until someone adds it here on purpose. |
| **Scrubbing** | `resumeCursors` — the harness's own provider session ids — never reach a device, whether or not the harness still sends them. |
| **Discovery** | Bonjour, so a phone finds the computer by name instead of by typed address. |
| **Secure credential relay** | Carries an HPKE envelope for one pending, allowlisted credential card. The sidecar never receives the desktop private key or plaintext. |

## Transport security

The optional hosted route uses certificate-validated HTTPS. Direct routes use
plain HTTP, and the device token travels in a header on every request. Where a
direct route is safe depends on how the phone reaches the computer:

- **Over hosted HTTPS** — the recommended remote route — TLS encrypts and
  authenticates the connection through the outbound desktop connector.

- **Over a tailnet** — the recommended direct route away from home — every
  packet is inside WireGuard before it touches a network, so
  the connection is encrypted and authenticated end to end despite the `http`
  in the URL.
- **Over a LAN** it is cleartext on that network. Trust it as far as you trust
  everyone on the wifi: fine at home, not fine on a café or conference network.
  Pair over the tailnet there instead.

The phone never submits credential envelopes over LAN or Bonjour HTTP. That
operation requires hosted HTTPS or Tailscale so its reusable device token is
protected as well as the HPKE-encrypted value. Ordinary local chat and approval
traffic keep the documented trusted-network behavior above.

Turning on TLS is not a drop-in improvement. A certificate for a LAN address
is one nothing can validate, so it would have to be pinned at pairing and
re-pinned whenever the sidecar regenerated it — real machinery, whose benefit
on the tailnet path is zero. Pinned TLS is what this would need before it could
claim to protect the LAN path; until then the LAN path is documented as
trusted-network-only rather than described as something it is not.

## What it deliberately does not do

- **Serve the desktop UI.** A phone asking for `/` gets a 404. Serving HTML
  here would make this a web server, which it is not.
- **Accept anything with an `Origin` header.** A native app sends none, so a
  request that carries one is a browser that has found this port. Refused
  before the token is even looked at — stricter than the harness's own rule,
  which allows loopback origins.
- **Hold credentials, settings, or Local VM control.** Credential plaintext
  remains transient on the phone and desktop only: the sidecar can carry one
  QR-keyed HPKE envelope for an exact pending card, but cannot open or retain
  it. General credential/configuration routes, settings, and Local VM control
  remain unavailable. See `src/routes.ts` for the exact boundary.

## Running it

With the harness already up (`pnpm dev:server`), from the repo root:

```sh
pnpm companion
```

It prints where to point the phone, and where you pair:

```text
companion  http://0.0.0.0:8810  →  harness 127.0.0.1:8799
pair here  http://127.0.0.1:8811
on the device, enter  macbook.tail1234.ts.net:8810
```

Open the pairing page, click **Start pairing**, and type the six digits into
the phone. The normal desktop panel also turns that short-lived code and the
dialable address into a QR handoff, so the mobile app can fill both in without
putting the long-lived device token in the QR. Stopping the process is the off
switch — running it *is* the opt-in, so there is no toggle to forget.

That is the standalone way to run it, and it is what to reach for when the
harness is running on its own — a headless box, or `pnpm dev:server` in a
terminal. **The normal desktop workflow is Settings → Remote access**, which
starts and stops this same sidecar as a child process and offers pairing and
revocation inline; the loopback page above is the same API rendered for
people not running the desktop app. Either way the sidecar only listens while
it is switched on, so the opt-in is never implicit.

| Environment | Default | |
|---|---|---|
| `OMB_PORT` | `8799` | where the harness is |
| `OMB_WEBHOOK_PORT` | `OMB_PORT` + 1 | the harness's webhook receiver — refused, not used |
| `OMB_COMPANION_PORT` | `8810` | where devices connect |
| `OMB_CONTROL_PORT` | `8811` | the pairing page, loopback only |
| `OMB_COMPANION_DIR` | `~/.openmausbot-companion` | paired devices live here |
| `OMB_COMPANION_NAME` | your name, from the harness | what the phone calls this computer |

`OMB_COMPANION_NAME` overrides a name the sidecar otherwise asks the harness
for at startup — the profile from onboarding, as *"Ada's computer"*. It falls
back to `OpenMausBot` when the harness is not up or has no profile. Read once
and cached: the name goes into the Bonjour record, and re-advertising under a
new one later would show the phone two computers.

The harness owns two ports, not one: itself, and a webhook receiver one above
it (`OMB_WEBHOOK_PORT`). The companion refuses to start on either and says
which — the alternative is a race for the socket, where starting second means
the companion will not come up and starting first means webhooks quietly stop
working with the explanation logged somewhere else entirely.

## Layout

```text
src/index.ts    the entrypoint — three sockets, and the split between them
src/proxy.ts    the forwarding handler; also owns /api/pair
src/routes.ts   the allowlist — what a device may ask for
src/wire.ts     scrubbing, including the SSE stream transform
src/control.ts  the loopback pairing page
src/devices.ts  pairing codes and device tokens
src/listener.ts LAN and tailnet addresses
src/mdns.ts     the zero-dependency Bonjour responder
src/state.ts    where paired devices are written, atomically
test/           run against a real harness, booted per file
```

## Tests

`pnpm test` from the repo root covers this alongside everything else.

`test/proxy.test.ts` boots the real harness and drives the real proxy, because
every bug this design can have lives in the seam between them: an SSE event
that never terminates, a resume cursor dropped in transit, a `content-length`
set beside a `transfer-encoding`. None of those are visible to a unit test —
the last one was found by this suite within a minute of it existing.
