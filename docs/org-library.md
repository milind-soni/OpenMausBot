# The organization library

An organization's Admin can share packages (whole teams, or skills on their
own) with the desktops that belong to it, and with its Customers. In
OpenMausBot they appear under **Templates → From {Organization}**, the first
tab. One click on **Add** adds a package. There is no confirmation step,
because the person's click is the decision. **Details** opens the same
preview a shared file gets.

With no organization account nothing changes: the tab is absent, every
route below answers `{organization: null}`, no file is written and nothing
is reported.

## What Add does

The package goes through the same importer as a file (`server/package-import.ts`),
called with `trust: "org"` from `server/org-library.ts` and nowhere else.
Compared with a file:

- **Skills arrive switched on.** The organization's Admin published them,
  so Admin was the review. Their source reads `org:<publisher>/<package>@<release>`,
  and the file's own `source` is ignored.
- **Routines still arrive paused.** Bots still start at the default approval
  level, with no connected-app access and the installation's default model.
  Connections are still created switched off, without values.
- **Every record is stamped** with its install. A bot's wire-visible
  `installedPackage` gains `source: "org"`, `installId`, `publisher`, `ref`
  and `sha256`. Server-side only, each record also keeps two hashes for
  every part: `r`, the part as released, and `w`, the part as written here.
  The hashes live on bots (`packageBase`), group chats (`installedPackage`),
  routines (`installedPackage`) and skill state (`package`). The later
  automatic update uses them to tell your edits from the publisher's changes.
  Value shapes are in `server/package-parts.ts`.
- **A skills-only package** creates no records. Its skills are *offered*:
  **Bot → Skills → From {Organization}** lists them, and **Add** there puts
  one on that bot, switched on and stamped. A team's skills that no bot
  uses are offered the same way. Offered skills are read from the release
  file that was added. Electron removes a release file a week after the
  catalog stops naming it, and then those skills are no longer offered,
  though skills already on a bot stay.
- **Adding twice does nothing.** The install id is derived from the Admin
  address, the organization and the package, so the same package is the
  same install on every reconnect. A second Add answers `200
  {alreadyAdded: true}`.

A bot added from the organization's library shows where it came from in
**Bot settings → Identity**: "From Sales desk 1.3.0 · Acme Partners". A bot
imported from a file shows no such line, as before. When the catalog names
a newer release of an added team, it comes over on its own (see Updates
below). Until its file is downloaded, the card says "Version X available. It
comes over on its own once it's downloaded, and keeps your changes."

**Required** is treated as Available in this version, with a "Recommended
by …" badge. Entries the organization switched **off** are hidden, and
their copies stay.

## Updates

After each relayed catalog, every added team whose catalog release differs
from the one it has is brought up to that release, once its file is
downloaded and readable by this app (`server/org-library-releases.ts`). A
release listed under `withdrawnReleases` is never moved to, and a withdrawn
or removed install is left alone.

It goes part by part, by the `r` and `w` hashes stamped when each part was
written. A part takes the new release's value only when the publisher changed
it (its new hash is not `r`) and the person did not (the part as it is now
still hashes to `w`). It is then written and stamped with the new hash. A part
the person changed keeps their version, now and in later releases.

| Part | Updated |
|---|---|
| A bot's name, title, description, instructions and playbooks | yes; a new name another bot already has is kept back |
| A bot's skills | each skill's instructions and included Markdown companions, and a skill new to that bot in this release (while the file of the release it had is still kept, which is how a new skill is told from one the person took off); never one the person took off, and a skill switched off stays off |
| A group chat's name and bulletin | yes |
| A routine's name, prompt and schedule | yes; whether it is on stays the person's |
| The team brief | yes |
| Look, connections, approval, room members and responder, routine targets, the leader | not in this version: they stay as they were added |
| Bots, group chats and routines new in a release | not added in this version |

An update never raises approval, switches a routine on, or adds a
connection. The install, each bot's `installedPackage` and each updated
skill's stamp move to the new release. If a part can't be written, the parts
written so far keep their new stamps, the install stays on its release, and
the next catalog finishes it. An updated skill is staged as a complete folder
before its manifest changes, so a failed write leaves the previous files in
place. A reference-only change is an update; an edited, missing or extra local
file blocks replacement of that skill. If an interrupted update left the old
folder behind, the app cleans it up when the skill is removed or moved only
while its contents are unchanged; a changed folder is kept for you to move.
If an updated organization's active skill folder has changed, removing the
skill keeps that folder for recovery instead of deleting its local edits.

## Withdrawn releases

When the catalog lists an added release under `withdrawnReleases`, its
skills are switched off (on its own bots, where an offered skill was added,
and on bots someone made from its presets), its routines are paused, its
presets leave New bot, the install is marked **withdrawn**, and the bot's
provenance line adds "Withdrawn by <publisher>".
This happens once, on the change. If you switch something back on
afterwards, it stays on. A team you already removed stays removed, but an
offered skill it left on another bot is switched off the same way, once. A
package that disappears from the catalog changes nothing: copies stay.

## How the catalog arrives

This runtime never talks to Admin. Electron main (`electron/managed-desktop.mjs`)
owns the Admin connection: it fetches the catalog and each release file,
checks their SHA-256, and writes the files to
`DATA_DIR/org-library/blobs/<sha256>.json`. It then relays the catalog over
the private utility port:

```jsonc
// Electron main → runtime
{ "type": "openmausbot:managed-library", "requestId": "…",
  "library": { "adminOrigin": "https://admin.example.com", "organizationId": "<uuid>",
               "organizationName": "Customer Co", "digest": "<sha256 of the catalog body>",
               "catalog": "<the raw catalog body, or the parsed object>" } }   // or library: null
// runtime → Electron main, at once, before any other work
{ "type": "openmausbot:managed-desktop-result", "requestId": "…", "ok": true }
```

- A catalog body sent as a string must hash to `digest`.
- The runtime reads the catalog as contract §5.3 defines it: unknown fields
  are ignored and a bad entry is dropped. A bad envelope, or a catalog for
  another organization, is refused (`ok: false`), and the last good catalog
  stays.
- `library: null` (sign-out, expiry or revocation) hides the shelf and
  changes nothing else.
- Release files are checked against their SHA-256 on every read, and never
  through a symbolic link. A file that does not match is treated as not
  downloaded.

After acknowledging, the runtime reconciles its index, handles withdrawn
releases, and sends a full snapshot back:

```jsonc
// runtime → Electron main, which posts it to POST /api/desktop/library/report
{ "type": "openmausbot:managed-library-state", "digest": "<applied digest>",
  "packages": [ { "packageId": "<uuid>", "release": "1.3.0", "sha256": "…",
                  "state": "installed" | "failed" | "removed" | "withdrawn",
                  "reason": "blob_unavailable" | "invalid_package" | "import_failed" | "newer_app_required"
                          | "removed_locally" | "withdrawn_by_publisher" } ] }
```

The runtime sends this snapshot at three points:

- after each relayed catalog;
- after each Add, whether it succeeds or fails;
- after the person deletes the last record of an install.

Debouncing, retries and the once-per-start report belong to Electron main.
A report lists only installs from the current organization. It never
contains names, paths or error text.

## Files

`DATA_DIR/org-library/`:

| File | Written by | What |
|---|---|---|
| `state.json` | runtime | The index of what was added (contract §3.4), plus `kind`, `name` and `withdrawnHandled` per install, and `adding`: team Adds that have started and not finished. Mode 0600. |
| `blobs/<sha256>.json` | Electron | Release bytes, checked on every read. |
| `catalog.json` | Electron | The last applied catalog body. The runtime does not read it. |
| `presets.json` | runtime (`server/presets.ts`) | Preset bots, from files and from installs here ([presets.md](presets.md)). An install's presets are listed under `presets` in `state.json`. |

Preset rows in `presets.json` carry their install id too. They are how a
package of presets and skills (no bots) is recognized again if its
`state.json` entry is lost, and they give an adopted install its `presets`
back. They never keep a team added, and neither does a bot someone made from
one of its presets (nor that bot's skills, although they carry the install's
skill stamp marked `via: "preset"`), so a team the person deleted can be
added again; its presets are then refreshed in place, never duplicated.
New bot asks the library for each install's status
(`OrgLibrary.installStatuses()`), from its state in memory.

The records are the source of truth. `state.json` is rebuilt from them in
these cases:

- on start;
- before every Add;
- after each relayed catalog;
- whenever a bot or group chat is deleted, or a team is renamed.

A team's section is read from where its bots are now, so renaming the team
needs no hook. A team counts as added while any of its bots, group chats or
routines is left. An offered skill someone put on another bot is a copy: it
stays, but it does not keep the team added, so once the team's own records
are gone the install is `removed` and **Add** brings the whole team back.

Each install's `removedLocally` (contract §3.4) lists the parts of an added
team the person deleted: `agent:<key>` for a bot, `room:<key>` for a group
chat and `routine:<key>` for a routine. It tells a part the person deleted
from a part a new release adds, so an update never brings a deleted part
back. It is kept like this:

- **When it is noted.** Each time the index is rebuilt, a key the index held
  that no longer has a record is added to the list once. Rebuilding again,
  or restarting, adds nothing. A routine stops counting when its bot is
  deleted, so deleting a bot notes its routines too. Deleting a routine is
  not a store change, so it is noted at the next rebuild (the next catalog,
  Add or start).
- **A team deleted whole** becomes `removed`, and every one of its parts is
  noted too. The list then reads the same whether the person deleted the
  team at once or one bot at a time.
- **A part that has a record again** (records restored from a backup) is
  taken off the list, so it never names a part that is there.
- **Add after a removal** brings the whole team back, so it starts a new,
  empty list.

If the app stops after the records are written but before the index is, the
records are adopted once the catalog names their package, and a second Add
is still a no-op. An adopted install has no team-part hashes, so a later
update treats those parts as edited and keeps them. Its `removedLocally`
starts empty: the remaining records can't show what the person deleted
before `state.json` was lost, so a later update could bring those parts
back. The same holds when `state.json` could not be read.

If the app stops in the middle of adding a team, the next start finds its
entry under `adding` (written before the first record) and looks at what
was written. The importer writes each bot's part hashes after its skills and
starter notes, the brief before the group chats and routines, and the leader
last. So:

- **Every bot, group chat and routine is there and the leader is set:** the
  team is indexed as added, like the crash above.
- **Anything is missing:** the partly added bots, group chats, routines and
  their new team are removed again, and the report says `failed` with
  `import_failed`. **Add** then brings the whole team. Two things may stay
  behind: its connection slots (switched off, with no values, under their
  MCP server names), and its bots' picture files, which a failed import
  leaves too.

## Routes

These routes use admin scope, like import.

| Route | Answer |
|---|---|
| `GET /api/org-library` | `{organization, packages: [entry + blob: "ready"\|"unavailable"\|"unsupported" + installed], installs}`. `{organization: null, packages: []}` with no organization. |
| `GET /api/org-library/packages/:packageId` | `{package, document}`: the preview, read from the checked file. |
| `POST /api/org-library/add {packageId}` | `201` with the added records · `200 {alreadyAdded: true}` · `404` not listed or switched off · `409 newer_app_required` · `503 blob_unavailable` · `422 invalid_package` |
| `GET /api/org-library/skills?botId=` | Offered skills of added packages, with `added` per bot. |
| `POST /api/org-library/skills {botId, installId, name}` | `201 {skill}`: puts one offered skill on a bot, switched on. |

Fixtures have no Electron parent. For tests, `POST /api/testing/org-library
{library}` relays a catalog instead. The route exists only when the server
starts with `OMB_TEST_ORG_LIBRARY_KEY`, and the request carries that key in
`x-openmausbot-test-org-library`. Production never sets the key.

## Not in this version

These arrive later with no format change:

- updating a bot's look, connections and approval, room members, routine
  targets and the leader, and adding parts new in a release;
- Required with auto-install;
- honouring `offAction: "remove"`;
- the Admin Withdraw button.

Preset bots from a package go to **New bot** under **From {Organization}**,
and a bot made from one gets their skills switched on. A preset from a
withdrawn release is no longer offered. See [presets.md](presets.md).

See [verification/org-library.md](verification/org-library.md) for how this
is tested.
