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

One GitHub App serves every workspace on the instance. While none is configured, any workspace owner or admin registers it from **Settings > Integrations** with GitHub's manifest flow; once one exists nobody can replace it from the app. On an instance where strangers can sign up and create workspaces, register the App before opening sign-up, or set `ORIGIN_ADMIN_EMAILS` in `.env` (comma-separated) to limit registration to those owners and admins. `ORIGIN_LEGACY_OWNER_EMAIL` no longer affects GitHub setup. The App is stored encrypted in `/data/origin` and takes precedence over the `GITHUB_CLIENT_*` variables; to replace a registered App, stop the app, delete the `github_app` row from `integrations.sqlite` in the persisted `/data/origin` volume (`sqlite3 <path>/integrations.sqlite "DELETE FROM github_app"`), start it again and reconnect each workspace. To use an existing App instead, set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `GITHUB_WEBHOOK_SECRET`, plus `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (PEM, `\n` for newlines) for issues as pull requests; `deploy/docker-compose.yml` passes them through from `.env`. Configure the App on GitHub (`https://origin.example.com` stands for your `ORIGIN_PUBLIC_URL`) exactly as the manifest flow would:

| App setting | Value |
| --- | --- |
| Homepage URL | `https://origin.example.com` |
| Callback URL | `https://origin.example.com/api/github/oauth/callback` |
| Request user authorization (OAuth) during installation | off |
| Setup URL | `https://origin.example.com/api/github/oauth/install` |
| Webhook | active, URL `https://origin.example.com/api/github/webhook`, secret = `GITHUB_WEBHOOK_SECRET` |
| Repository permissions | Administration, Contents, Issues, Pull requests: read and write; Checks, Metadata: read |
| Events | Issues, Pull request, Pull request review, Check suite, Check run, Push |
| Where can it be installed | Any account |

Then install the App on the accounts or organizations that own the repositories and connect each workspace from **Settings > Integrations**. A repository works for a workspace once an admin approves it in the project's Repo tab and the workspace's GitHub connection can read it.

Apps registered before the `push` event was added: open the App's settings on GitHub, subscribe to **Push**, and accept the change under **Installed GitHub Apps**. Without it, PRs still link and complete issues on merge; only `Closes ORI-…` in commits pushed straight to the default branch is missed.

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

- [ ] **Convex first.** `npx convex deploy` with the production deploy key (kept in your secret store, never in the repo or a shell profile), then build and start the web image.
- [ ] **Scheduled jobs.** In the Convex dashboard (Schedules), every pending job targets a function the new release still has. Jobs for the stubbed `agentRuns.promoteQueued`, `standup.runAll` and `standup.runProject` finish as no-ops (section 7).
- [ ] **Convex env** (`npx convex env list`): `ORIGIN_INTEGRATION_SECRET` equal to the server's, `ORIGIN_SEALING_KEY` unchanged, `ORIGIN_PUBLIC_URL` is the HTTPS origin without a trailing slash, `ORIGIN_SIGNUP_MODE` as intended.
- [ ] **Server `.env`:** `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CONVEX_SITE_URL` point at the production deployment (they are baked in at build time), same `ORIGIN_PUBLIC_URL` and `ORIGIN_INTEGRATION_SECRET`, GitHub variables when you use an existing App.
- [ ] **`ORIGIN_TRUSTED_PROXY=1`** only when the proxy overwrites `X-Real-IP`; otherwise leave it unset.
- [ ] **`ORIGIN_ADMIN_EMAILS`** lists the operator accounts, and those accounts exist.
- [ ] **`/data/origin`** is the persisted volume and has a current backup.
- [ ] **Smoke after deploy:** sign in, open a project board and an issue, send a chat message, check that `https://origin.example.com/api/mcp` answers 401 without a token, and read the app and Convex logs for errors. The full list is in section 5.

## 7. Upgrade an Existing Installation

Do not replace or import production data merely to publish code.

1. **Deploy Convex first, then the web image.** New web code calls Convex functions that only exist after `npx convex deploy`; old web code keeps working against the new functions because changes are additive.
2. **Pending jobs for removed functions are absorbed.** This release removes the desktop-only modules. Production may still hold scheduled jobs for `agentRuns.promoteQueued`, `standup.runAll`, `standup.runProject` (or an in-flight run of the old `agentRuns.expireStale` and `realtime.cleanup` crons); this release keeps no-op stubs with the same names and arguments (`convex/agentRuns.ts`, `convex/standup.ts`, `convex/realtime.ts`), so those jobs finish without doing anything. The stubs are removed in a later release, so do not skip this release when upgrading from the desktop backend.
3. **Crons.** Convex replaces the cron table on deploy, so the removed crons (including the daily 07:00 UTC standup) stop afterwards.
4. **Check the reverse proxy** sets `X-Real-IP` as above before setting `ORIGIN_TRUSTED_PROXY=1`.
5. After the web image is up, run the checks in section 5.
