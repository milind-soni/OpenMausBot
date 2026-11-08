# Deploy Origin

The standard deployment consists of a Next.js Node container, persistent local storage, a Convex backend, an HTTPS reverse proxy, and optionally coturn for calls across restrictive networks.

Upgrading a deployment that still runs the desktop backend: see [UPGRADE.md](UPGRADE.md).

## 1. Configure Convex

Create your own Convex project. Develop against a separate development deployment, and publish with `npx convex deploy` using its production deploy key. Never commit a deploy key. See [Convex custom hosting](https://docs.convex.dev/production/hosting/custom).

Set the resulting `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CONVEX_SITE_URL` in the server environment. These are public endpoint URLs, not access credentials. They are also required at build time.

Generate a random integration secret:

```sh
openssl rand -hex 32
```

Set the same value as `ORIGIN_INTEGRATION_SECRET` in the Node server and the selected Convex deployment's environment. Set `ORIGIN_PUBLIC_URL` in both to your HTTPS application origin, without a trailing slash. The secret authenticates the server-to-server integration bridge. Do not rotate it without coordinating both services.

Set a stable key that encrypts stored GitHub credentials in Convex (keep it; changing it makes stored credentials unreadable):

```sh
npx convex env set ORIGIN_SEALING_KEY "$(openssl rand -base64 32)"
```

Origin allows open sign-up by default. For a private instance, make it invite-only so new accounts can only be created from an invitation link:

```sh
npx convex env set ORIGIN_SIGNUP_MODE invite
```

Create your own account first, then switch the mode on. Remove the variable to reopen sign-up.

## 2. Run the Application

Copy `.env.example` to `.env` on your server, fill in your own values, and protect it with `chmod 600 .env`. Keep the file outside any public web root.

From the repository root:

```sh
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
```

The image builds Next.js once and runs its standalone Node server; development tooling is not started in production. Runner source is included for authenticated bootstrap and signed release downloads.

The app listens on `127.0.0.1:3000`. Route your HTTPS reverse proxy to it. Preserve `Host`, set `X-Forwarded-Proto`, and **overwrite** `X-Real-IP` with the actual client address, then set `ORIGIN_TRUSTED_PROXY=1` in `.env`. With nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

Caddy: `reverse_proxy 127.0.0.1:3000 { header_up X-Real-IP {remote_host} }`. Origin reads `X-Real-IP` (or the last `X-Forwarded-For` entry) only when `ORIGIN_TRUSTED_PROXY` is set, and then rate limits OAuth registration and token requests, failed MCP authentication and public feedback per client address. Without it the headers are ignored and those limits apply per endpoint (per OAuth client, per feedback form), so leave it unset when nothing in front of the app overwrites the header.

Persist `/data/origin`. It contains chat history, attachment files, call state, GitHub credentials, OAuth state, and encryption key material. Do not serve this directory as static files, include it in an image, or publish it. Do not run multiple app replicas against separate copies of this directory: this release uses a single-instance local collaboration store.

## 3. Connect GitHub

One GitHub App serves every workspace on the instance, so only the instance operator may register it. Set `ORIGIN_ADMIN_EMAILS` in `.env` to the operators' account emails (comma-separated; `ORIGIN_LEGACY_OWNER_EMAIL` also counts). When neither is set, the operator is the owner of the first workspace created on the instance, recorded the first time it is looked up (the `instance_operator` row in `integrations.sqlite`), so deleting or handing over that workspace later does not change it. Origin does not verify email addresses, so create the operator accounts before you open sign-up. While no App is configured, the operator registers it from **Settings > Integrations** using the GitHub manifest flow; everyone else sees GitHub as not available yet. The App is stored encrypted in `/data/origin` and takes precedence over the `GITHUB_CLIENT_*` variables; to replace a registered App, stop the app, delete the `github_app` row from `integrations.sqlite` in the persisted `/data/origin` volume (`sqlite3 <path>/integrations.sqlite "DELETE FROM github_app"`), start it again and reconnect each workspace. To use an existing App instead, set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `GITHUB_WEBHOOK_SECRET`, plus `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (PEM, `\n` for newlines) for issues as pull requests; `deploy/docker-compose.yml` passes them through from `.env`. Configure the App on GitHub (`https://origin.example.com` stands for your `ORIGIN_PUBLIC_URL`) exactly as the manifest flow would:

| App setting | Value |
| --- | --- |
| Homepage URL | `https://origin.example.com` |
| Callback URL | `https://origin.example.com/api/github/oauth/callback` |
| Request user authorization (OAuth) during installation | off |
| Setup URL | `https://origin.example.com/api/github/oauth/install` |
| Webhook | active, URL `https://origin.example.com/api/github/webhook`, secret = `GITHUB_WEBHOOK_SECRET` |
| Repository permissions | Administration, Contents, Issues, Pull requests: read and write; Checks, Commit statuses, Deployments, Metadata: read |
| Events | Issues, Pull request, Pull request review, Check suite, Check run |
| Where can it be installed | Any account (members connect their own personal accounts) |

Then install the App on the accounts that own the repositories and finish account authorization for each workspace from **Settings > Integrations**.

Existing App installations must approve added read-only Commit statuses and Deployments permissions. Merge checks still respect required reviews, branch protection and rulesets; the integration never bypasses them.

Repository creation uses the connected administrator's personal account and creates private repositories. For an existing repository, an admin must approve workspace access. A fine-grained project token is an optional alternative; never ask ordinary members for a server-wide token.

Server credentials are encrypted on disk. The encryption key and database must remain available together. Revoke credentials through the source service if the host is compromised.

## 4. Configure Email and Calls

SMTP is optional. Set `ORIGIN_SMTP_HOST`, `ORIGIN_SMTP_PORT`, `ORIGIN_SMTP_SECURE`, `ORIGIN_SMTP_USER`, `ORIGIN_SMTP_PASSWORD`, and `ORIGIN_SMTP_FROM`. Test an actual invitation; a saved configuration is not proof of delivery. Origin returns a shareable invitation link if mail delivery fails.

For a TURN relay, set `ORIGIN_TURN_HOST`, `ORIGIN_TURN_SECRET`, `ORIGIN_TURN_REALM`, and `ORIGIN_TURN_PUBLIC_IP` in your private server environment, then:

```sh
docker compose --env-file .env -f deploy/docker-compose.turn.yml up -d
```

Allow TCP/UDP 3478 and UDP 49160-49260. Keep the TURN secret identical in the app and relay. The provided relay uses host networking on Linux and denies private/multicast peers. Review `turn-firewall.sh` before applying its additional host egress restriction as root. Confirm an actual relayed call from two different networks.

## 5. Verify the Deployment

- Create a new account and workspace; an unrelated account must not see it.
- Test member and viewer permissions, invitation revocation, and session revocation.
- Send a chat attachment and test a call from a second browser/network.
- Connect GitHub, create a private repository, and close a linked test issue.
- Draw on the canvas from two sessions and confirm both edits persist.
- Enable a test feedback portal and check that no internal data is public.
- Check navigation on desktop and mobile browsers, HTTPS, health, disk capacity, and logs.

`ORIGIN_LEGACY_OWNER_EMAIL` and `GITHUB_TOKEN` exist only for an operator-controlled migration of an older Origin installation; leave them unset for a new installation. The legacy owner also counts as an instance operator (see section 3).

## 6. Pre-deploy Checklist

Run through this before every production deploy:

- [ ] **Convex first, verified target.** Follow section 7 for an existing installation. Use `convex deploy` only for the explicitly selected production deployment; a hosted app can legitimately use a named development deployment. Export the actual target before pushing additive schema/functions, then build and start the web image.
- [ ] **Scheduled jobs.** In the Convex dashboard (Schedules), every pending job targets a function the new release still has. Jobs for the stubbed `agentRuns.promoteQueued`, `standup.runAll` and `standup.runProject` finish as no-ops (section 7).
- [ ] **Convex env** (`npx convex env list`): `ORIGIN_INTEGRATION_SECRET` equal to the server's, `ORIGIN_SEALING_KEY` unchanged, `ORIGIN_PUBLIC_URL` is the HTTPS origin without a trailing slash, `ORIGIN_SIGNUP_MODE` as intended.
- [ ] **Server `.env`:** `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CONVEX_SITE_URL` point at the verified live deployment (they are baked in at build time), same `ORIGIN_PUBLIC_URL` and `ORIGIN_INTEGRATION_SECRET`, GitHub variables when you use an existing App.
- [ ] **`ORIGIN_TRUSTED_PROXY=1`** only when the proxy overwrites `X-Real-IP`; otherwise leave it unset.
- [ ] **Runtime dependency audit:** review `npm audit --omit=dev` before cutover. Apply compatible security fixes and exercise the affected runtime behavior; do not use forced major upgrades merely to clear an audit count. Sanitizer version overrides must not restore a known-vulnerable release.
- [ ] **`ORIGIN_ADMIN_EMAILS`** lists the operator accounts, and those accounts exist.
- [ ] **`/data/origin`** is the persisted volume and has a current backup.
- [ ] **Smoke after deploy:** sign in, open a project board and an issue, send a chat message, check that `https://origin.example.com/api/mcp` answers 401 without a token, and read the app and Convex logs for errors. The full list is in section 5.

## 7. Upgrade an Existing Installation

Do not replace or import production data merely to publish code.

1. **Verify the existing backend target, then push Convex before the web image.** Read the running web image's `NEXT_PUBLIC_CONVEX_URL`; do not assume the CLI's default production deployment is the hosted application's backend. For an existing development deployment, use `npx convex dev --once --env-file <private-target-file>` with the verified `CONVEX_DEPLOYMENT`, not an unqualified `convex deploy`. Export that exact named deployment before mutation. New web code calls new Convex functions; schema changes must remain additive so the previous web image can be restored.
2. **Pending jobs for removed functions are absorbed.** This release removes the desktop-only modules. Production may still hold scheduled jobs for `agentRuns.promoteQueued`, `standup.runAll`, `standup.runProject` (or an in-flight run of the old `agentRuns.expireStale` and `realtime.cleanup` crons); this release keeps no-op stubs with the same names and arguments (`convex/agentRuns.ts`, `convex/standup.ts`, `convex/realtime.ts`), so those jobs finish without doing anything. The stubs are removed in a later release, so do not skip this release when upgrading from the desktop backend.
3. **Crons.** Convex replaces the cron table on deploy, so the removed crons (including the daily 07:00 UTC standup) stop afterwards.
4. **Check the reverse proxy** sets `X-Real-IP` as above before setting `ORIGIN_TRUSTED_PROXY=1`.
5. After the web image is up, run the checks in section 5.

## 8. Supervised coding execution

Origin owns issue state, execution policy, approvals and receipts. A runner is a Node.js 24 service on each coding machine, not a Claude skill. It starts the explicitly selected native CLI in an isolated worktree. Origin always exposes redacted logs and approvals; optional Herdr consoles provide another task view without opening or focusing the desktop application. Personal checkouts and existing CLI installations are not replaced. Assigning a human issue owner does not dispatch coding: use **Develop** or the authorized `start_execution_run` tool.

A worktree isolates Git state, not operating-system access. Native coding tools run with the runner user's filesystem privileges, subject to their supported approval controls. Use a separate OS account or disposable cloud worker for code that must not share your personal user's access.

### Enroll a local machine

1. From a trusted Origin checkout, run `node runner/cli.mjs install`. This writes the versioned runner, local alias and systemd-user/launchd assets; it does not start them.
2. In **Settings > Machines**, select the machine kind, exact Tailscale name and explicitly approved projects. Generate a one-time enrollment.
3. Run the displayed command on that machine. Paste the separate token only into its hidden terminal prompt, never into shell arguments, chat or source. Enrollment expires after fifteen minutes and is single-use.
4. Run the activation command printed by the installer. For a foreground run instead, use `node runner/cli.mjs run`.

`origin-runner status --refresh` inspects native sign-in, model and usage metadata without sending a model prompt. `pause` prevents new claims; `resume` clears the local pause/stop request; `stop` requests cancellation and a durable stopped receipt. A stop request or lost connection is not proof that execution has stopped.

The private configuration defaults to `~/.config/origin-runner/config.json` (owner-only, mode 0600). State defaults to `~/.local/share/origin-runner`: bare repository caches under `repositories/`, per-run worktrees under `worktrees/`, sessions and durable receipts beside them. The runner pushes verified task/checkpoint branches, never the protected base branch. It does not reset personal repositories or silently reuse an old worktree.

### Herdr task consoles and desktop connections

Install the native `hc`/Herdr core (the new desktop core, not the older `herdr` TUI). Keep the desktop core available in the selected session. With the worker cleanly stopped, run `origin-runner herdr enable`, then start its existing supervisor. This creates a background **Origin task console**, not a duplicate of the coding harness's native interactive UI. The chosen OMP/Claude/Codex/Pi process keeps its structured protocol, process guardian and resource controls.

The console shows bounded, redacted progress. Enter task text for a follow-up, `/cancel` to request cancellation, or `/quit` to detach without stopping execution. A private per-run socket authenticates the local owner; each control refreshes Origin authorization and the lease, and durable input IDs prevent replay. Tool approvals remain in the owner's Origin UI. Hermes uses the existing scoped get/message/cancel tools: no personal-terminal enumeration, arbitrary keystrokes, administrative shell or raw Herdr access.

`origin-runner herdr enable --cloud` additionally opts this desktop into active Boxd/Boat task connections; `herdr disable` removes this integration's owned aliases. Both changes require the worker to be stopped and explicitly restarted. `herdr status` reports local configuration; **Settings > Machines** shows the latest worker observation. Run details contain the last reported terminal identity, not a guarantee that it remains open after a run, core restart or host reboot.

Both cloud bootstraps pin verified core `0.1.18` in the dedicated `origin-runner` account and `origin-cloud` session. Current owner/project authorization, a live allocation and fresh worker readiness are required before Origin grants a short-lived desktop connection. Grants renew only while eligible, do not extend the VM's idle deadline, and expired/revoked aliases are removed. Desktop native Boxd/Boat login is separate from Origin's write-only provider key; no provider key is copied to a desktop.

Discovery does not start or resume a VM. The transport checks native provider state before reconnecting; Boat refreshes its rotating SSH endpoint/host-key information through its native CLI. Never disable SSH host-key verification. Boxd SSH can itself wake a hibernated machine, so its native API cannot eliminate the external-hibernation race between checking state and connecting; connection grants and controller-managed stops remain bounded. Real provider lifecycle/billing validation is required before enabling cloud use.

### Accounts, policies and secrets

- Sign in locally using the native CLI. Metadata is deduplicated by owner/provider/account identity; OAuth credentials remain on that machine. Do not copy NixOS OAuth caches into cloud images.
- Idle runners refresh native metadata once per minute; discovery itself can take longer. Active runs retain honest timestamps rather than inventing fresh quotas. A newer telemetry-free native profile cannot erase known quota windows from another profile of the same account; old evidence remains explicitly stale.
- Workspace defaults, project policies and task overrides choose account, harness, model, effort and fallback order. NixOS is preferred for portable projects. Mac is Apple-only unless explicitly selected.
- Cloud fallback requires recent independent evidence that every eligible local machine is offline. Busy, paused, stale, missing authentication and unknown presence are not permission to spend on cloud compute.
- API billing requires explicit permission on the actual selected native profile. Unknown billing is blocked, and the runner rechecks the accepted billing type before executing. Native subscription sign-in does not turn off provider-side paid extras.
- Opaque native credentials without verifiable identity require an explicit owner-verified local binding; a present Pi credential alone is not treated as authenticated account identity. No guessed model catalog, quota or identity is used.
- Automation environments are separate from the personal passphrase vault. Grant secrets only to explicit project/environment/host scopes. Temporary application variables stay outside the checkout and are removed before a stopped receipt; provider keys are not injected into coding CLI authentication.

### Merge and deployment receipts

Configure both verification commands and a runnable smoke check before starting. Automatic merge is enabled by default. Origin verifies the exact pushed head and configured base (`main` by default). With no applicable GitHub protections or rules, it advances the base using a non-forced fast-forward to that exact verified commit and confirms the merged PR receipt. Protected branches retain enforced up-to-date checks and required reviews; unknown rules or bypass privileges never silently weaken those gates.

If another task advances the base, Origin queues a **verification-only** attempt (runner `1.1.0` or later): it preserves the prior checkpoint and stop receipt, creates a new attempt-specific worktree, merges the current base without force, and reruns tests and smoke. It does not spend another model turn or require a fresh coding account. Conflicts or failing checks block the merge; an explicit continuation may start coding to resolve them. Successful independent tasks need no manual merge. Repository merge locks and Git ancestry checks protect concurrent completions.

A lost merge response is recovered by a read-only exact-head PR lookup, including when GitHub already closed the issue. Closed issues never authorize another merge.

Deployment is separate. Origin reads GitHub deployment/status evidence for the exact confirmed merge SHA, shows its environment, event timestamp and last-check timestamp, and continues observing later status changes. Missing or inaccessible evidence remains unknown. A successful check, merge or push to `main` does not itself deploy an application; configure the application's release pipeline separately.

### Private cloud workers

Configure Boxd and Boat independently in the write-only credential forms. Boxd is the default selection, not an automatic credit-spending fallback. Zero reported Boxd credits stop admission; unknown balance is not confirmed exhaustion. Switching to Boat is an explicit policy change.

Workers reuse one journaled private machine per owner/project/provider. Uncertain creation never triggers a duplicate create. Native login is still required on each private worker. An unready allocation cannot claim work; recovery revalidates authorization and local-offline eligibility. Missing login/heartbeat cannot hold an unused paid machine indefinitely. Provider persistence is not a backup guarantee.

Boxd automatic idle hibernation is disabled before bootstrap, but this does not promise that the provider can never capture memory. Its observed cold-stop state is distinct from verified application-environment cleanup. Boat archival can retain a machine, so it is never treated as process-termination proof on its own: uncertain runs stay fenced unless the guest supervisor's shutdown is independently acknowledged. Boat's `noEnv` setting persists from creation; resume must not redundantly request credential scrubbing. Private custom-home OAuth persistence and both providers' actual systemd/cgroup behavior require live validation before enabling workers.

### Updates and the phone gateway

Runner/native-tool maintenance is idle-only, with verified immutable releases, preflight checks, persistent quarantine and rollback. Only explicitly runner-managed tool prefixes may be changed; existing Nix, Homebrew and personal/global installs receive package-manager instructions instead. `install --files-only` is for externally supervised cloud workers and creates no user service. Local installations prefer a stable Node 24 executable alias so a package-manager replacement does not strand the service.

HTTPS enrollment pins that Origin instance's Ed25519 public key and same-origin release URL. The server persists the private signing key as owner-only `/data/origin/runner-signing.key`; back it up with the application volume. Losing or replacing it requires explicit owner trust review/re-enrollment, not automatic acceptance of a different key. Increment `runner/security.mjs`'s `VERSION` whenever publishing changed runner code; never change the bytes of an already published version.

Automatic updates are disabled until the local owner opts in. Initialize each desired tool against its exact local account first; this selects a private executable without copying or replacing that account's OAuth profile:

```sh
origin-runner update --tools --tool codex --initialize --account LOCAL_ACCOUNT_ID --approve
origin-runner update --automatic --enable --tool codex --runner --approve
```

The running supervisor checks daily while idle. It applies only compatible stable releases, preserves the previous version, and reports checks/results in **Settings > Machines**. Major compatibility changes (minor changes for a `0.x` tool), quarantined versions, ambiguous stop state and unmanaged installations require explicit action. Native subscription authentication remains separate; updating a binary cannot repair expired login or provider billing.

`origin-runner update --check` checks signed runner releases without applying them. `origin-runner update --tools --check` checks native tools. Use `update --automatic --disable --approve` to disable automatic application without modifying personal CLI installations.

The dedicated Hetzner controller setup is in `deploy/origin-controller/`. Configure `ORIGIN_EXECUTION_TEAM_ID` on the Origin server and `ORIGIN_EXECUTION_CONTROLLER_TOKEN_HASH` as the SHA-256 hex digest of a separately generated, high-entropy 32–200 character bearer. Keep the raw bearer in the controller's owner-only `service-token` file, supplied through systemd `LoadCredential`; never reuse an owner MCP or worker token. The server stores only its digest and accepts controller ticks only for that workspace.

After local enrollment, map each Origin host ID to its stable Tailscale peer ID and full DNS name in `/etc/origin-controller/config.json`. An empty mapping reports no presence evidence: it cannot establish that local machines are offline or authorize cloud fallback. Run `systemctl start origin-controller.service` successfully before enabling `origin-controller.timer`.

The pinned, nonroot Hermes operator commands are documented at the top of `deploy/hermes/manage.py`. Hermes receives scoped Origin MCP controls, not provider cloud keys, a Docker socket or root access. Its model/login is separate from coding CLI subscriptions.

Personal WhatsApp pairing requires the owner's risk acknowledgement and QR scan. Hermes uses its documented Baileys path, not an official Meta bot API; account restrictions and protocol changes remain possible. Allowlist senders. The dedicated service stays disabled until native model login, scoped Origin MCP authorization and pairing are complete.

Hermes's daily timer checks metadata only by default. Administrator `enable-auto-updates` opt-in requires authenticated health and an explicit managed chat model. Its automatic scope is deliberately restricted to same-minor stable changes in reviewed cache/compaction modules and inert documentation/tests; other runtime, gateway, auth, policy, installer or dependency changes require a reviewed pinned update. This is **not an always-latest guarantee**. Both automatic and manual application retain the idle/drain/backup/effective-policy/health/rollback gates in `deploy/hermes/manage.py`. The runtime and dependencies remain root-owned; only the private coordinator data and exact PM locks/leases are service-writable. Human chat smoke is still required: health checks do not send an LLM prompt.
