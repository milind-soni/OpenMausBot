# White-label reseller on a fleet

One VPS fleet is one reseller: each customer gets a private workspace with the
reseller's logo, name and web address, and the reseller pays the vendor by
workspace and by user.

## Tenancy and web address

Proven offline, with no live app, DNS or certificate involved:

```sh
pnpm exec vitest run server/fleet-tenancy.test.ts server/fleet-host.test.ts server/fleet-cli-host.test.ts server/fleet-agent-host.test.ts
```

- `fleet-tenancy.test.ts` is the address table: it accepts `chat.acme-corp.com`,
  lowercases `Chat.Acme.COM` and accepts an explicit `<name>.<domain>`; it
  refuses the apex, another name's subdomain, an address held by a running,
  suspended, retained, errored or provisioning workspace, the portal's address,
  `localhost`, an IP literal, a wildcard, a port, a path, a newline and brace
  break-out, a 254-character name, a trailing dot, and any custom address while
  `portalUrl` is set.
- `fleet-host.test.ts` plans a create: the Caddy block, `OMB_PUBLIC_URL` and all
  three registry checkpoints carry the custom address, the DNS note appears only
  for a custom address, the default plan is unchanged, a suspended workspace
  serves the 503 page on its own address, and delete removes the site file.
- `fleet-cli-host.test.ts` runs `fleet create --host` on a recording machine:
  the dry run prints `chat.acme.test {`, and a taken or malformed address exits
  2 with no command run and no file written.
- `fleet-agent-host.test.ts` drives the agent over a temporary Unix socket: a
  `host` in the request body is ignored, two concurrent creates of one name
  produce exactly one workspace, and a name whose default address a
  custom-host entry holds is refused.

Not proven here: that a real name resolves to the server, that Caddy obtains a
certificate for it, and that a browser reaches the workspace. Run the real
server recipe in [fleet.md](fleet.md) with `--host` set to a name pointed at the
disposable VPS and record it as "not yet run" until then.

## Branding

How it works is in [the branding guide](../reseller/branding.md). Proven offline,
on recording machines and the `control-omb` fixture, never on a live app:

```sh
pnpm exec vitest run server/brand.test.ts server/fleet-brand.test.ts server/fleet-brand-image.test.ts server/fleet-brand-cli.test.ts server/fleet-agent-brand.test.ts server/sign-in-mail.test.ts
pnpm exec vitest run --no-file-parallelism server/fleet-brand-api.test.ts
```

- `fleet-brand.test.ts`: the schema has exactly the fields the CLI can set or
  clear, with the messages for a bad accent, an oversized logo and an `http`
  support link; the precedence table (reseller name, default, override, clear);
  a create without a reseller plans the same steps as before; a create with one
  writes the three root-owned files in mode 0644 before the environment file and
  adds `OMB_BRAND_FILE`; the SMTP address is read at plan time and kept out of
  the registry and the printed plan; the merged file loads as `source: "file"`
  with `whitelabel` and as the default plus a notice without it.
- `fleet-brand-image.test.ts`: every format by its bytes, ICO for the favicon
  only, HTML named `.png` refused, the size limit to the byte, hostile SVG
  refused.
- `fleet-brand-cli.test.ts`: `brand --default` writes every running or
  suspended workspace and skips the others with a note, a second run plans the
  same steps, an invalid patch or one bad override changes nothing, and a dry
  run leaves the image bytes out.
- `fleet-agent-brand.test.ts`: over a temporary Unix socket, data URIs are
  accepted, a path, an address, a hostile image or a bad accent is a 400 with
  nothing written, the audit log holds field names and no image, and
  `GET /workspaces` has no logos.
- `fleet-brand-api.test.ts`: a fixture whose stand-in layer grants
  `whitelabel` serves the merged file's name and logo from `GET /api/brand`; an
  edit by `fleet brand` shows on the next read with no restart; a fixture
  without the entitlement serves the default and a notice.

Not proven here: that a real root-owned file is unwritable by the workspace's
user, that systemd passes `OMB_BRAND_FILE` and the SMTP variables from the
environment file, and that a real mail relay delivers a code under the
reseller's name.

## Billing by workspace and user

How it works is in [the billing guide](../reseller/billing.md). Proven offline, on
disposable ledgers and the `control-omb` fixture, never on a live app or ledger:

```sh
pnpm exec vitest run server/fleet-metering.test.ts server/fleet-billing.test.ts server/fleet-meter-filesystem.test.ts server/fleet-agent-billing.test.ts server/fleet-billing-route.test.ts
pnpm exec vitest run --no-file-parallelism server/fleet-billing.e2e.test.ts
```

- `fleet-metering.test.ts`: the table of who is a person (a signed-in user, a
  device label, the owner with and without an email, a routine, a bot, a helper);
  `Ada@X.test` and `ada@x.test` are one person and `ada+work@x.test` is another;
  the UTC month edges to the millisecond; torn, undated, oversize, negative and
  non-numeric rows; the 1000-person limit; the people equal the `user:` groups
  of the usage report on the same rows; `parsePeopleResult` refuses 1001 people,
  a 255-character id, a non-finite number and any extra field; the event log
  keeps the newest 100.
- `fleet-billing.test.ts`: `--month` refuses `2026-13`, a malformed month and a
  future month; the billable table (running, suspended, retained, error,
  provisioning, created after the month, suspended or resumed mid-month, no
  events); integer prices with a field-by-field override, a zero-user
  workspace and a negative margin; totals are the sum of the printed lines; an
  unavailable ledger prints blanks, marks the report incomplete, leaves the
  totals blank and exits 1 while still printing; CSV neutralises `=cmd` in a
  text cell but prints `-5` as a number; `fleet billing` without `admin` and
  `billing` exits 2 naming the missing one; `fleet rates` writes only the
  registry; the closing snapshots (this month and the previous one, one file per
  workspace life and month) are written before `userdel`, a failing write stops
  the delete, a damaged or foreign-currency snapshot is skipped and marks the
  report incomplete without blocking a delete, two deletes in one month and a
  delete-recreate-delete each keep their own files, and billing last month after
  a delete lists the workspace; a legacy workspace without events keeps its
  earlier months billable after its first suspend; when the ledger cannot be
  read and the workspace was not running, `billable` is unknown (`?`, empty CSV
  cell, blank money); `fleet rates --currency` is refused over snapshots in
  another currency.
- `fleet-meter-filesystem.test.ts` (skipped on Windows and as root): the real
  unprivileged child, with only `getent` faked, counts a ledger exactly as the
  in-process twin does, across 1 MiB chunk boundaries and an overlong line;
  a missing file counts nobody; a symlink, hard link, directory, FIFO, linked
  ancestor, 256 MiB file or linked sign-in file fails closed without echoing a
  byte; 1001 people fail closed; the launch carries no message text.
- `fleet-agent-billing.test.ts`: over a temporary Unix socket `GET /billing`
  gives counts by default and people only with `detail=true`; parallel requests
  share one build and a repeat within 60 seconds is answered from memory until a
  change goes through the agent; `?maxUsers=` is passed on and bounded; one workspace's
  failure leaves the others; the audit log holds no address; deleting through
  the agent writes the snapshot first and a failing snapshot stops it.
- `fleet-billing-route.test.ts`: `GET /api/fleet/billing` is admin scope, 403
  without `admin`, 403 without `billing`, forwards only `month` and `detail`,
  and is read-only.
- `fleet-billing.e2e.test.ts`: two fixtures with a stand-in layer book real turns
  (the owner and two paired devices in one, the owner in the other); their
  ledgers are copied into a temporary fleet root and read by the real
  privilege-dropped helper through `defaultFleetDeps()` and the real enterprise
  loader. The workspace with two paired devices has 2 active users whose keys
  match `GET /api/usage?groupBy=user`, the other is charged and has none, the
  lines equal the rate card, the totals equal their sum, and the CSV has one line
  per workspace.

Not proven here: that the helper drops root to a real workspace account, that a
real workspace cannot write the root-owned snapshot directory, and that a ledger
of hundreds of thousands of rows on a loaded server finishes inside the
20-second deadline. Record those as "not yet run" until a disposable Linux
server has run `openmausbot fleet billing` against live workspaces.

## VPS install

How it works is in [the install guide](../reseller/install-vps.md). Proven offline,
with no apt, Node, Caddy, DNS or network involved:

```sh
pnpm exec vitest run server/deploy-vps-install.test.ts server/cli.test.ts
```

- Syntax: `sh -n`, `shellcheck -s sh` with no finding (skipped when shellcheck
  is not installed), mode 0755, and no `eval`, `sh -c` or pipe into a shell.
- Dry run: the eleven phases in order; the exact `fleet init`, `fleet brand`
  and `fleet create` lines; the licence key, the Anthropic key and
  `OMB_LICENSE_KEY` never in the output; no change under HOME, the working
  directory or the temp directory; exit 0 as a plain user and on macOS, where
  the unsupported system is a warning.
- Package: `--package FILE` gives `npm install -g` the tarball's absolute path and prints
  its sha256 in the plan and the summary with no `UNPINNED` warning; `--package URL` is
  passed unchanged and warned about; the fleet lines are unchanged.
- Contract: every `openmausbot fleet` line of a dry run (full, minimal, logo
  URL, re-run with `--yes`, a name holding a quote and a space) is parsed by the
  real `parseArgs` in `server/cli.ts` and must not return an error.
- Refusals exit 2 with a message and print nothing else: missing `--domain`,
  `--admin` or `--reseller-name`; an invalid domain, admin, host, workspace,
  accent, support link, cap, currency, version or engine; a `--package` that is not a
  readable `.tgz` file or an `https://` address, or comes with `--version`; an unknown flag; a flag
  without a value; a missing `--logo` file; an unreadable or empty key file.
- A non-dry run against recording stubs for `apt-get`, `curl`, `gpg`, `bash`,
  `npm`, `node`, `openmausbot`, `systemctl`, `id`, `nft`, `ss`, `getent` and `ip`,
  placed with `OMB_VPS_PREFIX`: the calls happen in the documented order; the
  name is resolved before the first `fleet` command; the Caddyfile starts with
  the global email block and the stub's `import` line follows it; the stock
  Caddyfile is kept as a backup and a hand-written one is refused; no secret
  reaches any command; no temp directory is left. A second run uses
  `fleet init --yes`, skips `fleet create` and the Node and Caddy installs, and
  leaves the Caddyfile byte-identical.
- Stops with exit 1 and no `fleet` call: not root, unsupported or old release,
  ports 80 and 443 taken, a name that does not resolve or resolves to another
  address, another domain's registry, a workspace in state `error`, a missing
  `--operator` user.

The stubs return what the real tools are documented to return. They prove the
order and the arguments the script gives its tools, not what those tools do.

### Disposable Linux VPS recipe

Not yet run on a VPS. A container run of the installer on Ubuntu 24.04 with
systemd, and of most of the steps below, is in
[the container record](white-label-reseller-container-2026-11-07.md); it lists
what a container cannot prove. Use a fresh Ubuntu 24.04 server that you delete afterwards, with a
firewall that opens 22 from your address only until the script runs, then 80 and
443. Do not use a server that holds anything else.

1. Create a wildcard `A` record `*.test.example.com` and an `A` record
   `app.customer.example.org` for a second name, both pointing at the server.
   Put a licence key with `whitelabel`, `admin` and `billing` in
   `/root/omb-license.key` (mode 0600) and a PNG at `/root/logo.png`.
2. Copy `deploy/vps/install.sh` to `/root`. Run it with `--dry-run` and the real
   options; read the commands and compare them with the guide.
3. Before the wildcard record exists, run it for real: it must stop at
   `check_dns` with exit 1, and `systemctl status caddy` must show no reload and
   `ls /etc/openmausbot` must not exist yet.
4. With the record in place, occupy port 80 (`python3 -m http.server 80`) and run
   again: it must stop at `check_prereqs`. Stop the listener.
5. Run it for real with `--domain test.example.com --admin you@example.org
   --reseller-name "Disposable Co" --logo /root/logo.png --accent '#C2510A'
   --license-key-file /root/omb-license.key --engine claude`.
6. Check: `head -3 /etc/caddy/Caddyfile` shows the global block and the file ends
   with the `import` line; `systemctl status caddy openmausbot-fence
   openmausbot@main`; `nft list table inet openmausbot`; `openmausbot fleet list`;
   `curl -sI https://main.test.example.com` answers with a certificate whose
   issuer is the real authority; the page shows the logo and name, not
   OpenMausBot; `/etc/openmausbot/brands/_default.json` exists in mode 0644.
7. Sign in as the admin with the emailed code. Record whether the mail arrived and
   from which sender. If it did not, run the `openmausbot pair --port ...` line
   from the summary and record whether the workspace accepted it.
8. Run the exact same command again: it must run `fleet init --yes`, not create
   `main` again, not reinstall Node or Caddy, and leave `sha256sum
   /etc/caddy/Caddyfile` unchanged. Then `fleet create second --admin
   you@example.org --host app.customer.example.org` and open that address.
9. `openmausbot fleet billing --license-key-file /root/omb-license.key` prints a
   report for the month.
10. Reboot. Caddy, the fence and every workspace must come back without help.
11. Delete the server and both DNS records. Record the run as a dated file next
    to this one, with the Node, Caddy and openmausbot versions.

Record the result as "not yet run" until then.

## Fixture recipe

The owner's two acceptance criteria, in one run on one laptop: a fresh install
brings up private workspaces with the reseller's branding, and a test reseller
account shows billable usage per workspace and per user. Nothing touches a live
app, ledger, DNS name or licence.

```sh
pnpm exec vitest run --no-file-parallelism server/white-label-reseller.e2e.test.ts
pnpm exec vitest run server/white-label-reseller.contract.test.ts
node --experimental-strip-types scripts/verify-white-label-reseller.ts [--hold]
```

Run the script directly, not through `pnpm`, so Ctrl-C reaches it. It prints one
JSON document and removes everything it created. With `--hold` it stays attached
after printing, so you can read the ledgers and the fleet root it names, until
Ctrl-C stops its three fixtures and removes only its own temporary folders (see
[Cleanup](README.md#cleanup)). Keep that JSON, the commands above, and the three
server log paths it prints.

The flow (`server/testing/reseller-fixture.ts`, `server/testing/reseller-flow.ts`):

1. A temporary fleet root. The real `parseArgs` of `server/cli.ts` reads each
   `openmausbot fleet` line and `runFleetCommand` runs it over the recording
   machine; every file it writes also lands under the root.
   - `fleet init --domain reseller.test --reseller-name "Acme AI" --currency USD`
   - `fleet brand --default --logo FILE --accent '#C2510A' --tagline ... --support-url ...`
     with a real PNG file
   - `fleet create alpha --admin ... --host ai.alpha-corp.test` (its own address)
   - `fleet create beta --admin ...` (the default address)
   - `fleet rates` with wholesale 5.00 per workspace and 2.00 per user, retail
     20.00 and 9.00
2. Three isolated fake-engine servers: alpha and beta, whose stand-in layer
   grants `whitelabel`, `admin` and `billing`, and a third with no layer.
3. The merged brand file the fleet wrote is placed in each server's data
   directory, as `OMB_BRAND_FILE` would point at it on a real server.
4. Alpha books three real turns (the owner and two paired devices labelled
   "Ada's phone" and "Bo's tablet"); beta books one (its owner).
5. Each server's own `GET /api/usage?groupBy=user` is read as the oracle, and
   each month file is copied into that workspace's data directory in the fleet
   root.
6. `fleet billing --month MONTH --csv --detail --license-key-file FILE` runs
   through `defaultFleetDeps()`: the real helper that reads the ledger as a
   child process, and the real enterprise loader. Only account lookup is
   faked, as in `fleet-billing.e2e.test.ts`. The JSON report comes from the same
   builder.
7. `fleet delete beta --yes`, then billing again.

What each assertion proves:

| Assertion | Proves |
|---|---|
| `GET /api/brand` on alpha returns `source: "file"` with the name "Acme AI", the PNG's data URI, the accent, tagline and support link | The three files `fleet brand` wrote merge into one the workspace loads, and the logo that went in is the logo that comes out. |
| The workspace without the entitlement returns `source: "default"`, "OpenMausBot" and a notice naming `whitelabel` | The brand only applies on a licensed server, and says why when it does not. |
| Registry host `ai.alpha-corp.test` for alpha and `beta.reseller.test` for beta; alpha's Caddy site and `OMB_PUBLIC_URL` carry the custom host and not `alpha.reseller.test` | `--host` replaces the default address everywhere it is served. |
| Alpha has 2 active users, a turn count equal to the oracle's, and its users equal the oracle's `user:` groups (cost and attributed turns too) | The helper counts the same people the workspace reports about itself, from the same rows. |
| The owner turn creates no user; beta is billable with 0 users | A person is a signed-in or paired asker, and a running workspace is billed with none. |
| Wholesale 500 + 200 per user, retail 2000 + 900 per user, margin their difference, in minor units | Prices come from the rate card in integers. |
| Totals (1400, 5800, 4400) equal the sum of the lines | Nothing is counted twice or dropped. |
| The CSV has workspace, user and total rows, a fixed header, no text cell starting with `=`, `+`, `-`, `@`, tab or return | The file can be opened in a spreadsheet safely. |
| `complete: true` and exit code 0 | No workspace was unavailable. |
| After the delete: snapshots `closing/beta@CREATED@YYYY-MM.json` exist for this month and the one before, `beta.json` and `beta.override.json` are gone, beta is out of the registry, and a later billing still lists beta with the same totals | A deleted workspace is still billed for the month it used. |

The contract test (`server/white-label-reseller.contract.test.ts`) ties the
installer to the CLI: the `openmausbot fleet` lines of `install.sh --dry-run`
are parsed by `parseArgs` and run unchanged over the recording machine. They
produce the registry (domain, reseller, workspace and its host), `_default.json`
and the workspace's merged file in mode 0644, the Caddy site, and
`OMB_PUBLIC_URL` and `OMB_BRAND_FILE` in the environment file. A run with no
`--host` serves `main.reseller.test`. A re-run with `fleet.json` present uses
`fleet init --yes`, leaves the workspace byte-identical, and a second `fleet
create` of the same name exits 2.

## Not proven here

Everything below needs a disposable Linux VPS and is "not yet run". The
[recipe above](#disposable-linux-vps-recipe) lists the steps.

- Dropping from root to the workspace's Unix user: the offline runs execute the
  helper as the current user with only account lookup faked.
- `useradd`, `userdel` and the workspace's home directory and ownership.
- The systemd unit and its environment file delivering `OMB_BRAND_FILE`,
  `OMB_PUBLIC_URL`, the licence key and the SMTP variables to the workspace.
- The nftables fence between a workspace's loopback ports and its neighbours.
- Caddy fetching a certificate for a custom address, and a browser reaching the
  workspace through it. DNS is not involved offline.
- A real `apt-get`, NodeSource, `npm install -g openmausbot` and the Claude
  Code install. The installer is proven only against recording stubs.
- A real SMTP relay delivering a sign-in code under the reseller's name. Without
  a relay the code goes through the vendor control plane, which is also not
  contacted offline.
- Reboot: Caddy, the fence and every workspace coming back without help.
- A workspace being unable to write the root-owned brand and billing
  directories. The offline run writes them as the current user.
- The 20-second helper deadline on a ledger of hundreds of thousands of rows on
  a loaded server.
- The ledger's honesty: the report is built from what each workspace reports
  about itself. It is evidence, not enforcement, and it does not merge aliases
  such as `ada+work@x.test`.
- The rates are the reseller's own statement. Nothing proves them against the
  vendor's invoice.
- The settings screens: the fixtures prove the HTTP and command-line surfaces,
  not Settings, Installations.
- Closed-month freezing: a report for an earlier month is recomputed from the
  ledgers that exist when it is asked for.
