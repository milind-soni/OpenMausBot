# White-label reseller in an Ubuntu 24.04 systemd container — 2026-11-07

## Scope

This is a **container** run, not a VPS run. One privileged Docker container on a
Mac ran Ubuntu 24.04.5 with systemd as PID 1, and `deploy/vps/install.sh` ran in
it as root. No cloud resource, account or DNS name was involved. Nothing was
published to npm, and the laptop's own app and data were not touched.

| Item | Value |
| --- | --- |
| Host | macOS (Darwin 27.3.0), Apple silicon, Docker Desktop 4.98.0, engine 29.9.2, linux/arm64 |
| Kernel the container ran on | 7.0.14-linuxkit, shared with every other container; 10 CPUs and 7.9 GB for the VM |
| Guest | Ubuntu 24.04.5 LTS, `/bin/sh` is dash, systemd booted on the first attempt |
| Installed by the script | Node 24.22.2 (NodeSource), npm 11.19.1, Caddy 2.11.9 (Caddy apt repository), nftables 1.0.9 |
| Package under test | `openmausbot@0.1.145` built from this branch, not the registry's 0.1.145 |
| Container | `omb-reseller-verify-vps`, `--privileged --cgroupns=host`, ports published on 127.0.0.1 only (18080 to 80, 18443 to 443) |

The published `openmausbot@0.1.145` has none of the reseller commands, so the
installer was given a tarball built from this branch with the new
`--package` option. The version string is the same as the registry's; the
sha256 below tells them apart.

```text
pnpm build:server && pnpm exec vite build && node scripts/build-npm-package.mjs
(cd release/npm && npm pack --pack-destination <scratchpad>/pack)
323a679791aa48ad224346df540596978a06e28f4cae6f06e2dddc3de70ee5d3  openmausbot-0.1.145.tgz (18,516,493 bytes)
```

The tarball and `deploy/vps/install.sh` were mounted read-only at `/mnt/omb`.

## Test-only changes to the machine

Every item here exists only because the machine is a container with no public
name. None of it is part of the product. Steps that depend on one are marked.

- **TEST-ONLY DNS**: `main.reseller.test` and `app.customer.test` were added to
  the container's `/etc/hosts`, pointing at the container's own address
  172.17.0.3. The Mac's hosts file and any real DNS were not touched. The
  container's address is private, so the installer's DNS check could only warn.
- **TEST-ONLY TLS**: `local_certs` was added to the global block of the
  Caddyfile after the installer wrote it, then Caddy was reloaded. Without it
  Caddy asks Let's Encrypt, which refuses (see "What the run showed"). HTTPS was
  then checked against Caddy's own local CA, which is not a public authority.
- **TEST-ONLY STAND-IN entitlements**: no signed licence key exists. A folder
  `/opt/omb-standin-layer/server/index.js` whose `register()` grants
  `whitelabel`, `admin` and `billing`, the layer `docs/verification/spend-cap.md`
  describes. It was given to the `fleet billing` and `fleet rates` CLI processes
  through `OMB_ENTERPRISE_DIR` and `OMB_LICENSE_KEY=test-only-standin`, and to the
  workspace services through the systemd drop-in
  `/etc/systemd/system/openmausbot@.service.d/90-test-standin.conf`. The package's
  own enterprise layer was used as the control, without a key.
- **TEST-ONLY container repair**: Docker's Ubuntu image ships
  `/usr/sbin/policy-rc.d` (exit 101), so `apt-get install caddy` did not start
  Caddy as it would on a VPS. The file was removed and Caddy started by hand
  before the third installer run.
- **SYNTHETIC ledgers**: no turns were run. Usage rows were written as the
  workspace's Unix user by a generator (`gen-ledger.mjs`, in the run's scratch
  folder). Every cost, user and turn figure below comes from that data.
- **TEST-ONLY CPU throttle**: `systemd-run -p CPUQuota=4%` to reach the
  helper's deadline.

## Installer change made for this run

`install.sh --package FILE|URL` replaces `openmausbot@VERSION` in the global
`npm install -g`. It cannot be combined with `--version` (exit 2). A file must
be a readable, non-empty regular file ending `.tgz`; the plan and the summary
print its sha256 and say a local tarball is pinned by its content, so there is
no `UNPINNED` warning. An address must be `https://`; it is passed to npm as
given and warned about, because nothing hashes it. Nothing else in the script
changed. `server/deploy-vps-install.test.ts` gained a dry-run test for a file and
for an address, a refusal test, a stubbed-run test and a contract test that
parses every fleet line of a `--package` run with the real `parseArgs`.

## Commands and results

All installer runs used the same options (domain, admin and reseller name from
the brief, `--package /mnt/omb/openmausbot-0.1.145.tgz`, a generated 64x64 PNG
as `--logo`, `--accent '#1D4ED8'`), as root, under dash.

| # | Run | Result |
| --- | --- | --- |
| 1 | `shellcheck -s sh`, `sh -n` in the container | Both clean |
| 2 | `--dry-run` | Exit 0, eleven phases, `+ npm install -g /mnt/omb/openmausbot-0.1.145.tgz`, the sha256 above, no `UNPINNED` |
| 3 | A listener on port 80 | Exit 1 at `check_prereqs`: `ports 80 and 443 must be free for Caddy; something already listens on: 0.0.0.0:80`; `/etc/openmausbot` did not exist |
| 4 | Real run, no `/etc/hosts` entry | Real apt, NodeSource and Caddy installs and `npm install -g` of the tarball (`added 9 packages in 18s`); exit 1 at `check_dns`: `main.reseller.test does not resolve yet` |
| 5 | Real run, name added | Resolved with a "behind NAT" warning; `fleet init` failed: `caddy.service is not active, cannot reload` (container repair above); `/etc/openmausbot/fleet.json` was left behind |
| 6 | Real run after the repair | Exit 0. It ran `fleet init ... --yes` on the leftover registry, `fleet brand --default` and `fleet create main` |
| 7 | The same command again | Exit 0, see "Idempotency" |

### Fleet init

```text
openmausbot-fence: active, enabled
table inet openmausbot {
	chain output {
		type filter hook output priority filter; policy accept;
		oif "lo" tcp dport { 8810, 8811 } meta skuid != { 0, 996, 997 } reject
	}
}
```

The template unit `/etc/systemd/system/openmausbot@.service` has
`PrivateTmp`, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=yes` and
`ReadWritePaths` for the workspace's home only. The kernel accepted the nftables
rules.

### Fleet create (`main`) and the second workspace (`second --host`)

```text
main     https://main.reseller.test   :8810  active
second   https://app.customer.test    :8820  active

uid=996(omb-main) gid=996(omb-main) groups=996(omb-main)
drwxr-x--- omb-main omb-main /var/lib/openmausbot/main
omb-main:x:996:996::/var/lib/openmausbot/main:/usr/sbin/nologin
GET http://127.0.0.1:8810/api/health -> {"app":"openmausbot", ...}
```

`second` was created with `--host app.customer.test --cap 1`. Its Caddy block,
`OMB_PUBLIC_URL` and registry host carry that name; `second.reseller.test` was
not served (curl got no answer). Both names answered over HTTPS with a certificate
from "Caddy Local Authority - ECC Intermediate" (TEST-ONLY TLS); `main` also
answered through the published port from the Mac (`127.0.0.1:18443`).

### Isolation (`docs/verification/fleet.md`, step 4)

```text
omb-main   -> 127.0.0.1:8820  http=000 curl_exit=7   (refused)
omb-main   -> 127.0.0.1:8821  http=000 curl_exit=7
omb-second -> 127.0.0.1:8810  http=000 curl_exit=7
omb-second -> 127.0.0.1:8811  http=000 curl_exit=7
omb-second -> 127.0.0.1:8820  http=200               (its own port)
root       -> 127.0.0.1:8820  http=200
root       -> 127.0.0.1:8810  http=200
omb-main:  ls /var/lib/openmausbot/second          Permission denied
omb-second: ls /var/lib/openmausbot/main/.openmausbot   Permission denied
omb-main:  cat /var/lib/openmausbot/second/.openmausbot/config.json   Permission denied
omb-main:  ls /etc/openmausbot/instances, cat /etc/openmausbot/fleet.json   Permission denied
```

### Brand

`/etc/openmausbot/brands` is `root:root` 0755; `_default.json`, `main.json`,
`main.override.json` and the same three for `second` are `root:root` 0644. As
`runuser -u omb-main`, appending to `main.json` or `_default.json`, creating
`new.json`, `rm` and `mv` of `main.json` all failed with `Permission denied`.
`OMB_BRAND_FILE` is in `/etc/openmausbot/instances/main.env` and in the running
service's `/proc/<pid>/environ`.

`GET /api/brand` on the workspace:

- without the stand-in (the package's real enterprise layer, no key):
  `{"brand":{"name":"OpenMausBot"},"source":"default", ... "notice":"... this server is not licensed for whitelabel; using the default brand"}`
- with the TEST-ONLY STAND-IN: `{"brand":{"name":"Acme AI","accent":"#1D4ED8","logo":"data:image/png;base64,iVBOR..."},"source":"file","file":"/etc/openmausbot/brands/main.json"}`

So the mechanism (merged file, entitlement, per-request read) works on Linux
under the tenant's real user; the entitlement itself was a stand-in.

### Billing on synthetic ledgers (TEST-ONLY STAND-IN, SYNTHETIC data)

Rates: `fleet rates --wholesale-workspace 5.00 --wholesale-user 2.00
--retail-workspace 20.00 --retail-user 9.00 --retail-override second=15.00/6.00`.
Without the stand-in `fleet billing` exits 2 naming `admin, billing`.

Ledger: 12 in-month rows, one torn line, one row from 2020; three distinct
people (`alice@customer.test` in two spellings, `bob@customer.test`, the device
"Ada's phone"). The expected figures were worked out from the generator
(users 3, turns 12, cost 0.61, wholesale 5.00 + 3 x 2.00, retail 20.00 + 3 x 9.00).

```text
$ openmausbot fleet billing --month 2026-11 --csv --detail
month,row_type,workspace,host,user,user_kind,asked_turns,attributed_turns,cost_usd,billable,ledger,wholesale_minor,retail_minor,margin_minor,currency
2026-11,workspace,main,main.reseller.test,,,,12,0.6100000000000001,true,ok,1100,4700,3600,USD
2026-11,user,main,main.reseller.test,alice@customer.test,email,3,4,0.04,,,,,,USD
2026-11,user,main,main.reseller.test,bob@customer.test,email,2,2,0.51,,,,,,USD
2026-11,user,main,main.reseller.test,device:ada's phone,device,2,2,0.02,,,,,,USD
2026-11,workspace,second,app.customer.test,,,,0,,true,ok,500,1500,1000,USD
2026-11,total,,,,,,12,0.6100000000000001,,ok,1600,6200,4600,USD
```

A future month exits 2 (`2027-01 has not started yet`).

### People helper: size, time and limits

Synthetic ledgers written as `omb-main`, read by `fleet billing` through the real
root-to-tenant drop. Wall time is the whole CLI run (Node start, stand-in layer,
helper) on an unloaded 10-CPU VM, so it is a floor, not a VPS figure.

| Ledger | Bytes | Result | Wall |
| --- | --- | --- | --- |
| 15,500 rows, 500 people | 4,352,090 (over 4 MiB) | ok | 0.165 s |
| 50,000 rows, 900 people | 14,043,840 | ok, 900 users | 0.217 s |
| 350,000 rows | 98,307,210 | ok | 0.623 s |
| 880,000 rows | 247,172,420 (235.7 MiB) | ok | 1.397 s |
| 960,000 rows | 269,642,630 (over 256 MiB) | `ledger: unavailable`, exit 1, blank totals | 0.133 s |
| 50,000 rows, 2,000 people | 14,043,840 | unavailable: `more than 1000 distinct people asked this workspace`, exit 1; with `--max-users 5000`, 2000 users, exit 0 | |
| 880,000 rows, CLI under `CPUQuota=4%` | 247,172,420 | unavailable: `workspace ledger took too long`, exit 1 | 33.2 s |
| 880,000 rows, CLI under `CPUQuota=8%` | 247,172,420 | same | 24.9 s |

The deadline path therefore fails closed on real Linux: the report is incomplete,
the totals are blank and the exit status is 1. The 20 s figure was reached by
throttling the CPU, not by a slow disk or a loaded neighbour.

The fleet agent's own `usage` view (4 MiB cap) was also exercised by adding an
operator (`fleet init --yes --operator opr`, `openmausbot-fleet.service`, socket
`root:opr` 0660): a 3,650,140-byte ledger gave `turns: 13000`; the 4,352,090-byte
one gave `unavailable: true`. The agent's `GET /billing` gave 6 active users for
the two lines.

### Suspend, resume, delete

- `fleet suspend second`: `inactive` and `disabled`, the site answered 503 with
  `This workspace is suspended.`, its fence line stayed; billing still listed it
  (it had usage). `fleet resume second`: `active`, HTTP 200, registry events
  `running, suspended, running`.
- `fleet delete second --yes`: exit 0; `second.json`, `second.override.json`,
  `second.caddy`, `second.env`, the account `omb-second` and its home
  are gone and the fence kept only `main`'s ports.
  `/var/lib/openmausbot-billing/closing/second@2026-11-07T00:39:07.228Z@2026-11.json`
  exists, `root:root` 0600 in a 0700 root directory. As `omb-main`, writing into it,
  `rm` and `ls` all failed with `Permission denied`. A later `fleet billing`
  still listed `second` (status `deleted`) with the same wholesale and retail
  amounts.

### Idempotency

Same command a second time: `ports: caddy from an earlier run holds 80 and 443`,
`node v24.22.2 is already installed`, `caddy is already installed`,
`/etc/caddy/Caddyfile already imports the workspaces folder; leaving it alone`,
`fleet init ... --yes`, `fleet brand --default ... applied to 1 workspace`,
`workspace main already exists (active); not creating it again`. The sha256 of
`/etc/caddy/Caddyfile`, `brands/main.json` and `fleet.json` and the service's
start time were unchanged, and no new Caddyfile backup was made. `npm install -g`
of the tarball ran again (`changed 9 packages`).

### Container restart

`docker restart` re-ran systemd. `caddy`, `openmausbot-fence` and `openmausbot@main`
were `active` and `enabled` without help, the nftables fence was back, health
answered, `NRestarts=0`, billing read the same ledger. The kernel did not
restart: `boot_id` was identical before and after.

## What the run showed

- The installer works end to end on Ubuntu 24.04 under dash with the real apt,
  NodeSource, Caddy repository and npm, resumes after a failed `fleet init`, and
  is idempotent.
- With the container's Internet access, Caddy contacted the real Let's Encrypt
  and was refused before any challenge: `HTTP 400 urn:ietf:params:acme:error:invalidContact
  ... contact email has invalid domain: Domain name does not end with a valid
  public suffix (TLD)`. The first `--admin` address is the ACME contact, so an
  address on a non-public domain cannot get a certificate. A real reseller's
  first admin needs a real address.
- The static page's `<title>` is `MausBot`; the brand is applied by the app at
  runtime. No browser was driven.

## Corrected or found

- **Corrected**: `install.sh --package` (above). No other installer behaviour was
  changed, and no installer bug was found.
- **Not a bug**: the missing `caddy.service` start was Docker's `policy-rc.d`.
- **Server bug, not fixed (cosmetic)**: `fleet billing --csv` prints `cost_usd`
  with binary rounding noise (`0.6100000000000001`, `499.99999999969026`,
  `8800.000000145663`) because `csvNumber` prints the raw float sum
  (`server/fleet-billing.ts:206`, `:208`, `:214`; `server/usage-ledger.ts:333`),
  while the text report uses `toFixed(4)` (`server/fleet-billing.ts:231`). The
  fleet agent's `usage` view shows the same noise (`130.00000000002674`). Money
  in minor units is exact. The test is
  `server/fleet-billing-csv-precision.test.ts`, written as `it.fails` so the
  suite stays green; change it to `it` when the cells are rounded.

## Not proven (container is not a VPS)

- A VPS. Nothing here ran on a cloud server, its provider network, its firewall
  or its real public address, and no capacity or load figure applies: the host
  was an idle 10-CPU Apple-silicon VM and the timings are floors.
- Public DNS and ACME certificates. The names were `/etc/hosts` entries, the
  certificates came from Caddy's local CA, and Let's Encrypt refused the contact
  before any challenge. HTTP-01 reachability on port 80 and 443 from the Internet
  is untested.
- A non-Docker kernel's nftables. The fence was proven on the Docker Desktop
  VM's 7.0.14-linuxkit kernel, which is shared with other containers, and on
  arm64 only. Ubuntu's own kernel, x86-64 and cloud-provider firewalls are
  untested.
- Reboot persistence. A container restart re-ran systemd on the same kernel;
  it is not a machine reboot and says nothing about disk, boot ordering with
  cloud-init, or time to recover.
- Real SMTP. No relay was configured; no sign-in code was sent or received.
  `openmausbot pair` was not run. The vendor control plane was not contacted.
- The licence. Everything marked TEST-ONLY STAND-IN: `whitelabel`, `admin` and
  `billing` were granted by a stand-in layer, so the real signed-key check, its
  expiry and grace behaviour, and `--license-key-file` were not exercised.
- Real usage. All ledger rows are synthetic; no engine ran a turn, no
  workspace wrote its own ledger, and attribution of real paired devices and
  signed-in sessions was not checked on Linux. The report is still tenant-reported
  evidence, not enforcement.
- A browser. Neither the logo and name on the page, sign-in, nor Settings,
  Installations was driven.
- The `--package https://...` path. It was dry-run and stub-tested only; no
  address was served and fetched. The tarball's dependencies came from the
  public npm registry, which the sha256 does not cover.
- The `--engine claude` install, `--operator` as an existing login user,
  `--anthropic-key-file`, `--cap` enforcement and `fleet upgrade`.
- A tenant that is actively hostile. The isolation checks used ordinary
  commands as the tenant user, not an escape attempt.
- x86-64. Only arm64 packages (DuckDB, resvg) were installed.

## Cleanup

The container `omb-reseller-verify-vps` and the image `omb-reseller-verify-img`
were removed; the Ubuntu base layer was not kept as a tagged image. `docker ps -a`
and `docker images` filtered by `omb-reseller-verify` are empty. No other
container, image or volume was touched. The build outputs in the repository
(`dist`, `dist-server`, `release`) were removed after the tarball was copied out.
