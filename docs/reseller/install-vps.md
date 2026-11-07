# Install a reseller server on a VPS

`deploy/vps/install.sh` takes a blank Debian or Ubuntu server to a running
reseller fleet: Node 24, Caddy, OpenMausBot, the fleet itself, your default
brand and the first customer workspace. It is plain POSIX `sh`, it prints every
command before it runs it, and `--dry-run` prints them without running any.

It has not been run on a real VPS yet. It has been run once on Ubuntu 24.04 with
systemd inside a container, see
[the container record](../verification/white-label-reseller-container-2026-11-07.md),
and the offline checks are listed in
[the verification record](../verification/white-label-reseller.md#vps-install).

## Before you start

- A server with Ubuntu 24.04 or newer, or Debian 12 or newer, and root access.
  Two CPUs and 4 GB of memory are enough for a few workspaces.
- Ports 80 and 443 free and reachable. Caddy needs both to get certificates.
- A domain you control. Create the DNS record before the install reaches its
  DNS check:
  - a wildcard `A` record, `*.example.com`, pointing at the server, or
  - an `A` record for the exact name when you pass `--host`.
- Your reseller licence key in a file readable by root only. Workspaces need the
  `whitelabel` entitlement to show your logo and name, and `fleet billing`
  needs `admin` and `billing`. Without a key everything is created and a
  warning says the brand will not apply.

## Run it

Copy the script to the server, read it, and look at what it would do:

```sh
scp deploy/vps/install.sh root@SERVER_IP:
ssh root@SERVER_IP
sh install.sh --dry-run --domain example.com --admin owner@acme.test \
  --reseller-name "Acme Cloud" --license-key-file /root/omb-license.key \
  --version 0.1.145
```

Then run it for real:

```sh
sh install.sh --domain example.com --admin owner@acme.test \
  --reseller-name "Acme Cloud" --license-key-file /root/omb-license.key \
  --version 0.1.145 --logo /root/acme-logo.png --accent '#C2510A' --tagline "Teams that ship" \
  --support-url https://help.acme.test --engine claude
```

Pin the version with `--version` and keep it in your own notes. Without it the
script installs `latest`, so rebuilding the server later can bring a different
release than the one you tested, and every workspace on it. Change the pinned
version on purpose, then run `openmausbot fleet upgrade`.

To install a build you made yourself instead of a registry release, for example
a release candidate, pack it and pass the file:

```sh
pnpm build:server && pnpm exec vite build && node scripts/build-npm-package.mjs
(cd release/npm && npm pack)
scp release/npm/openmausbot-*.tgz root@SERVER_IP:
sh install.sh --domain example.com --admin owner@acme.test \
  --reseller-name "Acme Cloud" --package /root/openmausbot-0.1.146.tgz
```

Compare the sha256 the script prints with `sha256sum` of the file you built.

A bad option is refused with exit status 2 before anything changes.

## Options

| Option | Meaning |
|---|---|
| `--domain DOMAIN` | Required. The domain whose subdomains the workspaces live at. |
| `--admin EMAIL` | Required, repeatable. Admins of the first workspace. The first one is also the contact address Caddy gives the certificate authority. |
| `--reseller-name NAME` | Required. Your brand name, up to 40 characters. It is the default brand name of every workspace. |
| `--workspace NAME` | First workspace name, default `main`. |
| `--host HOST` | Serve the first workspace at `HOST` instead of `NAME.DOMAIN`. See [workspaces](workspaces.md). |
| `--cap USD` | Monthly spend cap for the first workspace. |
| `--anthropic-key-file FILE` | Seed the first workspace with an Anthropic API key read from `FILE`. |
| `--logo FILE or URL` | Default logo: a PNG, JPEG, WebP, GIF or SVG file, or an `https://` address that is stored as given. See [branding](branding.md). |
| `--accent`, `--tagline`, `--support-url` | Default accent colour, tagline and help link. |
| `--license-key-file FILE` | Licence key. `OMB_LICENSE_KEY` in the environment works too. |
| `--operator USER` | Existing Unix user whose workspace manages the fleet from Settings, Installations. |
| `--currency CODE` | Billing currency with two decimals, default `USD`. See [billing](billing.md). |
| `--version VERSION` | The `openmausbot` version to install, for example `0.1.145`. Always pass one: the default, `latest`, is whatever the vendor published most recently, so two installs a week apart can differ. |
| `--package FILE or URL` | Install this tarball from `npm pack` (a `.tgz` file, or an `https://` address) in place of `openmausbot@VERSION`. Not combinable with `--version`. A file is pinned by its content: the script prints its sha256 in the plan and the summary and gives no `UNPINNED` warning. An address is not hashed and is warned about. |
| `--engine claude` | Also install the Claude Code CLI. |
| `--dry-run` | Print every step and change nothing. |

## What it does

The phases run in this order, and each prints a `== name ==` heading.

1. `check_prereqs`: root, a supported release, `apt-get`, and ports 80 and 443.
2. `install_packages`: `nftables`, `curl`, `ca-certificates` and `gnupg`.
3. `install_node`: Node 24 from NodeSource, as in
   [Deploy on a VPS](../deploy-vps.md), unless Node 24 or newer is already there.
4. `install_caddy`: Caddy from its official apt repository, then a Caddyfile
   that starts with the global block `{ email ... }`. The fleet appends its
   `import` line after it.
5. `install_openmausbot`: `npm install -g openmausbot@VERSION`, or with
   `--package` the same command on that tarball. The install is
   global because `fleet init` refuses to point services at an `npx` cache.
6. `install_engine`: the Claude Code CLI, only with `--engine claude`.
7. `check_dns`: the first workspace address must resolve to this server. This
   happens before the first Caddy reload, so a missing record cannot burn
   certificate attempts. It fails with a message; fix the record and run again.
8. `fleet_init`: `openmausbot fleet init --domain ... --reseller-name ...`.
9. `fleet_brand`: `openmausbot fleet brand --default ...`, only when a brand
   option was given.
10. `fleet_create`: `openmausbot fleet create NAME --admin ...`.
11. `summary`: the address, the DNS records, how to sign in, the engine,
    `fleet billing` and any warnings.

A secret never appears on a command line or in the output: key files are passed
by path, and the licence key may come from `OMB_LICENSE_KEY`.

An existing `/etc/caddy/Caddyfile` is replaced only when, comments and blank
lines aside, it is exactly the stock file from the Caddy package (`:80` serving
`/usr/share/caddy`), or holds nothing but this script's own global block. The
stock file is first copied to `Caddyfile.pre-openmausbot.<UTC time>`, a new copy
on every run that replaces it, so an older backup is never overwritten. A
Caddyfile that already holds the line `import /etc/caddy/omb.d/*.caddy` is left
alone. Any other Caddyfile stops the install with the two lines to add by hand.

## Supply chain and trust

The script runs as root and fetches the following without a pinned checksum.
Each is trusted on first use over TLS, as the vendors' own instructions ask.
This is a known residual risk:

- The NodeSource setup script, `https://deb.nodesource.com/setup_24.x`, which
  the script then runs with `bash` as root. It adds NodeSource's apt repository
  and signing key, and apt checks the `nodejs` package against that key.
  Skipped when Node 24 or newer is already installed.
- The Caddy apt signing key, `https://dl.cloudsmith.io/public/caddy/stable/gpg.key`,
  and the repository list next to it. apt checks the `caddy` package against
  that key. Skipped when `caddy` is already installed.
- npm packages: `openmausbot@VERSION` (or the `--package` tarball, whose own
  dependencies still come from the registry) and every dependency it pulls in, and,
  with `--engine claude`, `@anthropic-ai/claude-code` at its latest release.
  `npm install -g` runs as root, and so do the install scripts of those
  packages. npm checks each download against the integrity hash the registry
  publishes, which catches a damaged download, not a bad release. Without
  `--version` the script prints an `UNPINNED` warning before this step and in
  the summary.

To narrow this, verify them yourself before the run: install Node 24 and Caddy
your own way first (the script then skips both), compare the Caddy key's
fingerprint with the one Caddy publishes, read the NodeSource script, and pin
`--version` to a release you have checked (`npm view openmausbot version` names
the current one, `npm view openmausbot@X.Y.Z dist.integrity` its hash). The
packages the script installs from your distribution (`nftables`, `curl`,
`ca-certificates`, `gnupg`) come from its signed archive.

## Running it again

The script resumes where an earlier run stopped:

- With `/etc/openmausbot/fleet.json` present it runs `fleet init --yes`, which
  keeps workspaces, ports, operator and reseller. A registry for a different
  domain is refused.
- When `fleet list` already shows the workspace, it is not created again. A
  workspace in state `error`, `provisioning` or `retained` stops the run:
  recover it as the [fleet record](../verification/fleet.md) describes.
- Installed Node and Caddy are left alone, and `npm install -g` moves
  `openmausbot` to the `--version` you pass again (to `latest` when you pass none). Running workspaces keep their old release until
  you run `openmausbot fleet upgrade`.

## After the install

- The first admin opens the address and signs in with an emailed code.
- Engines: sign Claude in from Settings, Engines, in the workspace, or seed an
  Anthropic key with `--anthropic-key-file`.
- Sign-in mail: with no `reseller.smtp` in `/etc/openmausbot/fleet.json` (see [branding](branding.md)), the
  code is mailed through the vendor control plane. The summary then prints
  `openmausbot pair --port PORT --public-url URL` as a way to hand a first admin
  a code yourself. A workspace that does not trust commands on its own computer
  refuses that; the mail relay is the way around it.
- Usage by workspace and user: `openmausbot fleet billing --license-key-file FILE`.
- More customers: `openmausbot fleet create NAME --admin EMAIL [--host HOST]`.

## What each workspace can read

Each workspace runs as its own Unix user with its environment file,
`/etc/openmausbot/instances/<name>.env`, loaded into its service. The file is
root-only on disk, but that workspace's own processes, a bot with a shell
included, can read the environment back from `/proc`. Two values in it are
yours, not the customer's:

- `OMB_LICENSE_KEY`, your reseller licence key, when you pass one. Every
  workspace created with it holds the same key: assume each customer can read
  it.
- `OMB_SIGNIN_SMTP_URL`, the mail relay address from `reseller.smtp`. When it
  carries a user name and password, any workspace can send mail as you with
  them, and `fleet create` and `fleet brand` print a warning. Use a relay on
  the server's loopback that needs no login instead, as
  [the branding guide](branding.md#sign-in-mail) describes.

## Limits

- Debian and Ubuntu only. The DNS check reads IPv4 answers only, and behind NAT
  (no public address on the server) it warns instead of failing.
- The installer sets no mail relay and no rates. Set the relay as
  [the branding guide](branding.md) describes, and the rates with `fleet rates`.
- One server is one reseller on one domain.
