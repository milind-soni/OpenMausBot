# Bitwarden in the Vault

Settings → Vault can connect a Bitwarden account (Password Manager) beside 1Password, and a Bitwarden Secrets Manager
machine account under it ([below](#bitwarden-secrets-manager)). Its logins fill
on their sites like any saved login, and its items serve bots as secrets, read from Bitwarden at the moment a bot uses
one. On a desktop, a personal Cloud and a Team Cloud alike (`server/host/bitwarden-vault.ts`).

## Connecting

An admin picks the server (bitwarden.com, bitwarden.eu, or a self-hosted Bitwarden or Vaultwarden at any `https://`
address) and pastes the account's personal API key (`client_id`, which starts with `user.`, and `client_secret`, from the
account's Account settings → Security → Keys → View API key) and its master password. The row says the setup to use: *Use a
dedicated Bitwarden account that can only see one collection.* The account's collections are the boundary: every bot may
use what the account sees, so the account should see only what bots should.

The three are checked before anything is kept: a wrong master password, a refused API key, a server that can't be reached
and a tool that didn't answer in time each say so in plain words. Once Bitwarden accepts them they are sealed in the
Vault's file (`logins.json.enc`, never backed up or moved) and never shown again.

## How it runs

- `bw login --apikey` with `BW_CLIENTID` and `BW_CLIENTSECRET`, then `bw unlock --passwordenv BW_PASSWORD --raw`. Every
  secret reaches the tool in its environment, never its arguments, and of the server's own environment the tool gets
  only `PATH` (and `SystemRoot` on Windows). The session key is kept in the server's memory only; when it ends ("Vault is locked", or the tool was
  signed out) the server unlocks again, once, and retries.
- `bw sync` runs before the list is read (every 10 minutes at most, or on Refresh) and before a value is read, at most
  once a minute. Every call has a timeout (60 s).
- `bw list items` gives the list; every value in it is dropped at once. `bw get item <id>` reads one item when a bot uses
  it, and the value is masked wherever text crosses to a bot or a transcript.
- The tool keeps its settings and the account's encrypted copy of the vault in `<data>/tools/bitwarden/account`, which
  no backup or move carries. Disconnect signs the tool out and deletes that folder.

## Logins and secrets

- **Logins**: Login items with a password and a website (their URIs), by site, filled with their password and their
  one-time code when the item has a TOTP key. Read-only here: they are changed in Bitwarden.
- **Secrets by name**: a Secure Note (its text), and a Login item with custom fields (its first hidden custom field by the
  item's name, every other one as "<name> <field>"). These names are what a bot's prompt lists.
- **References**: `bw://<item id or name>[/<field>]`, where the field is `password`, `username`, `totp` (the current
  one-time code), `notes` or a custom field's name; with no field, a Login's password or a Secure Note's text. A
  reference reaches any Login or Secure Note the account sees, and is resolved where 1Password's `op://` references are:
  `request_credential` with the reference as the label hands the value over as a ref or a file, never as text. A name two
  items share is refused (use the id); a field the item lacks is refused. A bot that may use Bitwarden is told a
  reference works as a label. Bitwarden's own field names win over a custom field of the same name.

## Team Clouds

Only an admin connects, refreshes or disconnects it (`/api/logins/bitwarden*` answers a member 403), for the whole team:
its logins and secrets serve the team's bots in shared, group and private chats, as an admin's saved secrets and team
1Password do. A member's Vault shows `bitwarden: { connected: false }` and none of its items. The Admin's signed report
lists it in `vault.providers` as `{ kind: "bitwarden", connected, label: <server host>, lastError? }`, never a value,
the API key or the master password.

## Bitwarden Secrets Manager

A second row, *Bitwarden Secrets Manager*, connects a machine account by its access token
(`server/host/bitwarden-secrets.ts`). An admin picks the server (the same three choices) and pastes a token from Secrets
Manager → Machine accounts → Access tokens. What the machine account reads is the boundary, through the projects it is
given and any secret granted to it directly: every bot may use what it reads, so it should read only what bots should.

- **Its own client.** `server/host/bitwarden-secrets-api.ts` speaks Secrets Manager's public HTTP API with Node's crypto,
  no `bws` and no Bitwarden SDK: it signs in at `<identity>/connect/token` (`client_credentials`, scope `api.secrets`),
  derives the token's key from its seed (HKDF-SHA256, salt `bitwarden-accesstoken`, info `sm-access-token`), decrypts the
  organization's key from the sign-in answer, then lists `GET <api>/organizations/<id>/secrets` and reads
  `POST <api>/secrets/get-by-ids`. Every encrypted field is a type 2 EncString (AES-256-CBC with HMAC-SHA256), checked
  before it is decrypted. bitwarden.com and bitwarden.eu answer on `identity.` and `api.` hosts, a self-hosted server
  under `/identity` and `/api`. Redirects are refused; every call has a 20 s timeout.
- **Checked before it is kept.** A token Bitwarden refuses, or one whose seed opens nothing, says so and keeps nothing.
  Once accepted it is sealed in the Vault's file like the others and never shown again. The bearer token and the
  organization's key stay in the server's memory, renewed a minute before they end; a refused bearer signs in again, once.
- **Logins**: a secret whose note has a `url:` or `site:` line (and optionally `username:` and `totp:` lines) is that
  site's login, its value the password. Read-only here.
- **Secrets by name**: every other secret, by its name (its key in Secrets Manager).
- **References**: `bws://<secret id or name>` reaches any secret the machine account reads, resolved where `op://` and
  `bw://` are. A name two secrets share is refused (use the id).
- The list is read at most every 10 minutes, or on Refresh. Reading it decrypts every listed secret, value included, to
  see which notes name a site; those values are dropped at once. A value is read from Bitwarden again when a bot uses it,
  and masked like any other. Every secret is listed by name, but only the first 1,000 are read for notes, so a login past
  them shows as a secret by name.
- On a Team Cloud only an admin connects it, for the whole team; a member's Vault shows
  `bitwardenSecrets: { connected: false }`. The Admin's signed report does not list it yet.

## The tool, and why OpenMausBot stays Apache-2.0

The tool is Bitwarden's own command line client, built from github.com/bitwarden/clients, whose code is GPL-3.0 except
the `bitwarden_license/` folder. OpenMausBot uses its **open-source build** (`bw-oss-*`, made with `build:oss` from the
GPL code alone) and never bundles, ships or imports it:

- It is downloaded on first use from Bitwarden's GitHub release
  `https://github.com/bitwarden/clients/releases/download/cli-v2026.10.1/<asset>-2026.10.1.zip`, checked against the
  pinned size and SHA-256 below, and unpacked to `<data>/tools/bitwarden/2026.10.1/bw` (`bw.exe` on Windows). A download
  that fails the check installs nothing.
- It runs only as a separate process: arguments and environment in, text out (`server/host/bitwarden-cli.ts`). Two
  programs talking that way are separate works; OpenMausBot links nothing of Bitwarden's and copies none of its source.
- No `@bitwarden/` package is a dependency: `scripts/testing/no-bitwarden-dependency.test.ts` fails if one enters a
  manifest, a lockfile or an import. (Bitwarden's Secrets Manager SDK, `@bitwarden/sdk-napi`, is under Bitwarden's own
  SDK license, which forbids offering an app built with it to others; `@bitwarden/sdk-internal` is GPL-3.0. Neither is
  used, and neither is the `bws` tool, which is under the same SDK license: Secrets Manager goes through OpenMausBot's own
  client of its HTTP API, written from the protocol, with no Bitwarden code or test data.)

| Platform | Asset | Bytes | SHA-256 |
|---|---|---|---|
| macOS arm64 | `bw-oss-macos-arm64` | 41861655 | `8b64bc7887f03c8d3ee10be2d720f3904ab632553434a47703f428d8ece9c9f2` |
| macOS x64 | `bw-oss-macos` | 44129496 | `faa5c6ec794bb2b3c969e2f08cba04a0f0ff8f1b2c10c5cf7b88911eaa0c1f4b` |
| Linux x64 | `bw-oss-linux` | 45802496 | `53384064abe7555039281bc2e6fe51846368ba60db9b7ba89de183409d7f6738` |
| Linux arm64 | `bw-oss-linux-arm64` | 44326018 | `9413e412ba2f8d3b179c54314c3d2d51c0b2ec25ed17b96a98b7c2d404b6d2a7` |
| Windows x64 | `bw-oss-windows` | 39074173 | `8ec2a4235c6c8db93cf42b444161882842e28f14dd6116369dea61efde8a418f` |

Windows on Arm has no build, and says so when connecting. The digests are GitHub's own for the release assets; the
macOS arm64 one was also checked against a download.

## Tests

`server/host/bitwarden-secrets.test.ts` (an in-memory Secrets Manager, `server/testing/fake-bws.ts`),
`server/host/bitwarden-vault.test.ts` and `server/host/bitwarden-cli.test.ts` (an in-process fake `bw`,
`server/testing/fake-bw.ts`, and a fake download), and `server/cloud-team-bitwarden.e2e.test.ts` (a real Team Cloud with
the fake installed where the real one would be, `server/testing/fake-bw-process.ts`). None touches the network or a real
Bitwarden account.
