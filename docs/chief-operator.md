# Chief Operator: scoped settings (initial server slice)

A Chief Operator is an existing bot appointed by the workspace owner. This is a separate role from a department's Chief of Staff. Appointment does not turn on Chief of Staff, change the bot's approval mode, give it other departments' conversations, or grant shell access. An existing Chief may also be appointed, in which case its existing bot, room and routine tools keep their own authority checks.

## Supported settings

Only two top-level platform settings are supported:

| Setting | Value | Effect |
| --- | --- | --- |
| `language` | Empty for the system default, or a lowercase BCP-47 tag of at most 35 characters | Changes the app's default language for future interface and server text. Person-specific language choices remain separate. |
| `computerName` | Empty for the default, or a trimmed printable string of at most 63 characters | Changes the computer's displayed name. |

The owner grants each setting separately for reading and writing. A write-only grant does not reveal the previous value in a preview or result. Unsupported names fail validation. Credentials, provider configuration, security and access settings, budgets, payments, resource limits, deletion and other settings have no Chief Operator route. There is no shell or direct `config.json` fallback.

## Owner appointment API

This slice exposes `GET`, `PUT` and `DELETE /api/chief-operator`. They require a signed-in admin-scoped owner session. On a Team Cloud the session must have the verified **Owner** role; an Admin is insufficient. The desktop app's per-boot owner request also passes, but an owner-facing desktop election screen is not yet included. Standalone loopback calls without a session are refused even when that installation otherwise treats loopback as owner. Companion requests are refused.

The supported scripted path is a paired owner session or admin-scoped access token used as a bearer token. Never put the token in a command argument, URL, transcript or repository file. First read the current appointment and its `revision`:

```sh
printf 'Authorization: Bearer %s\n' "$OPENMAUSBOT_TOKEN" |
  curl --header @- "$OPENMAUSBOT_URL/api/chief-operator"
```

Appoint an existing, active bot by its ID and explicitly select its scopes. Use the exact `revision` returned by GET as `expectedRevision` (`none` when there is no appointment):

```json
{"botId":"BOT_ID","read":["language"],"write":["language"],"expectedRevision":"none"}
```

Send that JSON as `PUT /api/chief-operator` with `Content-Type: application/json` and the same bearer header. To revoke, send `DELETE /api/chief-operator` with `{"expectedRevision":"CURRENT_GRANT_REVISION"}`. Inspect again with GET. Replacing or revoking a changed appointment returns 409 instead of silently overwriting it. Creating, copying, sharing or importing another bot does not carry this separate grant. A full workspace restore clears the destination's grant and does not import the source grant. Deleting, hiding, moving, changing ownership or department, or changing the selected bot's visibility or peer audience revokes the grant. The owner must appoint it again if those changes were intentional.

GET returns the current grant, its revision, the most recent 100 audit entries and a separate `pending` list so an older unresolved receipt remains visible. The persistent record keeps at most 1,000 settled and 100 pending entries; an overfull or corrupt record disables the role until the owner repairs it. For safe rollback, the journal holds exact before/after values for only these two non-credential display settings, along with the bot ID, appointing owner, decision state and time. It never copies credential or other config fields. Do not put secrets in display settings.

## Operator tool

Only the appointed bot is offered `operator_settings`. The server permits its use only in a direct, owner-started turn. On Team Cloud, the initiating person must match the appointing Owner. A room, routine, guest, outside runtime or delegated turn cannot use it in this slice. Every call is authenticated by that turn's internal capability, and the server checks the current role and bot identity again.

1. `{"action":"read"}` returns only read-scoped values and revisions.
2. `{"action":"preview","setting":"language","value":"fr"}` returns a preview ID, affected setting, consequence and revision. It also returns the previous value only with read scope. Previews last at most ten minutes, belong to one turn, and are not durable.
3. `{"action":"apply","preview_id":"…","expected_revision":"…"}` applies exactly that preview once. The server revalidates the role, scope, bot identity, live turn, current value and config-file revision before writing. Any config write after preview, even to another setting, requires a fresh preview. Success returns a receipt ID and new revision.
4. `{"action":"rollback","receipt_id":"…","expected_revision":"…"}` restores an applied receipt's prior value only if the same grant still has both read and write scope and that setting has not changed since the receipt. This also produces a receipt. It is not a general undo for arbitrary config edits.

The operation journal is written before the config change and finalized after it. If the server loses the ability to finalize a receipt after a config write, it reports that the outcome may have changed. An unresolved pending receipt blocks further applies and rollbacks; owner GET and scoped reads remain available for inspection. This slice does not provide an owner-facing reconciliation action, so a trusted host administrator must inspect and repair the record before further changes. A pending record is never blindly replayed. Revoking a grant blocks a queued preview from applying. Full Access does not bypass the route's checks.

This control path does **not** isolate a bot from the underlying operating-system shell. Existing local/self-hosted loopback and filesystem trust boundaries are documented in `server/request-auth.ts`; a bot with host shell access may bypass this feature outside its tools. That boundary needs separate platform hardening. Do not use Chief Operator as a substitute for OS isolation.

## Remaining work for the broader proposal

- Add a desktop and web owner election/scoping screen and readable in-chat preview/approval experience. The desktop API can authenticate its own window, but this slice has no shipped UI for it.
- Add reviewed, typed categories beyond the two low-risk display settings. Sensitive categories must keep human approval even under Full Access.
- Extend the role's department selection and coordination UX without expanding transcript, memory, file or connected-account visibility. Existing Chief tools remain separate meanwhile.
- Add durable, paginated audit history beyond the current bounded retention, owner-facing reconciliation for interrupted changes, and fuller rejected-attempt auditing. Future setting categories need audited value redaction without exposing secrets or losing safe recovery.
- Qualify isolation against an OS shell and local loopback, as a separate security project.
