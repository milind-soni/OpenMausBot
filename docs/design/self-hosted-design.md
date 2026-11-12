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
  and runs only a fixed job list. No shell, no command of its own choosing, no read of a file by path. In this
  repository, so customers can read what it can do. It has two modes, chosen on the server when it enrols:
  - `customer-run`, for a server its owner installed: seven jobs from us (`start`, `stop`, `restart`, `update`,
    `status`, `backup`, `host-health`), two more that only root on the server may run (`self-update`, `restore`),
    four requests it answers itself, and a reduced report. The whole list is `connector/src/customer-run.ts`. This is
    the mode of the Business self-hosted plan.
  - `operated`, for a server we run a Team Cloud on: those jobs plus `export-disk` and `import-disk`, a `start` that
    carries the image and the settings, and the Admin's signed requests to the home, pairing among them.
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
`customer-run` mode as the code is, including what is still planned.

## Updates

- Channel `stable`: a version is promoted to stable only after our own Clouds have run it for 48 hours. `latest` keeps
  following `main` and is not for customers.
- The customer picks a weekly window, and automatic or approve-first.
- Each update: back up first, pull the image by digest, start, check health; on failed health roll back to the
  previous image and the backup, and report it.
- The rule that makes rollback safe: version N's data must stay readable by N-1. The data directory carries a schema
  marker; a change that breaks the rule ships in two releases (read the new format first, write it one release later).
- Standalone servers get the same update as one command they run themselves, or from **Update server** in the app on a
  Docker install whose host has `deploy/update-runner.sh` (the installer adds it): the server only leaves a request
  file, and root's runner on the host runs its own copy of `update.sh` with no arguments taken from it. Anything
  running as the server's user can leave that file (bots too, while the sandbox is off on self-hosted servers), so such
  a run goes by the image's label only, tries each stable image once (never again after a rollback until a person runs
  update.sh), keeps the person's own copy of the data and its own two newest ones, and stops the server at most every
  four minutes. Not through the connector:
  that needs enrolling, and its runner takes an image from its request.
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

## The customer-run mode

Decided: the server installer brings MausBot; the connector attaches to that install and the Admin never starts it.

- **Chosen on the server.** `connector/install.sh` picks `customer-run` when `/opt/openmausbot/compose.yaml` exists
  and starts the connector with `MAUSBOT_MODE=customer-run`; the enrolment writes the mode into the connector's state.
  The stricter of the two always wins, and nothing the Admin sends changes it. A connector started in `operated` mode
  refuses to enrol where the owner's MausBot already runs.
- **Enforced on the server, three times over for jobs.** A job outside the list is refused as it arrives
  (`checkCustomerRunJob`), again at the desk every job passes through (`jobDesk`), and the home the connector attached
  to has no code path for it (`AdoptedHome`). Each refusal is a line in the audit log.
- **We cannot replace the connector.** `self-update` from the Admin is refused in this mode: any older connector image
  is still in our registry, and one from before the mode would run as `operated`. Only root on the server replaces
  it (`mausbot-connector job self-update`), and even then not with an older version or one that names none
  (`images.ts neverOlder`, on the image's version label).
- **Updates only move forward.** An `update` to an image older than the one running, or without a version label, is
  refused by the connector after it pulls the image and again by `mausbot-update-runner` on the host, which is the
  check that cannot be bypassed from the connector's container. Going back is the owner's, with `update.sh` by hand.
  `SERVER_VERSION_FLOOR` (and `FLOOR` in the runner; a test holds them equal) is a second floor, to be set to the
  first release with the hardened profile; it is `0.0.0` until such a release exists.
- **`restore` is the owner's**, and a backup the owner made is never removed to make room for ours: each sender keeps
  its own three.
- **Requests never reach the home.** The connector answers the four listed requests itself from the facts it already
  reports (`customer-run-requests.ts`). Everything else is answered 403 and logged.
- **The report is rebuilt, not filtered.** `reducedHeartbeat` and `reducedReply` copy named fields; every string is an
  enumerated code or matches a pattern (a version, an image reference, a machine's own name for itself). A failed job
  sends its code and a fixed sentence; the reason stays in the audit log.
- **Adoption.** `AdoptedHome` finds the Compose project `openmausbot` (service `omb`, Caddy in front, `/data` bound
  to a folder). `start`, `stop` and `restart` start and stop those containers. `backup` and `restore` copy that folder
  to and from Docker volumes on the same server with helpers run from the home's own image.
- **Update: the server's own updater.** The connector never recreates the owner's containers and never writes the
  owner's `.env`. It leaves `id` and `image` in `/var/lib/mausbot/update/request`; a systemd path unit on the host runs
  `mausbot-update-runner`, which checks the image again and runs `/opt/openmausbot/update.sh --image <digest>`; the
  connector reads the exit code. So a connected update and a hand-run update are the same code, with the same copy,
  health check, rollback and journal. Chosen over driving Compose from inside the connector (which would need the
  install folder writable in a container and a Compose binary in the image) and over recreating containers through
  Docker's API (which would drift from the Compose file).
- **Seat count.** The home answers `GET /api/seats` with a number, to an admin session or its own loopback. The
  connector reads it with one fixed command run inside the home's container, together with `/api/health` and the
  version.
- **Pause.** `mausbot-connector pause` writes a file in the connector's state; the running connector reads it before
  every job and request.

### What the Admin must know

Backward compatible: a field is only ever added, and only by a customer-run server.

| Where | Field | Meaning |
|---|---|---|
| `EnrollRequest` (`POST /api/cloud/box/v1/enroll`) | `mode: "customer-run"` | Present only for a customer-run server; absent means `operated`, exactly the request sent before. Store it with the box |
| `Heartbeat.heartbeat` | `mode: "customer-run"`, `paused: boolean`, `seats: number \| null` | Present only for a customer-run server. `host`, `home` and `connector` keep their shape; `host.checks[]` carries `id`, `ok` and `warning` without `fix`; `home.health.box` is `{ box: "on" \| "off", checks: null, failed: [] }` (whether the bots' sandbox is on, never its checks), or null when the server does not say |
| `JobErrorCode` | `refused_by_mode`, `paused`, `update_unavailable`, `update_not_started`, `older_version` | Only from a customer-run server. Its error `message` is a fixed sentence per code |

For a customer-run box the Admin should: send `start` with no arguments; send `update` with
`ghcr.io/milind-soni/openmausbot@sha256:…` (the server image, not the Cloud home image); never an older version than the one running; never send `export-disk`,
`import-disk`, `self-update`, `restore` or a request other than `GET /v1/health`, `/v1/version`, `/v1/seats`, `/v1/update`; send
`schedule.image: null` in the signed config (a Cloud home image there is accepted, any other is ignored with the whole
config); and sign people in by sending them to the server's own address, never by pairing.

## Status against the code

Read at the commit that adds the customer-run mode. "Built" means the code is in this repository; it does not mean a customer can buy it.

### Built

- The connector: enrolment with a one-time code, its own Ed25519 key, pinned Admin keys, one outbound WebSocket, a
  fixed job list, each job signed for one server and refused 15 minutes after signing (`connector/src/protocol.ts`,
  `agent.ts`, `jobs.ts`).
- The customer-run mode described above: the job and request lists, the reduced report with a seat count, the mode in
  the enrolment handshake, pause, and attaching to an installer-made server (`customer-run.ts`,
  `customer-run-requests.ts`, `adopted-home.ts`, `host/mausbot-update-runner.sh`, `server/routes/seats.ts`).
- A server the team's Owner has not accepted answers only `status` and `host-health` (`agent.ts`).
- The audit log on the customer's server, `/var/log/mausbot/audit.jsonl`: one line per job, step, result and Admin
  request, each carrying the hash of the line before it. A job that changes something is refused when it cannot be
  logged (`audit.ts`, `jobs.ts`).
- The owner's policy file, `/etc/mausbot/policy.json`: the job kinds we may run, and a hold on updates (`policy.ts`).
- On an operated server, `update` with a safety copy of the data and a rollback of image and data when the new
  version does not report healthy (`home.ts`).
- The connector's own installer with a preflight, `connector/install.sh`, which the Admin is to serve with its address
  and the connector's image digest filled in.
- The offline licence check for paid features (`enterprise/server/license.ts`).

### Different from this document

- **Updates on a connected server need `update.sh` in place.** The connector hands an update to
  `/opt/openmausbot/update.sh`. The installer places that file only once it and the update command have merged (see
  In review), so until then the `update` job is refused with `update_unavailable` and nothing changes.
- **Backups stay on the server.** `backup` copies the data to a Docker volume on the same server. A bucket the
  customer configures is phase 2.
- **Pausing is a command.** `mausbot-connector pause`; a switch in Settings is planned. The heartbeat keeps going
  while paused.
- **Emailed sign-in codes pass through us unless the customer sets a mail server.** Pairing codes never do. So
  principle 2 holds for sign-in by pairing code always, and by emailed code only with `OMB_SIGNIN_SMTP_URL`.
- **The home's own traffic is unchanged by connecting.** A report a person sends by tagging `@devs` carries their
  message, the bot's name and recent log lines to us, and its status is asked hourly while it is open; browser
  analytics are on until a person turns them off. Principle 6 is about the connector; these are the docs page's
  "What your server itself still sends".
- **Connector images are not signed.** Only the owner replaces the connector on a customer-run server, and never
  with an older one, but what they install is trusted by its digest and our registry alone. Planned: a signing key's
  public half built into the connector, the signature of the new image's digest checked in `images.ts` before it
  runs (the `ImageCheck` hook is where it plugs in), and the same check in `connector/install.sh`.
- **The hardened floor is not set.** The mechanism is built and tested; the number waits for the first release with
  the hardened profile.
- **A connector is updated by hand.** Since we cannot send `self-update`, a fix to the connector reaches a
  customer-run server only when its owner runs it. The Admin should show which servers run an old connector.
- **The WebSocket close reason is empty** from a customer-run server; the code says why.
- **Only one layout is adopted.** Docker Compose from the server installer, the published image, data in a folder. A
  source build or an npm install cannot be connected.
- **The seat count is a lower bound for a domain entry.** `@example.com` on the sign-in list counts each person from
  it once they have signed in.
- **The update window.** The connector receives and keeps the window the Admin signs, and runs an update when the
  Admin sends the job. Choosing the window is the Admin's.
- **Not run on a real server yet.** The customer-run path is covered by unit tests and a run against a local Docker
  with a stand-in server; the connector's end-to-end run (`connector/e2e/run.sh`) still covers only the operated mode.

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
