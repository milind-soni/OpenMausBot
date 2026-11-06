# Branding a reseller's workspaces

Every workspace on a reseller's fleet shows the reseller's name, logo and
colours instead of OpenMausBot. The brand lives in files only root can write,
so a customer cannot change it from inside their workspace.

A workspace shows its brand only when its licence key grants `whitelabel`.
Without one it keeps the OpenMausBot brand, and `GET /api/brand` says why in
`notice`. `fleet create` prints a note when no key was given.

## Where the brand lives

Files in `/etc/openmausbot/brands/` (directory mode 0755, files 0644, owned by
root):

| file | holds |
|---|---|
| `_default.json` | the reseller's default brand, any of the fields below |
| `<name>.override.json` | what one workspace changes from the default |
| `<name>.json` | the merged result the workspace reads |

Each workspace's environment file gets `OMB_BRAND_FILE=/etc/openmausbot/brands/<name>.json`.
The server re-reads that file on every `GET /api/brand`, so a change shows the
next time a page loads, with no restart.

The merged brand is, field by field: the workspace override, else the default,
else (for the name only) the reseller's name from `fleet init --reseller-name`.
Clearing a field in the override gives the default back; clearing it in the
default gives the reseller's name back for `name` and no value for the rest.

Fields: `name` (1 to 40 characters), `tagline` (up to 120), `accent` (`#RRGGBB`),
`logo`, `favicon`, `supportUrl` (https, no user name or password).

A fleet created without `--reseller-name` is unchanged: `fleet create --brand FILE`
still writes `<home>/.openmausbot/brand.json` owned by the workspace.

## Commands

```sh
openmausbot fleet brand --default --brand-name "Acme Assistant" --accent "#C2510A" \
  --tagline "Ask anything" --logo ./logo.svg --favicon ./icon.png --support-url https://help.acme.example
openmausbot fleet brand blue --brand-name "Blue Team" --clear tagline
openmausbot fleet create blue --admin ada@acme.example --brand ./blue.json --license-key-file /root/omb.key
```

- A flag sets a field; `--clear FIELD` removes it (repeat for several). Setting
  and clearing the same field in one command is refused.
- `--default` saves the default and rewrites the merged file of every running
  or suspended workspace. Workspaces that are provisioning, in error or retained
  are skipped with a note; run `fleet brand NAME` once they run again.
- Every target is checked before the first file is written: one invalid
  override, or an invalid value, stops the whole command with nothing changed.
  Running the same command twice produces the same files.
- With a reseller, `fleet create --brand FILE` is the new workspace's override
  (a JSON file with any of the fields).
- After renaming the reseller (`fleet init --reseller-name … --yes`), run
  `fleet brand --default` once so merged files take the new name.
- A workspace created before the fleet had a reseller does not read the brand
  file. `fleet brand` says so; recreate the workspace to apply it.
- `--dry-run` prints the files it would write and leaves the images out.

## Images

`--logo` and `--favicon` take a file. The command reads the file's bytes and
decides the type from them, not from the name: PNG, JPEG, WebP, GIF or SVG, and
ICO for the favicon only. An HTML or text file named `logo.png` is refused.

The file is turned into a `data:` URI, so it must stay under the schema limits
once encoded: about 219 KB of PNG for the logo and 87 KB for the favicon (SVG
slightly less). Larger files are refused with the limit named.

An SVG is refused if it contains `<script`, an `on...=` attribute,
`<foreignObject`, an embedded `iframe`, `embed` or `object`, an entity
declaration, or a `javascript:` link, also when written with character
references. Export a plain SVG.

`--logo https://…` keeps the address as typed. The command never downloads it,
so the logo must stay reachable for as long as the workspace uses it. The
favicon must be a file. Links with a user name or password are refused.

## The operator's agent

`PUT /brand` (default) and `POST /workspaces/<name>/brand` on the fleet socket
take JSON with `name`, `tagline`, `accent`, `supportUrl`, `logo`, `favicon` and
`clear`. Images must be `data:image/…;base64,…` URIs; a path or an address is a
400. The agent applies the same checks as the CLI, answers 400 before writing
anything, and records only the names of the fields changed in its audit log.
`GET /workspaces` lists each workspace's brand without logo or favicon.

## Sign-in mail

Sign-in codes are mailed with the brand's name: "Your Acme Assistant sign-in
code".

- With `reseller.smtp` in `fleet.json` (`{ "urlFile": "/etc/openmausbot/smtp.url", "from": "Acme <login@acme.example>" }`),
  `fleet create` reads the SMTP address from `urlFile` as root and writes it,
  and the sender, into the workspace's environment file as
  `OMB_SIGNIN_SMTP_URL` and `OMB_SIGNIN_SMTP_FROM`. The address is never stored
  in the registry or printed; a dry run shows a placeholder. Percent-encode the
  user name and password in it, and avoid quotes and backslashes in both
  files.
- Without it, codes go through the OpenMausBot account service under the
  OpenMausBot name, and `fleet create` prints a warning. The fallback is
  `openmausbot pair` on the server, which prints a pairing code for an admin.

The SMTP password sits in each workspace's environment, where processes of that
workspace can read it. Use a relay account that can send only from the sender
address.

## Known limits

- `fleet delete` does not remove the three brand files of a workspace. A
  workspace created later under the same name overwrites its override and
  merged file.
- The desktop apps, installers and mobile apps keep their own name; this brand
  covers the web workspace and its sign-in mail.
- Not yet run on a real Linux server: file ownership and modes on a real
  filesystem, systemd reading `OMB_BRAND_FILE`, a real mail relay, and the
  reseller's own domain and certificate.
