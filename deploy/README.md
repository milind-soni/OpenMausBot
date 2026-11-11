# Deploy Origin

A deployment is a Convex backend, which holds every piece of state, and a stateless Next.js frontend: on Vercel (section 2a) or as a Node container behind an HTTPS reverse proxy (section 2b). Optionally add coturn for calls across restrictive networks.

Upgrading a deployment that still runs the desktop backend: see [UPGRADE.md](UPGRADE.md).

## 1. Configure Convex

Create your own Convex project. Develop against a separate development deployment, and publish with `npx convex deploy` using its production deploy key. Never commit a deploy key. See [Convex custom hosting](https://docs.convex.dev/production/hosting/custom).

Set the resulting `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CONVEX_SITE_URL` in the server environment. These are public endpoint URLs, not access credentials. They are also required at build time.

Generate a random integration secret:

```sh
openssl rand -hex 32
```

Set the same value as `ORIGIN_INTEGRATION_SECRET` in the Node server and the selected Convex deployment's environment. Set `ORIGIN_PUBLIC_URL` in both to your HTTPS application origin, without a trailing slash. The secret authenticates the server-to-server integration bridge. Do not rotate it without coordinating both services.

Set a stable key that encrypts stored secrets in Convex: GitHub App and connection tokens, MCP OAuth connector tokens and OAuth states (keep it; changing it makes them unreadable):

```sh
npx convex env set ORIGIN_SEALING_KEY "$(openssl rand -base64 32)"
```

Origin allows open sign-up by default. For a private instance, make it invite-only so new accounts can only be created from an invitation link:

```sh
npx convex env set ORIGIN_SIGNUP_MODE invite
```

Create your own account first, then switch the mode on. Remove the variable to reopen sign-up.

Convex environment variables, all set with `npx convex env set` (never in the frontend):

| Variable | Required | Purpose |
| --- | --- | --- |
| `ORIGIN_INTEGRATION_SECRET` | yes | Same value as the frontend's; authenticates the signed `/integrations` bridge both ways. |
| `ORIGIN_SEALING_KEY` | yes | 32 random bytes (base64 or hex). Seals every stored secret. Keep it stable. |
| `ORIGIN_PUBLIC_URL` | yes | The frontend origin, e.g. `https://origin.imbored.fun`, no trailing slash. The GitHub sync cron calls `<origin>/api/integrations/tick`. |
| `ORIGIN_SIGNUP_MODE` | no | `invite` for invitation-only sign-up. |
| `ORIGIN_LEGACY_OWNER_EMAIL` | no | Migration of an older installation only; set it in the frontend too. |
| `ORIGIN_RUNNER_SIGNING_KEY` | no | Only when moving from a store that has `runner-signing.key` (section 8): base64 of that PEM file, so a future runner release endpoint signs with the key existing coding runners already trust. Nothing in this release reads it; it keeps the key out of tables and off disk. |

## 2a. Run the Frontend on Vercel

The repository deploys to Vercel as is: `vercel.json` selects the Next.js preset, `npm ci` and `npm run build` (`next build --webpack`), and runs functions in `dub1` (Dublin), next to a Convex deployment in `eu-west-1`; pick the region closest to yours. The frontend keeps nothing on disk or in memory between requests: chat, attachments (uploaded from the browser straight to Convex storage), call signaling, GitHub and MCP credentials, rate limits and leases all live in Convex, so any number of function instances can serve it. The GitHub sync tick (`/api/integrations/tick`, every 2 minutes from a Convex cron) and the GitHub webhook declare `maxDuration = 60`.

Set these in **Project Settings > Environment Variables**. *Build* variables are inlined into the client bundle, so a change needs a redeploy; the rest are read at runtime. Mark the secrets *Sensitive*.

| Variable | When | Production | Preview |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_CONVEX_URL` | build + runtime | `https://wry-fly-446.eu-west-1.convex.cloud` | a non-production Convex deployment's URL |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | build + runtime | `https://wry-fly-446.eu-west-1.convex.site` | that deployment's `.convex.site` URL |
| `ORIGIN_PUBLIC_URL` | runtime | `https://origin.imbored.fun` (no trailing slash) | the preview's stable domain, if previews should work end to end |
| `ORIGIN_INTEGRATION_SECRET` | runtime, sensitive | the value in wry-fly-446's Convex env | that deployment's secret; **never** the production one |
| `ORIGIN_TRUSTED_PROXY` | runtime | `1` (see below) | `1` |
| `ORIGIN_ADMIN_EMAILS` | runtime | operator accounts, comma-separated | as needed |
| `ORIGIN_LEGACY_OWNER_EMAIL` | runtime | only if set in Convex too | unset |
| `ORIGIN_SMTP_HOST`, `_PORT`, `_SECURE`, `_USER`, `_PASSWORD` (sensitive), `_FROM` | runtime | your SMTP relay | unset (invites fall back to links) |
| `ORIGIN_TURN_HOST`, `ORIGIN_TURN_SECRET` (sensitive) | runtime | your coturn relay (section 4) | optional |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN` | runtime, sensitive | only to use an existing App instead of the registered one (section 3) | unset |

- **`ORIGIN_LOCAL_DATA_DIR` is gone.** Nothing reads it; leave it unset. The old `/data/origin` contents move to Convex once with the migration in section 8.
- **`ORIGIN_TRUSTED_PROXY=1` on Vercel.** Vercel's edge sets `X-Real-IP` and overwrites `X-Forwarded-For` with the connecting client's address, so per-client rate limits work. If you put another proxy in front of Vercel (for example Cloudflare with proxying on), Vercel sees that proxy's addresses instead: point DNS straight at Vercel, or leave the variable unset to fall back to per-endpoint limits.
- **Previews never get production secrets.** A preview build with wry-fly-446's `ORIGIN_INTEGRATION_SECRET` could read and write production credentials. Point previews at a development Convex deployment, or leave the Convex variables unset for Preview (the app then shows as unavailable). Keep Vercel Deployment Protection on for previews.
- **Convex is deployed separately.** This repository's Vercel build only runs `npm run build`; it does not publish Convex. Deploy Convex first (`npx convex deploy` with the production deploy key), then the frontend. If you later switch the build command to `npx convex deploy --cmd 'npm run build'`, scope `CONVEX_DEPLOY_KEY` for wry-fly-446 to **Production only**, and make the command fall back to plain `npm run build` when the key is absent, so a Preview build can never publish to production Convex.

## 2b. Run the Frontend as a Container

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

The container keeps no state: it needs no volume, can be replaced at any time, and several replicas can run behind the proxy. An existing `origin-data` volume is no longer mounted; keep it until the migration in section 8 is verified, then remove it.

## 3. Connect GitHub

One GitHub App serves every workspace on the instance. While none is configured, any workspace owner or admin registers it from **Settings > Integrations** with GitHub's manifest flow; once one exists nobody can replace it from the app. On an instance where strangers can sign up and create workspaces, register the App before opening sign-up, or set `ORIGIN_ADMIN_EMAILS` in `.env` (comma-separated) to limit registration to those owners and admins. `ORIGIN_LEGACY_OWNER_EMAIL` no longer affects GitHub setup. The App is stored in Convex (`githubAppRegistrations`, sealed with `ORIGIN_SEALING_KEY`) and takes precedence over the `GITHUB_CLIENT_*` variables; to replace a registered App, delete its row from `githubAppRegistrations` in the Convex dashboard and reconnect each workspace. To use an existing App instead, set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `GITHUB_WEBHOOK_SECRET`, plus `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (PEM, `\n` for newlines) for issues as pull requests; `deploy/docker-compose.yml` passes them through from `.env`. Configure the App on GitHub (`https://origin.example.com` stands for your `ORIGIN_PUBLIC_URL`) exactly as the manifest flow would:

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

Stored credentials are sealed in Convex with `ORIGIN_SEALING_KEY` (AES-256-GCM, bound to the row they belong to); MCP OAuth codes and tokens are kept only as SHA-256 hashes. The frontend never holds the key. Revoke credentials through the source service if the Convex deployment or its environment is compromised.

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
- Check navigation on desktop and mobile browsers, HTTPS, and the frontend (Vercel) and Convex logs.

`ORIGIN_LEGACY_OWNER_EMAIL` and `GITHUB_TOKEN` exist only for an operator-controlled migration of an older Origin installation; leave them unset for a new installation. The legacy owner also counts as an instance operator (see section 3).

## 6. Pre-deploy Checklist

Run through this before every production deploy:

- [ ] **Convex first.** `npx convex deploy` with the production deploy key (kept in your secret store, never in the repo or a shell profile), then deploy the frontend.
- [ ] **Scheduled jobs.** In the Convex dashboard (Schedules), every pending job targets a function the new release still has. Jobs for the stubbed `agentRuns.promoteQueued`, `standup.runAll` and `standup.runProject` finish as no-ops (section 7).
- [ ] **Convex env** (`npx convex env list`): `ORIGIN_INTEGRATION_SECRET` equal to the server's, `ORIGIN_SEALING_KEY` unchanged, `ORIGIN_PUBLIC_URL` is the HTTPS origin without a trailing slash, `ORIGIN_SIGNUP_MODE` as intended.
- [ ] **Frontend env** (Vercel Production, or the server `.env`): `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CONVEX_SITE_URL` point at the production deployment (they are baked in at build time), same `ORIGIN_PUBLIC_URL` and `ORIGIN_INTEGRATION_SECRET`, GitHub variables when you use an existing App. Preview has none of the production secrets.
- [ ] **`ORIGIN_TRUSTED_PROXY=1`** only when the proxy overwrites `X-Real-IP`; otherwise leave it unset.
- [ ] **`ORIGIN_ADMIN_EMAILS`** lists the operator accounts, and those accounts exist.
- [ ] **Backup:** a current `npx convex export` of the production deployment (the frontend has nothing to back up).
- [ ] **Smoke after deploy:** sign in, open a project board and an issue, send a chat message, check that `https://origin.example.com/api/mcp` answers 401 without a token, and read the app and Convex logs for errors. The full list is in section 5.

## 7. Upgrade an Existing Installation

Do not replace or import production data merely to publish code.

1. **Deploy Convex first, then the web image.** New web code calls Convex functions that only exist after `npx convex deploy`; old web code keeps working against the new functions because changes are additive.
2. **Pending jobs for removed functions are absorbed.** This release removes the desktop-only modules. Production may still hold scheduled jobs for `agentRuns.promoteQueued`, `standup.runAll`, `standup.runProject` (or an in-flight run of the old `agentRuns.expireStale` and `realtime.cleanup` crons); this release keeps no-op stubs with the same names and arguments (`convex/agentRuns.ts`, `convex/standup.ts`, `convex/realtime.ts`), so those jobs finish without doing anything. The stubs are removed in a later release, so do not skip this release when upgrading from the desktop backend.
3. **Crons.** Convex replaces the cron table on deploy, so the removed crons (including the daily 07:00 UTC standup) stop afterwards.
4. **Check the reverse proxy** sets `X-Real-IP` as above before setting `ORIGIN_TRUSTED_PROXY=1`.
5. After the web image is up, run the checks in section 5.

## 8. Move from the Local Store to Convex (one time)

Releases before this one kept chat, attachments, call state, GitHub and MCP credentials, rate limits and coding-runner state in the frontend's `ORIGIN_LOCAL_DATA_DIR` (`/data/origin`: `origin.sqlite`, `integrations.sqlite`, `execution.sqlite`, `files/`, `integrations.key`, `runner-signing.key`). `scripts/migrate-local-store-to-convex.ts` imports a copy of that directory into Convex through the signed `/integrations` action:

```sh
# Offline dry run: source counts only, contacts nothing
node scripts/migrate-local-store-to-convex.ts /path/to/origin-data --offline

# Dry run compared with Convex (read-only): planned inserts, updates, skips and deletes per table
ORIGIN_INTEGRATION_SECRET=… node scripts/migrate-local-store-to-convex.ts /path/to/origin-data \
  --convex-site-url https://wry-fly-446.eu-west-1.convex.site

# Import
ORIGIN_INTEGRATION_SECRET=… node scripts/migrate-local-store-to-convex.ts /path/to/origin-data \
  --convex-site-url https://wry-fly-446.eu-west-1.convex.site --apply
```

- **Dry run is the default** and writes nothing: not to Convex, and not to the directory (sqlite files are read from a temporary copy). It prints one row per source table: rows, insert, update, skip, delete; then notes (key files, realtime.json) and the files it will not import.
- **`--apply` is idempotent.** Every row is upserted by its old primary key; a second run reports 0 inserted, 0 updated, 0 deleted. Chat a workspace had copied from Convex (`convex-chat:<team>` markers) is made to match the local copy, including edits and deletions made since; chat the new frontend wrote is never changed. After a successful run, later runs warn: re-run only while the old frontend is still the only writer.
- **Secrets are re-sealed.** Values sealed with `integrations.key` are opened locally and sealed again by Convex with `ORIGIN_SEALING_KEY` under their original purpose. A wrong key, or a sealed field the script does not know, aborts the run instead of copying ciphertext. `integrations.key` is never sent; keep it offline until the import is verified, then destroy it.
- **`runner-signing.key` is never sent.** The script checks it is Ed25519 and prints its public-key fingerprint. Set it by hand if you want to keep it: `npx convex env set ORIGIN_RUNNER_SIGNING_KEY "$(base64 -w0 runner-signing.key)"`.
- **What goes where:** chat, direct conversations, read markers and attachments into the existing `teamChat*` tables and Convex file storage; GitHub App and tokens, OAuth states, job markers, MCP OAuth clients/grants/codes/tokens, rate-limit windows and invite delivery claims into the tables in `convex/serverStoreTables.ts`; queued mention notifications are delivered; queued MCP revocations are applied; `execution.sqlite` (no current code reads it) and `instance_operator` are kept in `localStoreArchive` with their secrets re-sealed. Call presence and signals are ephemeral and skipped; so are expired limits, leases and states. `cloud-boxd-before-*.json`, `maintenance/` and other files are listed as not imported.
- `realtime.json` from the oldest releases is imported only if `origin.sqlite` never did (`legacy-chat` marker); pass `--legacy-workspace-id <teamId>` then.

Order: set Convex env (`ORIGIN_SEALING_KEY`, `ORIGIN_INTEGRATION_SECRET`, `ORIGIN_PUBLIC_URL`, optionally `ORIGIN_RUNNER_SIGNING_KEY`), deploy Convex, stop writes on the old frontend, run the import (dry run, then `--apply`; rehearse on a copy first), deploy the new frontend, switch DNS, then retire the old host after verification.
