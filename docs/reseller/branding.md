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

These modes let every workspace on the server read every other workspace's
brand files, not only its own. A brand is shown to anyone who opens the
workspace's address, so it holds nothing secret, but do not put anything in it
that one customer should not see about another.

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
ICO for the favicon only. An HTML or text file named `logo.png` is refused. The
path must name a regular file of at most 1 MiB, not a symbolic link, a folder
or a device; the command opens it as root and checks this before reading.

The file is turned into a `data:` URI, so it must stay under the schema limits
once encoded: about 219 KB of PNG for the logo and 87 KB for the favicon (SVG
slightly less). Larger files are refused with the limit named.

An SVG is refused if it contains a `script`, `handler` or `foreignObject`
element or an embedded `iframe`, `embed` or `object` (with any namespace
prefix, in any case), an `on...=` attribute, a DOCTYPE or an entity
declaration, a `javascript:` or `data:` value, an `href` or `xlink:href` that
is not a plain `#id` inside the image (so no remote `<image>`, `<use>` or
`<feImage>`), an `xml:base`, an animation of `href`, or CSS `@import`,
`image-set()` or a `url()` other than `url(#id)`. These checks also see through
character references and CSS escapes. Gradients, clip paths and other
references to `#id`s in the same file are fine. Export a plain SVG.

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

### What a workspace can read

The relay address sits in every workspace's environment, and that workspace's
own processes, a bot with a shell included, can read their environment from
`/proc`. If the address carries a user name and password, any customer
workspace can take them and send mail as you, from anywhere. `fleet create` and
`fleet brand` print a warning when it does; an address without a login prints
none.

Use a mail relay on the server's own loopback that needs no login instead, such
as Postfix or another MTA listening on `127.0.0.1:25` (put `smtp://127.0.0.1:25`
in `urlFile`; a loopback relay needs no TLS). Keep the real relay password in
that relay's own configuration, and have it pin the sender: refuse or rewrite
any From address other than your sign-in address, and rate-limit. One address
serves the whole fleet, so any workspace can still send through it as that one
sender; giving each workspace its own relay port is not something the fleet
sets up.

The licence key passed to `fleet create` is in the same environment as
`OMB_LICENSE_KEY` and readable the same way: assume every customer can read
your key.

## Known limits

- A full `fleet delete` removes the workspace's `<name>.json` and
  `<name>.override.json`. `_default.json` is shared by every workspace and
  stays. `fleet delete --keep-data` keeps both of the workspace's brand files.
- The desktop apps, installers and mobile apps keep their own name; this brand
  covers the web workspace and its sign-in mail.
- Not yet run on a real Linux server: file ownership and modes on a real
  filesystem, systemd reading `OMB_BRAND_FILE`, a real mail relay, and the
  reseller's own domain and certificate.
