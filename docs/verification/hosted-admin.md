# Hosted Admin portal

The enterprise portal is a separate process, not a desktop settings page or
another bot workspace. See [deployment and limitations](../../enterprise/admin/README.md).

## Repeatable checks

From the repository root:

```sh
pnpm --filter @openmausbot/admin test
pnpm --filter @openmausbot/admin build
node --test enterprise/admin/deploy/deploy.node-test.mjs
pnpm exec vitest run server/hosted-access.test.ts enterprise/server/workspace-access.test.ts server/email-signin.test.ts server/sessions.test.ts server/request-auth.test.ts server/fleet.test.ts server/fleet-cli.test.ts server/fleet-agent.test.ts server/fleet-cli-filesystem.test.ts
```

The portal tests use real HTTP, SQLite and Better Auth, but fake mail, fleet
operations and upstream provider responses. They cover:

- Invite-only sign-in; wrong-account, expired and revoked invites; CSRF.
- Blank workspace seeds, membership isolation and no implicit operator membership.
- One-use, workspace-bound PKCE handoffs; current membership on every grant check.
- Failed provisioning and concurrent operations, including loss of admin access
  while an operation is queued and a failed promotion not granting access.
- Encrypted master keys, scoped workspace credentials, fixed upstream paths and
  model allowlists; suspension/model revocation aborting active responses.
- Request deadlines/concurrency bounds, private proxy identity and body limits.
- Independent Anthropic/OpenRouter credentials and model grants, legacy
  Anthropic-only grant records, fixed OpenRouter paths, filtered model discovery,
  preserved tool/SSE payloads and rejected alternate model-routing fields.
- Managed OpenCode seeds with no master key, updates to existing workspaces,
  and revocation-first/no-widening behavior when catalog synchronization fails.
- Multiple accepted administrators/members in one workspace, independent client
  membership, last-admin protection and fleet bootstrap-role constraints.
- Parent Admin session sign-out/expiry revoking its handoffs and workspace
  grants without ending another device's independent session; migration of
  older unbound grants without changing memberships.
- Shared-office email-code rate limits, five-attempt code lockout, and partial
  invitation delivery with failed-only retries through the existing endpoints.
- Bounded, status-only fleet reads that skip tenant usage collection and never
  report an unavailable manager or missing service as healthy.

The harness fixture additionally exercises the real hosted bridge with fake
HTTPS responses: state/cookie mismatch, replay, stale grants, legacy credentials,
membership changes, unavailable control plane and stream revocation. The fleet
fixtures execute the bounded unprivileged file reader on hostile disposable
files, but do not prove Linux root-to-tenant identity transitions.

## Browser walkthrough

```sh
pnpm --filter @openmausbot/admin preview:fixture
```

Open only its printed loopback address. Use `operator@example.test`; fake mail
codes and invitation links appear in that fixture's terminal. All identities,
workspaces and keys are disposable. No email or cloud resources are created.

1. Sign in and create a workspace. Confirm it says **Management only**, without
   an Open link. An operator's existing conversations must never be seeded.
2. Invite a new `@example.test` address. Open the printed invite in the same
   signed-in tab; confirm it offers **Switch account**, not automatic acceptance.
3. Switch accounts. The invite URL must survive email-code sign-in. Confirm the
   workspace name and role before accepting.
4. Acceptance points at the fake workspace host, which deliberately does not
   resolve. Do not change DNS or bypass browser protections. Return to the
   printed portal's `/workspaces` page: the member sees only their workspace,
   without platform Providers/Activity or management controls.
5. Create a fresh workspace and invite `lead@example.test` and
   `retry@example.test` together as workspace administrators. The preview fails
   the latter's first invitation delivery deliberately. Confirm one success,
   one saved-but-undelivered invitation, and **Retry failed** resending only the
   failed invitation. The original successful link must remain unchanged.
6. Accept as the lead, then invite two more fake members from the workspace's
   **People** tab. Confirm **Member** is the subsequent default, both results
   appear, and revoking one invitation leaves the other pending. The last
   administrator must have no removal/demotion control. **Models** is read-only
   and platform Providers/Activity/Hosting must be absent for this account.
7. As the operator, exercise dialogs and provider/model forms using fake values
   only. Check both narrow and wide layouts.

This walkthrough was driven through the real built UI on 2026-09-11: email
sign-in, blank creation, pending invitation, same-tab wrong-account handling,
account switch, acceptance and the isolated member list were observed. The
provider settings layout was inspected. The final workspace-host navigation
was not live-tested because the fixture has no real tenant host.

The expanded walkthrough passed on 2026-09-12 against an isolated built portal:
suggested workspace address, direct-to-People creation, mixed invitation delivery
and failed-only retry, same-tab account switching with the invite preserved,
acceptance, workspace-admin-only visibility, two subsequent member invitations,
revocation, last-admin protection and operator-only suspension/resumption with
matching refreshed service state. The narrow 680px layout had no horizontal
page overflow, and the invitation dialog focused its email field. The provider
and fleet responses were synthetic; acceptance still ended at the deliberately
unresolvable workspace host, not a deployed tenant.

That revision passed 77 Admin tests, 148 related hosted-access/session/fleet/
group-VM tests, both deployment-template tests, root typecheck/lint, the Admin
production build and packaged-server smoke (all 12 proxy paths and MCP round
trip). These results are not a Windows CI or real-host deployment claim.

Stop the foreground preview with Ctrl-C; it removes only its owned temporary
database and closes its server. It never uses the installed app's data.

### OpenRouter walkthrough

In a newly launched fixture, save `fixture-openrouter-key-not-real` and two
synthetic model IDs (`vendor/tool-model`, `vendor/other-model`) in Providers →
OpenRouter. Reload: the key field must be empty, the saved-key status and models
must remain, and Anthropic must remain independently unconfigured. Create a
workspace selecting the first model, change its assignment to the second, save,
then reload. These steps passed through the actual built UI on 2026-09-11.
The fixture fleet and provider upstream are fake; this does not prove an
installed OpenCode CLI can complete a paid turn against OpenRouter.

An additional native catalog check used installed OpenCode **1.18.27** on
2026-09-11, the production-generated managed-provider config and a synthetic
key/model. With fresh HOME/XDG directories, real-home access blocked and all
network denied, `models --verbose` exited 0 and included
`omb-managed-openrouter/vendor/tool-model`. OpenCode added only its `$schema`
entry; the managed provider URL, key and model configuration remained unchanged.
The temporary homes were removed. This proves native catalog discovery, not an
ACP turn, tool execution or a paid upstream request.

## Explicit Linux root-transition qualification

Read the runner's scope without making any changes (safe on a developer host):

```sh
node --experimental-strip-types enterprise/admin/tests/linux-qualification.ts --help
```

Only after the operator explicitly identifies a **disposable Linux host**, run
the matching checkout there as root:

```sh
node --experimental-strip-types enterprise/admin/tests/linux-qualification.ts --run-disposable
```

The runner refuses other arguments, non-Linux and non-root execution. It creates
two random `omb-qual-<id>-a/b` nologin accounts and one root-owned
`/var/tmp/omb-linux-qual-*` fixture. It uses the production fleet helper with real
account lookup and uid/gid transitions, checks file ownership, proves a distinct
tenant cannot read its sibling's private file or regain root, summarizes a
fixture ledger, and refuses root/device symlinks, FIFO and oversized input.
All command invocations are bounded. No systemd units, Caddy configuration,
firewall rules, existing workspaces, credentials or paid providers are touched.

Keep stdout/stderr and the exit code. Success requires exit 0 plus both
`qualification-passed` and `cleanup-complete` events. Cleanup deletes only the
tracked accounts (after checking their expected home/uid) and the inode/marker-
verified temporary tree. If interrupted with SIGKILL or cleanup fails, inspect
only the exact printed fixture names/path; do not use wildcard user deletion,
global resets or firewall flushes. The runner leaves explicit diagnostics and
retains the tree if it cannot safely clean its account identities.

Running `--help`, a local refusal check or ordinary fixture tests does not prove
this privileged qualification passed. Record a real disposable-host run before
claiming root transitions are qualified.

### Observed disposable-host result — 2026-09-11

The bundled runner passed all eight checks on the explicitly authorized, blank
Hetzner Ubuntu 26.04.1 host using Node 24.15.0: exit 0, `qualification-passed`
and `cleanup-complete`. It exercised the production helper with distinct real
identities: `omb-qual-c01d6e0c804d-a` (uid 999/gid 983) and
`omb-qual-c01d6e0c804d-b` (uid 995/gid 982), under the owned fixture
`/var/tmp/omb-linux-qual-H9CH5f`.

The operator's separate post-check confirmed both accounts and groups and the
fixture directory were absent, the SSH-only public listener was unchanged, and
nft rules remained empty. This qualifies only the runner's uid/gid and hostile
filesystem checks—not systemd, network isolation, Caddy/TLS, mail, OAuth, a real
provider call or a complete deployment.

The standalone artifact was built from the matching checkout with:

```sh
pnpm exec esbuild enterprise/admin/tests/linux-qualification.ts --bundle --platform=node --format=esm --outfile=/tmp/linux-qualification.mjs
```

## Release qualification still required

Use the disposable Linux deployment recipe before production: two actual
tenant users/services, sibling file and loopback denial, private management
sockets, blank tenant data, signed-in handoff, access revocation, real SMTP,
configured OAuth callbacks, and an explicitly authorized bounded provider call.
Local tests do not replace this. Do not enable a tenant-facing deployment with
unverified proxy/socket/identity boundaries.

Also verify a real reboot and deliberately failed fence startup: tenant units
must wait for and require the fence service. Existing installations need their
generated units updated deliberately; an app-only upgrade does not rewrite
them. Configure and exercise per-workspace resource limits and restore a backup
before a client pilot; the portal does not yet manage those resource limits.
