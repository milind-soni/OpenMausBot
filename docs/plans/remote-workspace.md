# Plan: Remote Workspace

Run the OpenMausBot server anywhere; connect from the desktop app, any
browser, or the phone — with real authentication instead of the loopback
trust model.

## Why

Three independent demand signals in one week: community members already
self-hosting on VPSes and asking how to connect from their Mac; users
wanting "the chat window from any PC or mobile" because a Linux server
outruns their laptop; and the standing product promise that routines keep
working with the laptop closed. The workload benefits are real: server
hardware is faster, always on, and every engine CLI runs happily headless.

## What exists today

- `docs/self-hosting.md`: the Docker tenant stack (`deploy/`) puts Caddy in
  the server's network namespace with a basic-auth login; the server still
  binds loopback and its Host/Origin gates are satisfied by two header
  rules. This is the hosted path **now**, and it stays valid: Remote
  Workspace replaces the shared password with per-device sessions, not the
  stack.
- The iOS companion already pairs by QR: a short-lived pairing token, a
  durable per-device bearer stored hashed at rest, Tailscale-aware
  advertising. Remote Workspace generalizes exactly this to every client.
- The server serves its own web UI, so "any PC" needs no new app.

## Design in one paragraph

The app learns **environments**: a saved list of workspaces (Local is the
default), each with a stable server identity, a name, a URL and a session.
Adding one uses **one-time pairing**: the server mints a short-lived code
shown as a QR or pairing URL; the client exchanges it once for a durable
per-device session. Remoteness lives only in the connection layer — one
runtime boundary, the same API and event stream, never a second feature
set for "remote".

## Design essentials (from the reference desktop-plus-server design)

We studied a shipped design that solves this same problem for a
desktop-first agent app and adopt these points as requirements:

1. **Stable server identity.** The server generates `environmentId` once
   (`OMB_DATA_DIR/environment-id`) and serves a descriptor at
   `/.well-known/openmausbot/environment` — id, label, platform, version,
   capabilities. Clients verify the id on every connect and refuse a
   mismatch loudly (a re-used URL now pointing at a different server).
2. **Two-stage credentials.** Pairing code: 12 characters from a 32-symbol
   ambiguity-free alphabet (60 bits), rejection-sampled, **5-minute** TTL,
   single use. Exchange it once at `POST /api/auth/pair` for an opaque
   session token: random bytes, **sha256 at rest** (the companion's
   discipline), 30-day expiry, per-device label recorded, revocable from
   Settings. Pairing URLs carry the code in the **hash**, never the query.
3. **Never put the session token in a URL.** The event stream is SSE and
   `EventSource` cannot set headers, so an authenticated `POST
   /api/auth/stream-ticket` mints a purpose-tagged 5-minute ticket and only
   that rides `/api/events?ticket=`. Same rule for any future WebSocket.
4. **Browser clients use a cookie, not local storage.** `httpOnly`,
   `SameSite=Lax`, `Secure` whenever the request arrived over HTTPS, named
   per **port plus an instance hash**. The name only stops two servers on
   one host from overwriting each other's cookie; browsers still send a
   cookie to every port on a host, so isolation between instances comes
   from distinct hostnames, not names. Plain HTTP on a LAN carries the
   cookie in clear and is documented as private-network-only.
5. **Scopes from day one, small.** `client` (chats, rooms, routines,
   approvals) and `admin` (pairing, revocation, engines and MCP config,
   settings). Admin routes are listed in one table next to the gate; the
   rest need `client`. Loopback keeps its implicit `admin` in v1 so the
   desktop app is unchanged, which makes one rule load-bearing: **a proxy
   must never rewrite `Host` to loopback**, or every remote request becomes
   the owner. The Docker stack forwards the real `Host` and relies on
   sessions (its shared password becomes optional); the self-hosting doc
   says so for any other proxy. A config flag later requires sessions
   everywhere for hosted tenants.
6. **Endpoints are hints, ranked.** The server advertises loopback, LAN,
   private-network (Tailscale) and HTTPS endpoints; the user's default is
   remembered by **kind**, so a changed LAN IP does not break it; there is
   no silent fall-back to loopback in a pairing QR. A loopback-only server
   says so instead of printing an unreachable URL.
7. **One supervisor owns reconnection.** Fixed ladder 3 s, 4 s, 8 s, 16 s,
   reset after 30 s stable, offline consumes no attempts, and a hard split
   between *transient* failures (retry) and *blocked* ones (bad
   credential, revoked, unsupported version: wait for the user).
8. **Version skew is a banner with one action**, keyed to a server-advertised
   `selfUpdate` capability: "update the server" for Docker/systemd,
   "update the app" when the desktop app runs the server. Older servers are
   handled by capability absence, never by parsing versions.
9. **Secrets on disk**: directory `0700`, files `0600`, create-once with
   `wx`, atomic temp-and-rename. Signing secrets and session hashes live
   there; nothing secret is ever logged, including tunnel CLI stderr,
   which is classified into a closed label set before it reaches a log.
10. **Launch is not access.** How a server comes to exist (Docker, systemd,
    someone's laptop) is separate from how a client speaks to it (direct
    URL, private network, managed tunnel). Launch provenance is UX only.
11. **Brute-force protection the reference lacks.** Five failed exchanges
    per source in a minute lock pairing for that source for ten minutes,
    thirty across all sources lock everyone for one, and every failure is
    logged with the source. The source is the first `X-Forwarded-For` hop
    only when the connection comes from a proxy on the same machine (the
    server binds loopback, and Caddy overwrites any forwarded header a
    client sent); otherwise it is the socket peer. A consumed code
    presented again by the same source within a minute gets the same
    answer, so a lost response does not strand a device.

## Transports

1. **Explicit URL** for self-hosters: the Docker stack's HTTPS domain, an
   SSH tunnel, or a private network. First to ship.
2. **Private network helper**: detect a Tailscale MagicDNS name and offer
   `tailscale serve` for HTTPS with the server's actual port (TLS is
   Tailscale's; the server never terminates TLS). Shipped for the command
   line as `openmausbot serve --tailscale`.
3. **Managed tunnel**: the cloudflared managed-tunnel channel the companion
   already uses — zero network configuration. Rides on the same sessions.
   Shipped for the command line as `openmausbot login` + `serve --tunnel`
   (`server/tunnel.ts`): the tunnel gateway forwards to a second, IPC
   listener on the harness, on which every request is "through a proxy" by
   construction.

Base URLs are resolved per connection at runtime. Nothing bakes an origin
into the renderer bundle; the served UI keeps using relative paths.

## Capability matrix (v1, stated honestly in the UI)

| Capability | Remote |
|---|---|
| Chats, rooms, coordination, routines, webhooks | ✅ full |
| Engines (all CLIs, custom ACP, OpenAI-compat) | ✅ run on the server, as the server's user and logins |
| Connected apps / custom MCP | ✅ |
| Computer use (cloud/container) | ✅ server-side already |
| Web UI from any browser | ✅ served by the server |
| Built-in browser panel | ❌ local-only for now |
| Skill recorder, dictation, host-desktop control | ❌ local-only |
| "Open in editor" for server paths | ❌ paths shown are the server's |

## Relationship to the enterprise tracks

The session layer is the seam the enterprise identity track extends: a
session gains a `userId` when `users` arrive, and an OIDC proxy in front
(Authentik, oauth2-proxy) can mint sessions from identity headers instead
of pairing codes. Those headers are trusted only from the configured proxy
(the loopback peer, with client-sent copies stripped), never from a direct
client, and that boundary gets its own test. Nothing here is thrown away
by that step.

## Non-goals (v1)

- Desktop-managed SSH launch of remote servers (the Docker path covers it
  without a shell-environment support burden).
- Auto-detected endpoint pickers beyond the Tailscale hint.
- Public-internet exposure without HTTPS and, until sessions land, the
  Docker stack's login wall.

## Sequencing

1. `docs/self-hosting.md` + Docker stack — shipped.
2. Server: environment id + descriptor, pairing + sessions + stream ticket
   + scope table + lockout (~1 week, all under tests).
3. Clients: environments list, pairing screen (paste URL or scan), session
   supervisor, version banner; served web UI gets the cookie path (~1 week).
4. Tailscale helper and managed tunnel for desktop (~3 days each).
5. Enterprise identity extends the seam (separate track).
