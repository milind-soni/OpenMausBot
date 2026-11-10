# Self-hosted MausBot — design

Version 1, 2026-11-10. Each section says what it decides; [Status against the code](#status-against-the-code) says
what exists today. Anything not listed there as built is planned.

## Decision

Sell self-hosted as "your servers, our control plane" (connected mode) on the Business self-hosted plan. No new
repository. Air-gapped comes later.

## Modes of one install

| Mode | Who | Connector | Talks to us |
|---|---|---|---|
| Standalone | Individuals, open-source | No | Only the optional services it already uses |
| Connected | Business self-hosted | Yes | One outbound connection: signed jobs in, version, health, seat count and job results out |
| Air-gapped (later) | Enterprise | No | Nothing; offline licence and update bundles |

A standalone server becomes connected by enrolling the connector. No reinstall, no data move.

## Parts and where the code lives

- **Home**: the server image our own Clouds run (`ghcr.io/milind-soni/openmausbot`). This repository.
- **Connector** (`connector/`): enrols with a one-time code, holds its own Ed25519 key, keeps one outbound WebSocket
  and runs only a fixed job list: `start`, `stop`, `restart`, `update`, `status`, `backup`, `restore`, `export-disk`,
  `import-disk`, `host-health`, `self-update`. No shell, no command of its own choosing, no read of a file by path. In
  this repository, so customers can read what it can do.
- **Installer**: one script with a preflight. This repository.
- **Paid-only features** (SSO, seat checks): `enterprise/` in this repository, under its source-available licence.
- **Control plane**: our Admin, in a private repository: enrolment, entitlements, update scheduling, health, billing,
  operations.
- The licence signing key is in neither repository.

## Principles

1. Customer data stays on the customer's server: bots, chats, files, AI keys, people, roles, activity, usage. The
   admin console is served by their server.
2. Our outage never stops their bots or their sign-in. Only updates and health reporting pause.
3. One image. Self-hosted runs what our Clouds run; no fork, no second profile to keep safe.
4. Security hardening is never paid-only. Any server more than one person can sign in to runs the hardened profile:
   bot sandbox on, service trust (not owner trust) for local requests, AI keys and saved logins out of a bot's reach.
5. The connector's powers are a short published list, every job is signed by us and verified, every job is logged on
   the customer's server, and the customer can pause remote management.
6. What leaves the server in connected mode is a short published list: version, health codes and counts, seat count,
   job results. Nothing a person wrote.

The published lists of principles 5 and 6 are the docs page
[What a connected server shares](../../apps/docs/content/docs/self-hosting/connected-servers.mdx). It describes the
code as it is, including where the code does not meet these two principles yet.

## Updates

- Channel `stable`: a version is promoted to stable only after our own Clouds have run it for 48 hours. `latest` keeps
  following `main` and is not for customers.
- The customer picks a weekly window, and automatic or approve-first.
- Each update: back up first, pull the image by digest, start, check health; on failed health roll back to the
  previous image and the backup, and report it.
- The rule that makes rollback safe: version N's data must stay readable by N-1. The data directory carries a schema
  marker; a change that breaks the rule ships in two releases (read the new format first, write it one release later).
- Standalone servers get the same update as one command they run themselves.
- Skew: desktop and phone apps work with any stable server from the last 90 days; an older server shows a banner.

## Entitlements

Replaces hand-issued licence keys: a signed document with customer, features, seats, issued, expires. Verified offline
with public keys built into the app. Connected servers get a short-lived one (about 35 days) refreshed automatically;
a lapse follows the existing warning and grace, then paid features stop and the server keeps running. Seats are soft:
over the limit blocks new invites and shows a banner, and never locks anyone out.

## Onboarding (connected)

Buy → dashboard account → **Add your own server** shows a one-line command with a single-use one-hour code →
preflight (OS, CPU, RAM, disk, Docker, ports, DNS, outbound) → install → the server appears as pending → the Owner
accepts → own domain with HTTPS → AI keys → invite the team → first bot → choose the update window. Target: under 30
minutes.

## Supported at first

Ubuntu 22.04 and 24.04, x86-64, Docker. arm64 after it is tested.

## Phases

0. Signing key, this document in the repository.
1. Design partners: hardened default, installer with preflight, stable channel and update with rollback, Add your own
   server (backend, UI, signing on), entitlements from the Admin, health and operations for customer servers, runbook.
2. Sellable: OIDC SSO on the home, seat counting, scheduled backups to the customer's bucket, diagnostics bundle,
   checkout, published network list, sizing guide, DPA and SLA.
3. Enterprise: air-gapped, more roles, SCIM, white-label.

## Retire

The Coolify hosted-workspace path (never proven on a real install). `fleet` stays but is not the business offering.

## Status against the code

Read at commit `542f8e55f`. "Built" means the code is in this repository; it does not mean a customer can buy it.

### Built

- The connector: enrolment with a one-time code, its own Ed25519 key, pinned Admin keys, one outbound WebSocket, the
  eleven jobs above, each signed for one server and refused 15 minutes after signing (`connector/src/protocol.ts`,
  `agent.ts`, `jobs.ts`).
- A server the team's Owner has not accepted answers only `status` and `host-health` (`agent.ts`).
- The audit log on the customer's server, `/var/log/mausbot/audit.jsonl`: one line per job, step, result and Admin
  request, each carrying the hash of the line before it. A job that changes something is refused when it cannot be
  logged (`audit.ts`, `jobs.ts`).
- The owner's policy file, `/etc/mausbot/policy.json`: the job kinds we may run, and a hold on updates (`policy.ts`).
- `update` with a safety copy of the data and a rollback of image and data when the new version does not report
  healthy (`home.ts`).
- The connector's own installer with a preflight, `connector/install.sh`, which the Admin is to serve with its address
  and the connector's image digest filled in.
- The offline licence check for paid features (`enterprise/server/license.ts`).

### Different from this document

- **Job list.** An earlier draft listed nine jobs. The code has eleven: `export-disk` uploads a gzip archive of the
  whole data directory to the Admin, and `import-disk` replaces the data directory with an archive from an HTTPS
  address. They move a Cloud between our servers and a customer's. `export-disk` sends everything people wrote, so
  principle 6 does not hold while a server's policy allows it.
- **Requests to the home.** Besides jobs, the Admin opens streams on the same connection, each carrying one HTTP
  request for the home (`home-requests.ts`). The home answers only requests signed with its own secret, among them
  `POST /api/cloud/pairing`, which opens a sign-in for a named member. Each request is in the audit log. The policy
  file does not cover them. They are not on the job list of principle 5.
- **Which image.** The connector starts `ghcr.io/milind-soni/openmausbot-cloud-home` by digest, with the Cloud
  settings the Admin sends, on its own data volume (`mausbot-data`). The standalone install runs
  `ghcr.io/milind-soni/openmausbot` on its own data. Enrolling the connector on a standalone server therefore does
  not connect that server: it prepares a second home beside it. "No reinstall, no data move" is planned.
- **What leaves the server.** A connected home reports more than version, health and job results; the docs page above
  lists it. The connector does not send a seat count.
- **Sign-in during our outage.** The MausBot dashboard signs a person in to a connected home through a pairing the
  Admin sends, so that way in stops while we are down or the connector is stopped. Sessions the home already issued
  keep working. Principle 2 for sign-in is planned.
- **Pausing remote management.** Today that is the policy file (`"jobs": []` refuses every job but the connector's own
  update) or stopping the connector. A switch in the product is planned.
- **The update window.** The connector receives and keeps the window the Admin signs, and runs an update when the
  Admin sends the job. Choosing the window is the Admin's.

### In review

Written and under review, not merged:

- **The installer** (`deploy/install.sh`, #5158): the preflight, the install under `/opt/openmausbot`, and for a
  version with the hardened profile the host's preparation for the bots' sandbox and the server's own self-check of
  it. It places `update.sh` and keeps the version that pins.
- **The `stable` channel and the one-command update with rollback** for standalone servers (`deploy/update.sh`,
  #5171). No `stable` image tag is published yet.
- **The hardened default** for shared servers and the server image (#5180).

They can merge in any order. The installer turns the sandbox on and places `update.sh` only once the other two are on
`main` and a release carries the hardened profile; before that it says what is not there yet.

### Planned

Entitlements from the Admin with seats, Add your own server in the dashboard, the schema marker in the data
directory, the 90-day skew banner, and everything in phases 2 and 3.
