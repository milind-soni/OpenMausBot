# Fleet: many workspaces on one server

## Sub-features

- `fleet init`: template unit, loopback fence and its unit, workspace folders,
  registry, and the Caddy import, once per server.
- `fleet create`: a workspace as its own OS user with private data, its
  sign-in list, brand, provider key and cap seeded, fenced ports, a service
  started now and at boot, a site block, and a health wait.
- `fleet users`, `suspend`, `resume`, `delete` (with `--yes`, optionally
  `--keep-data`), `upgrade` (rolling restarts), `list`.
- Plans, never shell strings: fixed argument lists as root, or printed for an
  operator; `--dry-run` always prints.

## User path

An operator runs the commands on the server. A client's admin gets a link to
`https://<name>.<domain>` and signs in with an emailed code.

## Driving it

The planners and the command are proven offline:

```sh
pnpm exec vitest run server/fleet.test.ts server/fleet-cli.test.ts server/cli.test.ts
```

These pin the rendered template unit (per-slug user, private `/tmp`, no new
privileges, read-only system, the `${OMB_PORT}`-style expansion), the
nftables fence rules, the running and suspended Caddy site blocks, the
environment file, the seeded config, the argument lists and their order for
every operation, the registry kept in step, the health wait placement, the
exact root-shell rendering of a plan, and the CLI stopping at the first
failed step without repeating the tool's output beyond its last lines.

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
