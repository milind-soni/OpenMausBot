# Plan: sign in by email (the control plane as an identity provider)

Status: plan, not started. Follows
[`2026-09-07-users-and-roles.md`](./2026-09-07-users-and-roles.md), whose §0
reserved exactly this seam: "the control plane as one more provider". Every
claim about existing code below was checked in the repo.

## The idea, in one line

**The control plane proves *who you are*; the server still decides *what you
may do*.** Email OTP replaces the pairing code as the way a person gets in.
Roles stay in `users.json` on the server. Nothing moves to the cloud.

## Why this is the right shape

The plan's §0 reasons all still hold and this design respects each:

| §0 principle | How this keeps it |
|---|---|
| Authorization must survive the network | The cloud is consulted once, at sign-in. After that a normal local session carries the person; the chokepoint never calls out. Existing sessions keep working if the cloud is down. Pairing codes remain as the no-cloud path. |
| The control plane's `user` is a different noun | It stays that noun. We read one field from it — the verified email — and never write to it. |
| Enforcement and source of truth in one process | Roles, status, visibility: all local, all unchanged. |

What it buys: an admin **adds a person with their email**, and that person
**signs in with their email**. No 12-character code read out loud, no minting
per device. That is the product story for a team on a VPS.

## What already exists (verified)

- `POST /api/auth/send-verification-otp` and `POST /api/auth/sign-in/email-otp`
  on the control plane (better-auth `emailOTP`, 8 digits, 10-minute expiry,
  hashed at rest, 5 attempts). `sign-in` returns the account token in a
  `set-auth-token` header and the user in the body.
- `GET /v1/me` with `Authorization: Bearer <accountToken>` returns
  `{ id, email, name, emailVerified }`. **This is the join key and it exists
  today.**
- `disableSignUp: false` — any email may sign in and gets a control-plane
  account. So "invite by email" needs **no** control-plane change to work.
- A client already implements `requestOTP`, `verifyOTP` and `me`
  (`electron/control-plane-client.mjs`), and the server already uses it for
  `openmausbot login` through `server/tunnel.ts`. Nothing new to write against
  the cloud.
- `openmausbot login` then goes on to `provision()` an installation and an
  endpoint. That half is operator-only and is **not** part of a person's
  sign-in.

## Design

### Flow

```
browser ──► GET /login (served page)
browser ──► POST /api/auth/otp/request {email}
              server ──► control plane: send-verification-otp        (rate-limited, see risks)
browser ──► POST /api/auth/otp/verify {email, code}
              server ──► control plane: sign-in/email-otp ──► accountToken + user
              server:   user.email === email, else refuse
              server:   users.findByEmail(email)
                          none      → 403 "no account for this email; ask an admin to add you"
                          disabled  → 403 "this account is disabled"
                          active    → sessions.upsertSsoSession-style local session, set cookie
              server:   the accountToken is discarded; the local session carries the person
```

The server proxies the OTP calls rather than the browser talking to the cloud
directly. Reasons: the server is the party that must trust the result; the
browser never holds a control-plane token; and the control plane's
`trustedOrigins` would otherwise have to list every deployment's address.

### Data model — no change

`UserRecord` is untouched. `email` becomes what §0 said it would: the
federation join key after an external proof. It is still never an
authentication *factor* on the server — the server does not check passwords or
codes itself; it checks that the cloud vouched for that email.

A session minted this way is a real `SessionRecord` (the `upsertSsoSession`
mechanism from phase 5, with `sso: true`), so streams, disable, revoke, the
ceiling rule and the audit log all work unchanged. Label: "Signed in by email".

### Provisioning policy

Default: **an unknown email is refused.** An admin adds people; the cloud does
not get to create them. `disableSignUp: false` on the control plane means
*anyone* can obtain a cloud account, so auto-granting server access on that
basis would let any stranger with an inbox in.

Opt-in `cloudLogin.autoCreate: true` provisions an unknown email as a `member`.
Phase 5's "first user on an empty roster becomes admin" rule applies only when
the roster is empty, so an SSO-only fresh deployment is not locked out.

### Where the switch lives

A config block, off by default:

```json
{ "cloudLogin": { "enabled": true, "autoCreate": false } }
```

Requires the server to have run `openmausbot login` (so it has an installation
credential; see risks). **Not** behind `entitled("sso")`: this is the product's
own sign-in against its own cloud, which the open-source README rule puts in
core. Third-party identity providers (OIDC, SAML) stay enterprise. Milind's
call to make; the code does not care which.

### Routes

| Route | Scope | Result |
|---|---|---|
| `GET /login` | public (served UI) | the page |
| `POST /api/auth/otp/request` `{email}` | public | **202** always — never reveals whether the email is known |
| `POST /api/auth/otp/verify` `{email, code}` | public | **200** sets the cookie · **401** wrong/expired code · **403** no account / disabled · **429** locked out · **503** cloud unreachable, "pair with a code instead" |

Both public routes get the pairing lockout treatment (`LOCKOUT` in
`sessions.ts`, per source), so the server is not an amplifier for the cloud's
own limits. `GET /api/auth/session` gains `via: "cloud"` so the UI can say how
someone got in.

### CLI

`openmausbot users add --name "Bob" --email bob@x.com` already exists and is
the whole invite. Add one line to its output when cloud login is on: "Bob can
sign in at <address>/login with that email." `pair --user` stays for devices
that cannot do email, and for servers without cloud login.

### What stays exactly the same

Pairing codes, the desktop app (loopback owner), the QR/companion path,
`users.json`, roles, visibility, disable/enable, the audit trail, and every
test that exists today.

## Tests

- Unit (`cloud-login.test.ts`, with a stubbed control plane like
  `server/testing/control-plane-stub.ts` already provides): known active email
  → session bound to that user; unknown email → 403 and nothing created;
  `autoCreate` → member, or admin on an empty roster; disabled → 403; email in
  the cloud's reply not matching the requested email → refused; cloud down →
  503, and an existing session still authenticates; lockout after N failures.
- e2e (extend `users-rbac.e2e.test.ts`): sign in as a member by email over the
  remote harness, hit a client route (200) and an admin route (403), get
  disabled, get 403 with the account message, get enabled, same cookie works.
- The existing 2,600 tests must pass untouched: with `cloudLogin` absent the
  new routes return 404 and nothing else changes.

## Risks, and one thing on Milind's side

- **Rate limits collapse onto the server's IP.** The control plane keys OTP
  rate limits on `cf-connecting-ip` (5 sends/minute, 10 verifies/minute). With
  the server proxying, *every* person on a deployment shares one bucket: five
  sign-ins a minute for the whole team, and one impatient person locks out
  everyone. **Control-plane change (Milind):** let a request that carries an
  installation credential be rate-limited per installation (or per a
  forwarded client address the installation vouches for) instead of per IP.
  The server already holds that credential after `openmausbot login`. Until
  then, the server-side lockout keeps it from being worse than it is, and the
  limit is documented.
- **Cloud accounts are open.** Anyone can make one. Mitigated by refusing
  unknown emails by default; `autoCreate` is the operator's informed choice.
- **A person's control-plane email changes.** Their local account no longer
  matches and they are refused until an admin edits the email. Acceptable, and
  loud.
- **Cloud outage.** Sign-in fails with a clear 503 and the pairing path is
  offered. Nobody already signed in is affected. This is the property §0 was
  protecting.
- **Not a replacement for pairing.** Air-gapped and LAN-only servers never
  turn this on and lose nothing.

## Out of scope

Password login, magic links, social providers, OIDC/SAML (enterprise), moving
roles to the cloud, per-organisation tenancy, and the SQLite question below.

---

# Appendix: should users move to SQLite?

**Not yet — and when they do, not alone.**

What is true today: transcripts live in `messages.db` (`node:sqlite`, WAL,
0600, dependency-free — `server/message-db.ts`), because a long thread
rewrote a multi-megabyte JSON file on every message. Bots, sessions, config
and now users are JSON files with atomic 0600 writes. `sessions.json` has run
that way in the field for a while.

Why JSON is right for `users.json` now: a roster is tens of rows, loaded once
at boot, written on an admin action. Atomic rename gives crash safety; the
file pattern is the one `sessions.json` already proved. Moving users alone
would leave sessions and the audit log where they are and unify nothing.

The real triggers, when they arrive:

1. **Custom roles and per-resource ACLs** (the full form of phase 3 and 4).
   Roles-as-rows, permission sets, and "which people may see which bots" are
   relational; at that point a table earns its keep — and the schema changes
   anyway, so doing SQLite *before* it means migrating twice.
2. **Audit retention and export** for an enterprise deployment. NDJSON with
   a 4 MB rotation (≈8 MB total) is fine for a team and wrong for compliance.
   That is the enterprise panel's concern, phase 6.
3. **Cross-record atomicity.** Disabling a person and cancelling their
   pairings are two writes today. It is safe — the chokepoint re-checks
   status on every request — but a transaction is cleaner.

When one of those lands: one `auth.db` holding users, sessions and audit
together, on the `message-db.ts` pattern (open with 0600, WAL, lazy one-time
import of the legacy JSON, which is exactly how transcripts migrated). One
migration, not three. Roughly two to three days.
