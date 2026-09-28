# The organization library on the desktop

When an Organization shares packages with its members, or a partner shares
them with its Customers, Admin builds a catalog for each receiving
Organization. A connected OpenMausBot desktop keeps a verified copy of that
catalog and of each package's release file, so **Templates → From
{Organization}** can show and add them. This page describes the desktop's half
of that channel: Electron main. The runtime's shelf, the Add button and the
provenance lines are described with the runtime (`server/org-library.ts`).

Nothing on this channel asks anyone anything. What an Organization offers is
decided in Admin; adding a package is a person's own click. There are no
update controls: the catalog always names the newest release.

## When it is used

- **No organization account:** nothing. No request, no file and no message.
- **An Admin without the library:** nothing either. The desktop reads
  `capabilities.library` from `GET /api/public/config`, the same answer it
  already reads once per start for renewal, and calls no library route unless
  it is `1` or higher. A desktop that could not read the config at start (it
  was offline) asks again at most every 10 minutes after a successful sync.
- **An Admin with the library:** every successful session sync
  (`GET /api/desktop/session`, about once a minute) carries a small
  `library: { version, digest }` pointer. When the digest differs from the
  catalog this desktop last applied, main fetches the catalog. Nothing large
  rides on the session itself, which keeps its 512 KiB cap.

## What main does with a new pointer

1. `GET /api/desktop/library` (at most 256 KiB, 20 s). The catalog must be an
   `openmaus.org-library` version 1 envelope for **this** Organization. A
   malformed envelope or another Organization's catalog is refused whole and
   the last good catalog stays. A malformed entry is dropped on its own;
   unknown fields are ignored.
2. For every entry that is not **Off**, has a release, and whose format this
   app reads (version 2 or lower), and whose file is missing:
   `GET /api/desktop/library/blobs/<sha256>` (at most 4 MiB, 60 s, and never
   more than the catalog's `sizeBytes`). The bytes must hash to the catalog's
   `sha256`, or they are never written. A failure leaves that package
   unavailable and is retried on a later sync with a growing delay (a `429`
   pauses downloads for its `retry-after`). Files already cached are re-hashed
   after each new catalog; a file that no longer matches is fetched again.
   Downloads stop at 64 MiB per catalog.
3. The raw catalog bytes are saved as `catalog.json`, then
   `{portalOrigin, organizationId, deviceId, libraryVersion, digest}` is saved
   OS-encrypted in `company-library.bin`.
4. Main relays the catalog to the local runtime (below).
5. The applied digest is the SHA-256 of the bytes actually received, not the
   pointer's, so a catalog rebuilt between the two requests converges on the
   next sync.
6. Release files the catalog no longer names are removed 7 days later.

Every library request uses the device's `omd_` token (never the model
token), refuses redirects, sends no cookies, and is checked against the same
connection generation as company backups: signing out aborts it.

## Files

| Where | What | Written by |
|---|---|---|
| `<app data>/company-library.bin` | which catalog was applied, for which Admin, Organization and device, OS-encrypted | Electron main |
| `<data dir>/org-library/catalog.json` | the exact catalog bytes last applied (owner-only) | Electron main |
| `<data dir>/org-library/blobs/<sha256>.json` | release files, owner-only, written atomically | Electron main |
| `<data dir>/org-library/state.json`, `presets.json` | what this installation added | the runtime |

`<data dir>` is `~/.openmausbot` unless `OMB_DATA_DIR` says otherwise.

Workspace and company backups leave out `catalog.json` and `blobs/`, because
main downloads them again and sign-out deletes them. They keep the runtime's
`state.json` and `presets.json`.

## Start, sign-out and restarts

- **At start**, before any request to Admin, main reads `company-library.bin`.
  It uses the saved catalog only for the same Admin, Organization and device,
  only while the sign-in has not expired, and only if `catalog.json` still
  hashes to the recorded digest. Otherwise the file is ignored and the first
  sync fetches again.
- **A lapsed Admin licence** or an unreachable Admin changes nothing: the last
  catalog stays.
- **Sign-out, expiry or revocation** relays `library: null` (the shelf
  disappears) and deletes `company-library.bin`, `catalog.json` and the cached
  release files. Bots, rooms, routines and skills that were added stay.
- **An Admin that stops advertising the library** is treated the same way.
- **A restarted runtime** is sent the applied catalog again when it is ready.
  A runtime that did not acknowledge a catalog gets it on the next sync. The
  log says so once per runtime and catalog, not on every sync.

## Messages with the local runtime

Electron main → runtime, over the private utility-process port (never HTTP,
never a remote server):

```jsonc
{ "type": "openmausbot:managed-library", "requestId": "…",
  "library": { "adminOrigin": "https://admin.example.com", "organizationId": "…", "organizationName": "Beta Clinic",
               "digest": "<sha256 of catalog.json>", "catalog": { /* the parsed catalog */ } } }
// or "library": null: hide the shelf, change nothing else
```

The runtime swaps its in-memory catalog and answers at once, before any
install work, with `{ "type": "openmausbot:managed-desktop-result", "requestId", "ok": true }`
(the relay gives up after 15 s). It reads release files from `blobs/` itself
and checks their SHA-256 on every read.

Runtime → Electron main, unsolicited, after it processed a relayed catalog and
after any change to what it added:

```jsonc
{ "type": "openmausbot:managed-library-state", "digest": "<the relayed digest>",
  "packages": [{ "packageId": "…", "release": "1.3.0", "sha256": "…", "state": "installed" }] }
```

Main checks each entry on its own (a bad one is dropped, at most 100) and
ignores a snapshot whose digest it did not relay for this enrollment.

## Install reports

Main posts the newest snapshot to `POST /api/desktop/library/report`
(`{libraryVersion, digest, appVersion, packages}`, at most 64 KiB). Admin shows
only counts. `reason` is one of a fixed list; no free text, paths or error
messages leave the desktop. A report goes:

1. after the runtime processed a newly applied catalog (its first snapshot);
2. after any change to what this desktop added (the runtime sends a snapshot);
3. once per app start, after the first successful session sync;
4. after a failed post, again on the next sync until one gets through.

Main waits 5 s after a snapshot arrives and sends only the newest one.

## Compatibility

| Desktop \ Admin | Admin without `capabilities.library` | Admin with it |
|---|---|---|
| OpenMausBot before this channel | as before | ignores the pointer, stays connected |
| OpenMausBot with it | no library request, no shelf; file import and export work | the shelf |
| No organization account | as before | — |

This channel and the runtime's handler for `openmausbot:managed-library`
(`server/org-library.ts`) ship in the same release. A runtime without that
handler never acknowledges, so main would relay again on every sync and wait
out the 15 s timeout each time.

How this is tested: [verification/desktop-library.md](verification/desktop-library.md).
