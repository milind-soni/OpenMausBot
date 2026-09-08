# Plan: users and roles (phase 1 of RBAC)

Status: **all six phases implemented** on branch `feat/rbac-users` (one commit
each). Phase 1 is fully tested (`server/users-rbac.e2e.test.ts` + unit
suites); phases 2–6 are implemented and typecheck/lint clean but their own
tests are still to be written — see each commit message. Built in one session
for a demo; treat 2–6 as unverified until their tests land.

Commit map: 1 users `e1974e7d` · 2 audit `31ade002` · 3 permissions
`1f2651df` · 4 bot visibility `16b1f7ca` · 5 SSO `db1ce1ca` · 6 People panel
`9f406f4a`.

Merged from three independent plans on 2026-09-07. Where they disagreed, the
choice and the reason are stated inline. Every claim about the current code
was checked in the repo before it went in here.

Give the server a notion of *people*, not just devices, and make every
authorization decision answer "who" before it answers "may they". Phase 1
adds the subject. Later phases add the audit trail, the verbs, the nouns,
identity providers and the panel.

---

## 0. The load-bearing decision: accounts live on the server

**User accounts are server-local state in `$OMB_DATA_DIR/users.json`, next to
`sessions.json`, owned by the server that enforces them.** Not the Cloudflare
control plane, not federated. All three plans reached this independently.

Why:

1. **Authorization must survive the network.** The server runs offline —
   loopback, LAN, tailnet, air-gapped. A user table in the Worker means either
   a local cache (which *is* a local table, with a staleness bug) or a hard
   dependency on a cloud the deployment never asked for.
2. **The control plane's `user` is a different noun.** Its better-auth table
   exists so `openmausbot login` can reserve a public address for a machine.
   It answers "who owns this endpoint", not "who may operate this fleet".
3. **Enforcement and source of truth stay in one process.** Separating them by
   a network is how confused-deputy bugs grow.

How the other answers stay open: the user `id` is the join key, and `email`
is never an authentication factor. A later identity provider (OIDC header
trust under `entitled("sso")`, or the control plane as one more provider)
resolves an external subject to a local `id` and mints a session for it. No
field is reserved for that today — an optional field added later needs no
migration, because zod strips and tolerates unknown keys.

---

## 1. Phases

| # | Phase | Depends on | Size | Why here |
|---|---|---|---|---|
| 1 | **Users** — people exist; every new device belongs to one; disable/remove; lockout guards; CLI | nothing | M, ~1 week with tests | The subject. Only phase that can be invisible to existing deployments. |
| 2 | **Human-action audit** — `audit.ndjson` in the `decision-log.ts` pattern: user CRUD, role changes, pairing mints, revocations, with the actor | 1 | S, 2 days | Needs only a subject. Must exist before a panel can disable accounts unrecorded. |
| 3 | **Permissions as data** — replace the `Scope` union with a role → permission table; `admin`/`client` become a compatibility projection; `requiredScope()` consults the table | 1, 2 | L, 2–3 weeks | Touches the chokepoint and the allowlist: riskiest surface, so it lands after users and audit exist to test against. |
| 4 | **Resource scoping** — owners on bots/rooms/folders; who sees what; SSE fan-out filtered | 1, 3 | L, 1–2 weeks | Invents a noun that does not exist today; needs the verbs from 3. |
| 5 | **Identity providers + entitlements** — first `entitled()` call sites; OIDC-header trust that maps to a local user | 1, 3 | M, 2 weeks | Needs the model and the vocabulary the licence gates. |
| 6 | **Admin panel** — closed-source UI in `enterprise/`, served through one new route-registration hook, `entitled("admin")` | 1–5 | L, 3–4 weeks | Consumes everything. Last so it never drives the model. |

Phase 1 ships no web UI. The CLI is the admin surface until phase 6.

---

## 2. Phase 1 design

### 2.1 Principles

- **No new scopes, no new route table, no policy engine.** `Scope`,
  `CLIENT_ALLOW` and `requiredScope()` are byte-identical after this phase.
- **Zero users means zero change.** With no `users.json`, behaviour is
  today's: device-only sessions, pairing as now, every existing test passes.
- **Once any user exists, every new device belongs to a person.** Minting a
  pairing code without a user is refused. This is what makes RBAC mean
  something; without it an admin keeps minting anonymous admin devices after
  bootstrap.
- **Loopback is the machine's owner and never a row.** It keeps
  `["admin","client"]`, `user: null`. The desktop app is loopback, so the
  desktop is untouched. SSH to the box is the emergency path.
- **Pairing stays the only remote credential.** No passwords, OTP, email.

### 2.2 Data model

New file `$OMB_DATA_DIR/users.json`, written with `writeFileAtomic` from
`server/atomic.ts` (mode 0600, directory 0700):

```json
{ "version": 1, "users": [ UserRecord ] }
```

```ts
type Role = "admin" | "member";
type UserStatus = "active" | "disabled";

interface UserRecord {
  id: string;            // randomUUID
  name: string;          // trimmed, 1..80, display only, not unique
  email: string | null;  // lowercased+trimmed, unique when present; a label, never an auth factor
  role: Role;
  status: UserStatus;
  createdAt: number;     // unix ms
  updatedAt: number;
  createdBy: string | null;  // actor user id; null when loopback made it
}
```

Decisions:

- **`member`, not `client`.** `client` is a device word (a chat-only iPad).
  `member` is a person word. Keeping them distinct is what makes the ceiling
  rule below legible. It costs one mapping function.
- **No `owner` role.** Loopback already is the owner. An owner row adds a
  hierarchy (can an admin demote an owner?) and a file invariant (exactly
  one) that phase 1 has no need for. Phase 3 can add it as data.
- **No handle.** A third identifier is over-design for phase 1; the CLI
  resolves `--user` by id, email or exact name instead.
- **No reserved `identities` field.** Adding an optional field later is free.

`roleScopes`: `admin → ["admin","client"]`, `member → ["client"]`.

`PublicUser` = every field. Nothing in the record is secret, but the file is
still 0600: membership and emails are not public.

**`sessions.json` stays `version: 1`.** `SessionRecord`, `PairingCode` and
`PublicSession` gain `userId?: string` (zod `.optional()`). A record without
it is a legacy device session. Never bump the version: `fileSchema` is
`z.literal(1)` and a failed parse starts empty, which would wipe field
sessions. Downgrade to an older server strips `userId` on the next write and
turns bound sessions into device sessions — degraded, not broken.

**Corrupt `users.json`.** This is the one place phase 1 deliberately differs
from `SessionRegistry.load()`, which starts empty because pairing again is
cheap. Recreating a roster is not cheap, and starting empty would also orphan
every bound session while silently clobbering the evidence. So: keep the
in-memory list empty, set `status: "unreadable"`, log one loud line at boot,
**refuse to persist while in that state**, and report a `notice` from
`GET /api/auth/users`. Bound sessions are refused; legacy sessions and
loopback keep working; the operator fixes the file and restarts. Fail closed
for people, recoverable for the operator, never destructive.

### 2.3 The ceiling rule

Stored `session.scopes` stop being the authority and become the **device
ceiling**. At the chokepoint:

```
effective scopes = roleScopes(user.role) ∩ session.scopes
```

Chosen over "overlay the role and ignore stored scopes" because the two facts
are orthogonal: "this iPad is chat-only" (`pair --client`) and "Bob is a
member" are independent, and either alone is enough to deny. It buys, at
once: demotion takes effect on the next request with no revocation;
promotion takes effect with no re-pair; a shared device can be capped below
its owner's role.

A session with no `userId` keeps today's behaviour: stored scopes are the
authority. All three handlers that read scopes directly (`server/index.ts`
~9748, ~10246, ~12099) already read `auth.scopes`, never `session.scopes`,
so they need no edit. Add a comment at the field saying it is a ceiling.

### 2.4 Files that change

| File | Change |
|---|---|
| `server/users.ts` *(new)* | `UserRegistry` — `load`, `persist`, `list`, `get`, `findByEmail`, `create`, `update`, `remove`, `activeAdmins()`, `status`. `roleScopes()`. Zod schemas. No constructor parameter properties (strip-types). Pure data; knows nothing about sessions. |
| `server/users.test.ts` *(new)* | §4 |
| `server/sessions.ts` | `userId` on `sessionSchema`, `PairingCode`, `PublicSession`, `publicSession()`. `openPairing({ userId })` and `exchange()` carry it. New `forUser(userId)`, `revokeForUser(userId): number` (calls `forget` per session so `onSessionRevoked` closes streams; persists once), `cancelPairingsForUser(userId): number`. |
| `server/request-auth.ts` | `ResolveOptions.users: UserDirectory` — **required**, so a call site that forgets fails to compile. `RequestAuth` gains `user: RequestUser \| null` on both variants. Session branch: look up, deny disabled/missing, intersect. `CLIENT_ALLOW` and `requiredScope()` untouched. |
| `server/index.ts` | Construct `UserRegistry` beside `SessionRegistry` (~379). Pass `users` (~7566). `GET /api/auth/session` returns `user` (~7585). `POST /api/auth/pairing` resolves `userId` (~7611). New `/api/auth/users*` routes after the sessions block (~7644). The stale-stream sweep (~8859) also drops a stream whose user is no longer active. |
| `server/cli.ts` | `users` command family; `pair --user`; `serve` behaviour once users exist; a `who` column in `formatSessions()`. |
| `server/*.test.ts` | §4 |
| `docs/self-hosting.md`, new `docs/users.md` | Operator docs, including what a `member` can still see. |

`UserDirectory` is a narrow read interface (`find(id)`), so tests pass a fake
and `request-auth.ts` never gains write access to the roster.

The session branch of `resolveRequestAuth`:

```ts
let scopes: readonly Scope[] = session.scopes;
let user: RequestUser | null = null;
if (session.userId) {
  const record = options.users.find(session.userId);
  if (!record) return deny(401, "unauthorized: this session has expired or was revoked; pair this device again");
  if (record.status !== "active") return deny(403, "forbidden: this account is disabled");
  scopes = roleScopes(record.role).filter((s) => session.scopes.includes(s));
  if (!scopes.length) return deny(403, "forbidden: this device has no scopes left on this account");
  user = { id: record.id, name: record.name, role: record.role };
}
const needed = requiredScope(method, path);
if (!scopes.includes(needed)) return deny(403, `forbidden: this session lacks the ${needed} scope`);
```

Missing user is 401 (the dead-credential message): it can only happen through
a race or a hand edit, removal revokes sessions, and "pair again" is the
correct action. Disabled is 403 with its own message: the person cannot fix
it by re-pairing (that returns 409), and it must not read as a stale token.

### 2.5 Routes

Every new route is absent from `CLIENT_ALLOW`, so `requiredScope()` already
makes it admin-only. Bodies are strict zod; failures are `400 {error}` naming
the field. Unknown id is `404 {error: "no such user"}`.

**Existing routes, additive only:**

| Route | Change |
|---|---|
| `POST /api/auth/pair` *(public)* | Request unchanged. `session` gains `userId`. Status codes unchanged (200/401/415/429). A code minted for a user who is now disabled or gone → **401** with the existing "wrong or expired" message (do not reveal whether the person exists). |
| `GET /api/auth/session` | Both variants gain `user: PublicUser \| null` (loopback and legacy → null). `scopes` is effective scopes. |
| `POST /api/auth/pairing` | Body gains `userId?`. See table. Response gains `userId`. |
| `GET /api/auth/pairing`, `GET /api/auth/sessions` | Items gain `userId` (null for legacy) and `user: {id, name} \| null`. `scopes` is effective. |

`POST /api/auth/pairing` resolution:

| State | Body | Result |
|---|---|---|
| no users | `userId` omitted | **200**, device-only, exactly as today |
| no users | `userId` given | **404** |
| users exist | `userId` omitted | **400** `userId is required because this server has user accounts` |
| users exist | unknown | **404** |
| users exist | disabled | **409** `that account is disabled` |
| users exist | active, `scopes` requested with empty intersection against the role | **400** `those scopes cannot apply to that account` — otherwise the device pairs and then fails every request |
| users exist | active | **200**; the code carries `userId`; stored scopes are the requested ceiling (default both) |

**New routes:**

| Route | Success | Errors |
|---|---|---|
| `GET /api/auth/users` | **200** `{ users, notice? }` | — |
| `POST /api/auth/users` `{name, email?, role?}` (default `member`) | **201** `{ user }` (precedent: `json(res, 201, …)` at ~7677, ~7869) | **400** · **409** `that email is already in use` |
| `GET /api/auth/users/:id` | **200** `{ user }` | **404** |
| `PATCH /api/auth/users/:id` — subset of `{name, email, role, status}` only | **200** `{ user, revokedSessions? }` | **400** unknown field · **404** · **409** email clash · **409** guards A/B |
| `DELETE /api/auth/users/:id` | **200** `{ ok: true, revokedSessions, cancelledPairings }` | **404** · **409** guards A/C |

`id` is immutable. No bootstrap route: the first user is created the same
way, over loopback or by an existing admin session.

### 2.6 What happens to a person's devices

**Disable** is reversible, so nothing is destroyed:

- Sessions are **kept**. Every request is refused at the chokepoint with
  `403 forbidden: this account is disabled`.
- Open pairing codes for that user are cancelled.
- Open event streams are closed immediately: the handler walks
  `sessions.forUser(id)` and reuses the close path already registered in
  `sessions.onSessionRevoked` (~2068); the periodic sweep (~8859) gains the
  same condition as belt and braces.
- **Re-enable restores every device with no re-pair.** That is the point of
  not deleting.

**Remove** is irreversible, so it is thorough: `revokeForUser` (fires
`onSessionRevoked` per session: streams closed, tickets dropped),
`cancelPairingsForUser`, then delete the row. The response says what
happened.

The race (code minted, user deleted, code exchanged inside the same window):
cancellation closes it at the source, and a session whose `userId` no longer
resolves is refused on its first request. Dead on arrival; `exchange()` needs
no signature change.

### 2.7 Lockout guards

The machine's owner can always recover over loopback, so nothing is
unrecoverable. The guards stop a *remote* admin making a mistake they cannot
undo from where they sit.

- **Guard A — last active admin.** Refuse to demote, disable or delete the
  last `active` `admin`: **409** `this is the last active admin; promote
  another account first`. Enforced in `UserRegistry` (an invariant of the
  file), so it holds for every future caller, panel included, and binds
  loopback too — loopback loses nothing, it can add an admin first.
- **Guard B — no editing your own authority.** A session may not change its
  own user's `role` or `status`: **409**. Loopback is exempt (no user).
- **Guard C — no deleting yourself.** Same.

Guards B and C live in the route handler (they need `auth.user`).

### 2.8 Bootstrap

1. Loopback is the owner and needs no row.
2. `openmausbot users add --name "Ada" --role admin` on the box (or from any
   existing admin session, which covers a VPS whose operator already paired a
   laptop) → `POST /api/auth/users`.
3. `openmausbot pair --user ada@example.com` mints a code bound to Ada.
4. The device exchanges it exactly as today.

`serve` nudges once: after the pairing block, if there are no users and the
server is remotely reachable (`OMB_PUBLIC_URL`, `--tunnel`, `--tailscale`),
print one line saying every paired device is an anonymous admin device and
how to create people. No first-run wizard, no licence check, no auto-created
owner from the config profile (that silently invents an identity).

### 2.9 CLI

All subcommands go through the loopback API, never the files, so the guards
run in one place.

```
openmausbot users
openmausbot users add --name NAME [--email EMAIL] [--role admin|member]
openmausbot users edit ID [--name N] [--email E] [--role admin|member]
openmausbot users disable ID | enable ID
openmausbot users remove ID [--yes]
openmausbot pair --user ID|EMAIL|NAME [--label DEVICE] [--client]
openmausbot sessions              # gains a "who" column
```

- `--user` resolves an id, an email, or an exact name (case-insensitive)
  client-side via `GET /api/auth/users`; an ambiguous name is an error
  listing the ids.
- `--label` is the *device*; `--name` is the *person*. Say so in `USAGE`.
- `--client` caps the device ceiling; with `--user` the role still applies.
- Once users exist: `pair` without `--user` exits 1 with the instruction;
  `serve` skips printing a startup code and prints the same instruction. It
  never silently binds the oldest admin.
- `users remove` asks to retype the name ("this signs out N devices");
  `--yes` for scripts.
- `openmausbot login` stays the control-plane tunnel command. Not mixed.

---

## 3. Backward compatibility

**`sessions.json` in the field.** `version: 1` unchanged; `userId` optional;
every existing file loads and every session keeps its stored scopes and
behaviour. Legacy sessions age out within 30 days, and every code minted
after the first user is bound, so the fleet converges with no migration.

**`POST /api/auth/pair` — verified callers:**

| Caller | Impact | Why |
|---|---|---|
| iOS `ServerPairResponse` / `ServerSession` (`Models.swift`, fixture `auth-pair-response.json`) | none | `Codable` ignores undeclared keys; requires only `token`, `session.{id,label,scopes,expiresAt}`, `environment` |
| Web `src/lib/session.ts` | none | reads known fields by hand |
| `.github/workflows/docker.yml` smoke | none | mints on a fresh fixture with no users, so the old path |
| Android | **not a caller** | its pairing is the companion `/api/pair`; do not change that route |

**Disabled-account copy on iOS:** 403 shows "That can only be done on the
computer itself." Wrong for one request, then the person cannot proceed
either way. Accepted; a one-line iOS special-case later.

**`/api/auth/pairing` and `/api/auth/sessions`:** only `server/cli.ts` calls
them in this repo. Additive fields are the hedge against third-party scripts.

**Desktop / loopback:** unchanged. **`CLIENT_ALLOW` and the 20
`request-auth` tests:** unchanged in behaviour; only the options literals gain
`users`.

---

## 4. Tests

**`server/users.test.ts`** *(new)*: missing file → empty; create persists
`version: 1` at 0600 (skip the mode assert on Windows, as sessions does);
reload round-trips; email lowercased and unique case-insensitively → the
error the route turns into 409; invalid role/status/email rejected by zod;
unreadable file → `status: "unreadable"`, empty, and **never overwritten** by
a later write; guard A at the registry level (last active admin cannot be
demoted, disabled or removed; a second admin unblocks it); `roleScopes()`
both roles; a disabled user is still `find()`-able.

**`server/sessions.test.ts`**: a code carries `userId` into the exchanged
session and into the file; `forUser`/`revokeForUser` fire `onSessionRevoked`
once per session and drop tickets, persist once, leave other users' and
legacy sessions alone; `cancelPairingsForUser`; a hand-written v1 file with
no `userId` loads and authenticates.

**`server/request-auth.test.ts`**: effective scopes are `role ∩ ceiling`
(admin role, `["client"]` ceiling → client); demotion and promotion take
effect on the next request with the file untouched; disabled → 403 with the
account message; missing → 401 dead-credential; empty intersection → 403,
never a silent pass; legacy session unchanged; loopback both scopes and
`user: null`; a resolved scope set is never wider than the role allows.

**`server/cli.test.ts`**: `parseArgs` for every `users` form and
`pair --user`; unknown subcommand text; `--user` resolution and the ambiguity
error; `formatUsers()`; the `who` column.

**`server/index.test.ts`** *(loopback)*: first admin → 201; duplicate email →
409; PATCH unknown field → 400 naming it; unknown id → 404; guard A over
loopback → 409.

**`server/users-rbac.e2e.test.ts`** *(new, same harness as
`remote-sessions.test.ts`, `OMB_SSE_HEARTBEAT_MS: "4000"` already set
there)*: the sequence below. House rules: no sleeps, wait on the event.

### End-to-end proof

L = loopback, no headers. R = remote (`Host: mini.tail1234.ts.net:8799`,
`x-forwarded-for`), bearer noted. Against an isolated fixture only.

| # | Request | Expected |
|---|---|---|
| 1 | L `POST /api/auth/pairing {}` → R pair → R `GET /api/auth/session` | **200 / 200 / 200**, `user: null`, both scopes — the pre-RBAC path |
| 2 | L `GET /api/auth/users` | **200** `{ users: [] }` |
| 3 | L `POST /api/auth/users {name:"Ada", email:"ada@x", role:"admin"}` | **201** id=ADA |
| 4 | L `POST /api/auth/users {name:"Ada 2", email:"ADA@x"}` | **409** email in use |
| 5 | L `POST /api/auth/users {name:"Bob", role:"member"}` | **201** id=BOB |
| 6 | L `POST /api/auth/pairing {}` | **400** userId is required |
| 7 | L `POST /api/auth/pairing {userId: ADA}` | **200** code CA, userId=ADA |
| 8 | R pair CA, label "Ada Mac" | **200** token TA, `session.userId=ADA`, scopes both |
| 9 | R(TA) `POST /api/auth/pairing {userId: BOB, scopes:["client"]}` | **200** code CB — an admin mints for others |
| 10 | R pair CB | **200** token TB, scopes `["client"]` |
| 11 | R(TB) `GET /api/auth/session` | **200** `user.role=member`, scopes `["client"]` |
| 12 | R(TB) `GET /api/bots` | **200** client route |
| 13 | R(TB) `GET /api/auth/users` · `POST /api/auth/pairing` | **403 / 403** unchanged "lacks the admin scope" message |
| 14 | R(TA) `PATCH /users/BOB {role:"admin"}` → R(TB) `GET /api/auth/users` | **200 / 403** — ceiling was `["client"]`, role alone does not lift it |
| 15 | R(TA) `POST /api/auth/pairing {userId: BOB}` → R pair → R(TB2) `GET /api/auth/users` | **200 / 200 / 200** — a full-ceiling device gets admin, no re-pair needed afterwards |
| 16 | R(TA) `PATCH /users/ADA {role:"member"}` | **409** guard B — asserted while Bob is an admin so it cannot be guard A |
| 17 | R(TA) `PATCH /users/BOB {role:"member"}` → R(TB2) `GET /api/auth/users` | **200 / 403** demotion live |
| 18 | R(TB2) open SSE (`stream-ticket` → `GET /api/events?ticket=`), then R(TA) `PATCH /users/BOB {status:"disabled"}` | **200**, and the stream **ends** before a heartbeat |
| 19 | R(TB2) `GET /api/bots` | **403** account is disabled |
| 20 | R(TA) `POST /api/auth/pairing {userId: BOB}` | **409** disabled |
| 21 | R(TA) `PATCH /users/BOB {status:"active"}` → R(TB2) `GET /api/bots` | **200 / 200** — never re-paired |
| 22 | R(TA) `DELETE /users/ADA` | **409** guard C |
| 23 | R(TA) `DELETE /users/BOB` | **200** `revokedSessions: 2` |
| 24 | R(TB2) `GET /api/bots` | **401** pair again |
| 25 | L `GET /api/auth/sessions` | Bob's devices gone; Ada's present with `user` |
| 26 | L `PATCH /users/ADA {status:"disabled"}` | **409** guard A binds loopback |
| 27 | restart the fixture on the same data dir → `GET /api/auth/users` | Ada present, same id |
| 28 | drop a pre-upgrade `sessions.json` (no `userId`) into the data dir, restart → `GET /api/auth/sessions` | **200**, that record has `userId: null` and its stored scopes |

Manual run (per `docs/verification/README.md`, never a live instance):

```sh
node --experimental-strip-types scripts/control-omb.ts launch   # prints URL, data dir, log path
curl -s $URL/api/auth/users
curl -s -XPOST $URL/api/auth/users -H 'content-type: application/json' -d '{"name":"Ada","role":"admin"}'
curl -s -XPOST $URL/api/auth/pairing -H 'content-type: application/json' -d '{"userId":"…"}'
stat -f '%Sp' $DATA_DIR/users.json     # -rw-------
```

Keep the JSON and the log path as evidence. A green unit test alone does not
prove this.

---

## 5. Out of scope for phase 1

- Any web UI for users. CLI only.
- Passwords, OTP, magic links, email sending, invitations, self-signup, a
  "claim this server" web flow.
- New scopes, a permission table, custom roles, an `owner` role.
- Per-bot / per-room / per-folder visibility. **A `member` still sees the
  whole fleet** (see risks).
- A "my devices" view for members; members minting codes for their own
  devices (phase 3, with the sketch: allow `POST /api/auth/pairing` for the
  `client` scope and enforce `userId === self`, `scopes ⊆ own`).
- Claiming a legacy session for a user. They age out in 30 days.
- Any `entitled()` call. Users are open-source and unlicensed.
- Identity headers, OIDC, the control plane, `openmausbot login` changes.
- The human-action audit log (phase 2). Phase 1 logs to the console only.
- Message attribution in transcripts.
- `sessions.json` version bump, migrations, TTL/cookie/ticket/lockout changes.
- Rewriting `SessionRegistry.persist` onto `writeFileAtomic`. Related; not a
  drive-by.
- Team backups of `users.json` (check whether they include `sessions.json`
  at all; they look like bot content only).

---

## 6. Risks and assumptions

- **The honesty risk: `member` sees everything.** `client` scope reads every
  transcript, room and search result today. Someone will read "member" as
  "restricted" and over-share. Mitigations: never call it "viewer"; print the
  limit in `users add` output and `docs/users.md`; put it in the release
  note; make phase 4 the visibly next thing.
- **Stored ceiling vs live role.** Handled by intersecting at the chokepoint.
  Residual: a future handler reading `session.scopes`. Comment at the field,
  plus the "never wider than the role" test.
- **Corrupt `users.json` locks out every remote person** until an operator
  fixes it. Loud, recoverable, never destructive. The correct trade.
- **`serve` changes once users exist** (no startup code without `--user`).
  Deliberate: the alternative mints an unbound admin device and undermines
  the whole phase.
- **Guard A does not count loopback**, so an operator can still have zero
  remote admins. Intended; SSH remains.
- **Downgrade drops `userId`** on the next write. Devices keep working.
- **Assumption: one server process per data dir.** Already true for
  `sessions.json`; not made worse.
- **Assumption: one server is one tenant.** No org object. If that breaks,
  it breaks in phase 4.
- **Entitlement creep.** Phase 1 must ship unlicensed. Accounts behind
  `entitled("admin")` would give self-hosters a worse product than today's
  anonymous admin devices. The `admin` entitlement is for the panel.
- **Unverifiable from inside the repo:** third-party scripts parsing
  `sessions.json` or the sessions list. Additive fields are the hedge.

---

## 7. Open-source vs closed-source

**Open (Apache-2.0, `server/`):** the user model and file format, roles,
`roleScopes`, the ceiling rule, every `/api/auth/users*` and `/api/auth/*`
route, the CLI, the phase 2 audit log, and the identity-provider *hook*.

Because: nobody can trust access control they cannot read; it is the
substrate every later feature needs, and closing the substrate forks the
codebase; it is table stakes, not a differentiator; and the repo's own rule
(`enterprise/README.md`) says "could any open-source user want it? It goes in
core" — every self-hoster with two people wants this.

**Closed (`enterprise/`, behind entitlements):** the admin panel UI and any
aggregate/bulk routes it needs (`entitled("admin")`); concrete SSO providers
and JIT provisioning (`entitled("sso")`); SCIM and directory sync; org/team
hierarchy and delegated administration; seat caps; audit *export* and
retention (the log stays open, shipping it somewhere is commercial);
per-user budgets (`entitled("budgets")`, already declared).

**The rule:** the decision is open; the management surface at scale is
commercial. Anyone may verify who is allowed to do what; running a hundred of
those decisions across an org is the product. The seam holds as long as no
core file imports from `enterprise/`, which means the panel can only consume
the public HTTP API — a useful constraint, because it forces that API to be
complete enough that someone else could build a panel too.

---

## Implementation order inside phase 1

1. `users.ts` + tests. No HTTP.
2. Optional `userId` on sessions; `forUser`, `revokeForUser`,
   `cancelPairingsForUser`; the v1-file test.
3. `request-auth.ts`: required `users` option, lookup, deny cases,
   intersection. Fix the four options literals in its test.
4. Routes in `index.ts`, including the pairing rules and stream closing.
5. CLI.
6. `users-rbac.e2e.test.ts` + the curl sequence on `control-omb launch`.
7. `docs/users.md` and the self-hosting section.

Step 6 is the done check. If the sequence in §4 does not produce those status
codes on an isolated fixture, it is not done.
