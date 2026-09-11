# Hosted Admin portal

A separately deployed enterprise control plane for provisioning and managing
fresh customer/team workspaces. It is **not** part of the desktop app and must
never run inside an operator's chat workspace. Requires a valid license with
the `admin` entitlement; see [Enterprise licensing](../README.md).

For the day-to-day operator workflow, see [Onboard a hosted client](CLIENT-ONBOARDING.md).

## How this fits the existing npm and Docker setup

`npx openmausbot@latest` and the existing Docker/Compose setup still start a
**single workspace**. They do not install or start this Admin portal, and
upgrading an existing workspace does not turn it into a hosting platform.
The Admin package is private and has no separately published npm command or
Docker image in this change.

For enterprise hosting, set up these services once on the Linux host:

- **Admin portal**, for example `admin.example.com`: sign-in, invitations,
  workspace management and managed provider access. It runs without bot tools.
- **Fleet agent**: the existing privileged host provisioner, accessible only
  over its private socket. It creates a separate Unix user, home and background
  service for each workspace.
- **Client workspaces**, for example `acme.example.com`: the ordinary
  OpenMausBot UI and bot runtime, each with its own blank data directory.
  Caddy routes the HTTPS addresses to the correct service.

After the one-time setup below, creating clients and assigning API-backed
models happens in the portal; clients do not repeat the server CLI setup.
Install the required engines on the host once. Server maintenance, upgrades
and recovery remain operator tasks.

This first deployment path uses host systemd services. The normal application
container cannot provision host users, systemd services or network fences;
do not give it privileged mode, host management sockets or a Docker socket
to try to enable the portal. Existing single-workspace installations are not
automatically migrated. Test a fresh hosting deployment before moving clients.

## Implemented boundaries

- The portal runs as an unprivileged `omb-admin` user, with its own SQLite
  database and no bot runtime. Its only privileged interface is the root fleet
  agent's Unix socket. That socket grants powerful host-management authority;
  never give its group to a tenant or ordinary workspace.
- Each newly provisioned workspace gets its own `omb-<slug>` Unix account,
  home, data, service and fenced loopback ports. No existing chats, settings,
  connected accounts or provider credentials are copied from the operator.
  Existing fleet workspaces are not automatically imported into the portal.
  This is same-kernel process isolation, not a per-customer VM/container.
- Platform admins can provision and manage, but are not automatically chat
  members. They must invite themselves and accept before opening a workspace.
  The runtime bootstrap admin entry does not confer portal membership.
- Access is invite-only: emailed one-time codes, plus Google/GitHub only when
  configured. People sign in with the invited verified email and explicitly
  accept. Invitations expire after seven days and can be revoked or resent.
  OAuth signs people in; it does not connect their mailbox to a bot. Password
  sign-in and automatic account linking are disabled.
- Managed provider access supports **Anthropic API and OpenRouter**, with
  separate global and per-workspace model allowlists. Both master keys stay
  encrypted in portal SQLite; workspaces receive only scoped gateway credentials.
  Anthropic permits Messages/count-token requests. OpenRouter permits chat
  completions and a local, filtered model catalog; upstream addresses are fixed.
  Tools and streaming are relayed without changing their payloads. This is not
  subscription pooling or centralized management of every other provider.
- OpenRouter uses the existing **OpenCode** engine, which must be installed
  on the server. New workspaces get a private OpenCode configuration for
  `omb-managed-openrouter`, even with no models assigned yet. The portal updates
  that managed catalog when assignments change; other providers and credentials
  are preserved. An OpenRouter-only workspace starts with its first assigned
  model as the New Bot default. Later changes never switch existing bots/models.
  Refresh the workspace's engine catalog to see new choices. Concrete chat model
  IDs are required: routers, presets, model fallback arrays and model aliases
  beginning with `~`/`@` are rejected so they cannot bypass assignments.
- Removing a member revokes their portal workspace grants. It does **not**
  revoke a copied workspace-wide provider token. Suspending that workspace or
  removing its model access blocks subsequent gateway requests and aborts active
  gateway requests/streams. This cannot undo work or charges already processed
  upstream. No individual gateway token-rotation workflow is implemented.

## Build and offline checks

Use Node **24.15.0 or newer** and the repository's pinned pnpm version. From
the repository root, in a build checkout (not as the portal service user):

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:server
pnpm --filter @openmausbot/admin build
pnpm --filter @openmausbot/admin test
node --test enterprise/admin/deploy/deploy.node-test.mjs
```

The portal build produces `enterprise/admin/dist/server.mjs` and `dist/web/`.
It keeps npm packages external: deploy the matching installed dependencies,
including pnpm's linked store, alongside the build. The service template
assumes a verified, **root-owned**, read-only-to-service-users release checkout
at `/opt/openmausbot` and Node at `/usr/bin/node`. Adjust paths consistently
if yours differ. Do not use a temporary checkout, npx cache, tenant-owned
directory, or a mismatched previously published core release. From the admin
package directory, `pnpm start` runs the same production bundle; it requires
the production environment and prepared private socket directory below.

The tests launch disposable databases/sockets with recorded fleet operations,
fake mail and fake provider responses. For a local browser preview:

```sh
node --experimental-strip-types enterprise/admin/tests/preview.ts
```

Use only its printed loopback URL and disposable addresses. Stop it with
Ctrl-C. Never point these fixtures at a real fleet socket, database or key.
Passing fixtures is **not production qualification**: real Linux root-to-user
transitions, systemd/nftables/Caddy, SMTP delivery, real Google/GitHub OAuth,
TLS issuance and paid Anthropic/OpenRouter requests have not been proven by them.

## Fresh Linux deployment

These are operator instructions, not an installer. First qualify them on a
disposable Linux server. They assume systemd, nftables, Caddy running as
`caddy:caddy`, the matching release installed above, and the required engine
CLI installed at a stable system path. Use a dedicated host or review every
existing service/config before merging; do not blindly replace a live setup.
Point `admin.example.com` and `*.example.com` at the server, replacing those
examples below. Allow public HTTPS and certificate validation ports, not
tenant loopback ports or management sockets.

### 1. Dedicated identity and private configuration

As root on that deployment host, create a **new** identity; do not reuse an
existing tenant account or add any tenant to either management group:

```sh
useradd --system --user-group --home-dir /var/lib/openmausbot-admin --shell /usr/sbin/nologin omb-admin
install -d -o root -g root -m 0755 /etc/openmausbot
install -o root -g root -m 0600 /opt/openmausbot/enterprise/admin/deploy/admin.env.example /etc/openmausbot/admin.env
install -o root -g root -m 0600 /opt/openmausbot/enterprise/admin/deploy/admin-license.env.example /etc/openmausbot/admin-license.env
```

Edit both files privately before starting. `OMB_ADMIN_URL` is the exact HTTPS
origin, without trailing slash/path/credentials; match the Caddy host. List
platform owners in comma-separated `OMB_ADMIN_EMAILS`. Generate a unique
secret with `openssl rand -hex 32`; store it as `OMB_ADMIN_SECRET`, not in
source control or command history. Fill the SMTP URL and sender; percent-encode
credentials in the URL. SMTP requires TLS (`smtps://` or STARTTLS `smtp://`).
Put the issued license only in `admin-license.env`. PID 1 reads these root-only
files for services; `omb-admin` need not read the files themselves.

Optional OAuth pairs are listed in the example. Register these exact callbacks
with their providers, replacing the hostname:

- `https://admin.example.com/api/auth/callback/google`
- `https://admin.example.com/api/auth/callback/github`

Provider account/email verification and real callbacks still need deployment
qualification. Do not disable TLS/certificate validation to make them pass.

### 2. Private Caddy management and exact-host proxy

The [Caddyfile](deploy/Caddyfile) contains the portal's exact host, private
upstream socket and `header_up X-OMB-Client-IP {remote_host}`. This **overwrites**
client-supplied headers for rate limiting, using Caddy's [remote-host placeholder](https://caddyserver.com/docs/caddyfile/concepts#placeholders). It assumes clients connect directly
to Caddy; a CDN/load balancer requires a separately reviewed trusted-proxy
configuration. Do not substitute arbitrary `X-Forwarded-For` from the client.

Caddy's default local admin API is also reachable by tenant shells. Move it
to the supplied private Unix socket, and use the matching reload drop-in;
disabling it would break fleet reloads. See [Caddy's admin endpoint guidance](https://caddyserver.com/docs/caddyfile/options#admin).

```sh
install -d -o root -g root -m 0755 /etc/caddy/omb.d /etc/systemd/system/caddy.service.d
install -o root -g root -m 0644 /opt/openmausbot/enterprise/admin/deploy/caddy-admin.conf /etc/systemd/system/caddy.service.d/openmausbot-admin.conf
```

Merge `deploy/Caddyfile` into `/etc/caddy/Caddyfile` (one global block at the
top, one exact portal site, one fleet import). Keep it root-owned and not
writable by `omb-admin` or tenants. Validate before the first planned restart:

```sh
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl daemon-reload
systemctl restart caddy
```

The private admin endpoint is `/run/caddy-admin/admin.sock`; the directory
must be `caddy:caddy`, mode 0750. There must be no listener on port 2019.
Do not add tenants to `caddy`; membership also exposes management sockets.

### 3. Fleet and portal services

```sh
install -d -o root -g root -m 0755 /etc/systemd/system/openmausbot-fleet.service.d
install -o root -g root -m 0644 /opt/openmausbot/enterprise/admin/deploy/openmausbot-fleet-admin.conf /etc/systemd/system/openmausbot-fleet.service.d/admin.conf
/usr/bin/node --experimental-strip-types /opt/openmausbot/server/openmausbot.ts fleet init --domain example.com --operator omb-admin
install -o root -g root -m 0644 /opt/openmausbot/enterprise/admin/deploy/openmausbot-admin.service /etc/systemd/system/openmausbot-admin.service
systemctl daemon-reload
systemctl restart openmausbot-fleet.service
systemctl enable --now openmausbot-admin.service
```

For an existing fleet, first stop portal mutations, back up registry/config,
review `fleet init --dry-run --yes`, and explicitly choose whether to reassign
its operator. `--yes` preserves entries/fences; it is not a migration/import.
Restarting the fleet agent is required after changing its group or environment.
Do not run direct fleet CLI mutations concurrently with the agent.

The portal service uses `User=omb-admin`, `Group=caddy`, and
`SupplementaryGroups=omb-admin`. Its state directory is mode 0700; its HTTP
socket directory is `omb-admin:caddy` mode 0750 and `http.sock` is mode 0660.
Its filesystem view excludes tenant homes. The root agent socket must instead
be `root:omb-admin` mode 0660. **Caddy must not join `omb-admin`**: only the
portal's service identity should reach the root agent. Do not grant sudo,
Docker access, bot execution, or public TCP access to the portal service.

### 4. Qualification checklist

```sh
systemctl status openmausbot-admin openmausbot-fleet caddy
stat -c '%U:%G %a %n' /run/openmausbot-admin /run/openmausbot-admin/http.sock /run/openmausbot/fleet.sock
curl --fail --unix-socket /run/openmausbot-admin/http.sock -H 'Host: admin.example.com' http://localhost/api/health
curl --fail https://admin.example.com/api/health
ss -lnt
```

Confirm the modes/owners above, no portal TCP listener and no `:2019` listener.
The health response identifies `openmausbot-admin`; it does not test SMTP,
provider credentials, fleet readiness or license entitlement.

Sign in as a configured platform owner. In **Providers**, save the intended
Anthropic and/or OpenRouter key and exact allowed model IDs; saving makes no
upstream request. Use tool-capable OpenRouter chat models for agent workflows.
Create two disposable workspaces, invite their first workspace admins, accept
with the invited accounts, and open each workspace. Check they start blank;
platform management alone must not open chats. Test wrong-account/revoked
invitations, role changes, suspension and member removal. Only with explicit
paid-call approval, send a bounded real request for each configured provider.

OpenRouter provisioning follows the existing OpenCode custom-provider
configuration, with this portal's URL and scoped token in place of direct
credentials. See [OpenCode's provider configuration](https://opencode.ai/docs/providers/)
and [OpenRouter's OpenCode guide](https://openrouter.ai/docs/cookbook/coding-agents/opencode-integration).
Updating assignments replaces this managed provider's per-model configuration,
but preserves other providers and global settings. If fleet synchronization fails,
removed permissions stay removed and new permissions are not granted; refresh
the portal state, repair the fleet error, then retry. Legacy workspaces lacking
the managed OpenCode config need operator migration; no key is reconstructed
from its stored hash and existing installations are not silently imported.

As each disposable tenant user, verify access to the portal HTTP socket,
fleet socket, Caddy admin socket, sibling data and sibling loopback API is
denied. Follow the [fleet qualification recipe](../../docs/verification/fleet.md)
for actual user/process/network checks. Record versions and results; never
perform qualification against a customer's live data.

## Backups, recovery and removal

### Upgrading this deployment

Deploy a matching core **and** portal build with its installed dependencies
from the same reviewed commit. Stop new provisioning first, back up the state
below, and plan restarts of the fleet agent, portal and tenant services so
running work is not interrupted unexpectedly. Keep the previous release and
backups available; database changes may require restoring state as well as
reverting code. Qualify sign-in, tenant handoff, isolation and provider access
on the disposable deployment before repeating the update for clients.

`fleet upgrade`, `npm update -g openmausbot` and desktop auto-updates do **not**
update this source-checkout deployment or the Admin portal. The supplied units
run the paths under `/opt/openmausbot`, not the global npm installation. There
is no Admin updater or automatic database rollback in this change.

### State and recovery

Back up the portal SQLite database consistently (stop the portal before a
filesystem copy, or use SQLite's online backup facility), its secret/license
environment files, fleet registry/config, Caddy/service configuration and
tenant homes separately. Preserve file ownership/modes and the pnpm/runtime
release needed to restore. Portal SQLite uses WAL; copying only a live
`admin.sqlite` file is not a complete backup.

**Keep `OMB_ADMIN_SECRET` with the database backup, securely and separately.**
It derives the provider-key encryption key and also protects authentication
material. Replacing/losing it can make stored credentials unreadable and
invalidate sessions. It is not interchangeable with a workspace gateway token.
Do not rotate it by merely changing the environment; plan credential/session
recovery first. Never distribute this secret or master provider keys to a
workspace. Portal availability is required for online workspace access checks
and managed provider calls; outages fail closed.

`provisioning`/`error` means operator recovery, not proof that a service is
stopped. The portal marks interrupted creates as needing attention on restart;
neither layer blindly retries or rolls back host resources. Pause management,
back up both registries, and inspect the corresponding Unix account, home,
unit, instance env, Caddy site and fence before reconciling the two records.
Do not delete reservations or reuse a slug to force a retry.

Portal **Remove workspace** retains data: the service/site/env are disabled or
removed, but its home, nologin account, name, ports and fence remain reserved.
Keeping the Unix account prevents UID recycling into another customer's data.
There is no automatic restore or permanent-delete UI for retained workspaces;
disposal/restoration requires an explicit reviewed operator procedure. Member
removal does not delete conversations. Usage ledgers are tenant-controlled
estimates, not authoritative billing records.
