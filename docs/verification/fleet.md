# Fleet: many workspaces on one server

## Sub-features

- `fleet init`: template unit, loopback fence and its unit, workspace folders,
  registry, and the Caddy import, once per server.
- `fleet create`: a workspace as its own OS user with private data, its
  sign-in list, brand, provider key and cap seeded, fenced ports, a service
  started now and at boot, a site block, and a health wait.
- `fleet users`, `suspend`, `resume`, `delete` (with `--yes`, optionally
  `--keep-data`), `upgrade` (rolling restarts), `list`.
- Plans, never shell strings: fixed argument lists, or an inspection plan for
  an operator; `--dry-run` always prints. Tenant file steps must run through
  the executor, which drops privileges; they are not root-shell instructions.

## User path

An operator runs the commands on the server. A client's admin gets a link to
`https://<name>.<domain>` and signs in with an emailed code.

## Driving it

The planners and the command are proven offline:

```sh
pnpm exec vitest run server/fleet.test.ts server/fleet-cli.test.ts server/fleet-cli-filesystem.test.ts server/fleet-agent.test.ts server/cli.test.ts
```

These pin the rendered template unit (per-slug user, private `/tmp`, no new
privileges, read-only system, the `${OMB_PORT}`-style expansion), the
nftables fence rules, the running and suspended Caddy site blocks, the
environment file, the seeded config, the argument lists and their order for
every operation, the registry kept in step, the health wait placement, the
safe inspection rendering of a plan, and the CLI stopping at the first
failed step without repeating the tool's output beyond its last lines.

The agent suite launches the real HTTP agent on a disposable Unix socket and
drives its client against a recording machine: no real accounts, systemd,
nftables or Caddy. Concurrent creates must preserve both registry entries and
allocate distinct ports. A filesystem exception must retain the failed
reservation and let the next queued mutation complete. The filesystem suite
runs real bounded Node children against disposable homes, mocking only account
lookup. It checks atomic replacement, private modes, symbolic and hard links,
linked ancestors, special files and oversized reads. It does **not** exercise
an actual root-to-tenant privilege transition.

## Recovery and boundaries

- Mutations through one fleet-agent process are serialized from planning
  through completion. Direct CLI invocations are **not** coordinated with the
  agent or other CLI invocations. Do not run them concurrently; stop agent
  mutations before CLI maintenance. No cross-process lock is claimed.
- Creation atomically reserves its name and ports before `useradd`, records
  account creation, then marks the workspace running after health and Caddy
  steps succeed. Privileged writes sync file contents and the parent directory
  before the next external step. A handled failure leaves `error`; an abrupt
  interruption can leave `provisioning`. Both require operator recovery and
  refuse create, resume, suspend, users and delete shortcuts. They do **not**
  prove the service stopped: inspect the account, unit, home, environment,
  fence and site before manually reconciling a partial run.
- `delete --keep-data` retains the nologin Unix account, home, name, ports and
  fence with status `retained`. Keeping the account prevents its numeric UID
  being recycled into a different customer's ownership. The site, instance
  environment and service enablement are removed. Retained homes cannot be
  silently reused; full deletion remains explicit and destructive.
- Creation also refuses residual home/environment/site/unit-limit paths,
  including broken symlinks. `init --yes` preserves records, port allocation,
  operator identity unless replaced explicitly, and the existing account
  fences; it reapplies the fence even when its oneshot unit is already active.
- Tenant config reads, writes and directory creation run only after dropping
  supplementary groups, gid and uid in a bounded child with a minimal
  environment. Descriptor checks reject shared/special files, reads are
  bounded, and writes use same-directory atomic replacement. Visible links
  are refused. This is a root-privilege boundary, not a guarantee against
  same-tenant concurrent renames or tenant edits. Usage summaries use that same
  unprivileged helper: only the current UTC month's regular, single-link file
  is read, at most 4 MiB, with a five-second child deadline. Parsing and totals
  computation stay in the child; root receives only the small aggregate, not
  ledger contents. Missing files mean zero usage. Unsafe, oversized or failed
  reads return `unavailable: true` and null totals, never a partial/false-zero
  report. Tenant-controlled ledgers remain self-reported, not trusted billing.
- Portal-seeded environments accept an HTTPS origin only; the provider URL
  must be that portal's exact per-workspace gateway, and the portal hostname
  is reserved. The seed should carry a scoped gateway credential, never the
  portal's master provider key. Root-owned environment files are not a claim
  that a tenant process cannot inspect its own environment.

Offline tests do not qualify Linux service isolation, root transitions,
power-loss recovery or automatic cleanup after interruption. The disposable
Linux recipe below remains required before a production deployment.

Dry-run on any machine, to read what a real run would do:

```sh
openmausbot fleet init --domain example.test --dry-run
openmausbot fleet create acme --admin owner@acme.test --dry-run
```

## A real server

Not proven in this repository's CI: it needs root, systemd, nftables and
Caddy. The recipe for a disposable VPS (the same shape as the Hetzner launch
record):

1. Fresh Ubuntu 24.04 or newer, Caddy from apt, `npm install -g openmausbot`,
   Claude Code installed once as root, a wildcard DNS record at the server.
2. `openmausbot fleet init --domain <domain>`; check `systemctl status
   openmausbot-fence` and `nft list table inet openmausbot`.
3. `openmausbot fleet create alpha --admin you@example.test --cap 1` and the
   same for `beta`; both `https://alpha.<domain>` and `https://beta.<domain>`
   must show the pair page with a certificate.
4. Isolation: as `omb-alpha` (`runuser -u omb-alpha -- curl -s
   http://127.0.0.1:<beta port>/api/health`) the connection must be refused;
   as root it must answer. `ls /var/lib/openmausbot/beta` as `omb-alpha` must
   be denied.
5. `fleet users alpha add other@example.test --chat-only`, sign in as that
   address, confirm chat-only scope.
6. `fleet suspend beta` shows the 503 page; `fleet resume beta` restores it.
7. `fleet upgrade` after a release restarts both in turn; `fleet delete beta
   --yes` removes the account and site.

Record the run as a dated file next to this one.
