# Copy this computer here

One action in the desktop app copies this computer's workspace to a server the
person owns and added in the app: a VPS or home server running `openmausbot
serve`, a `service install`, Docker or Podman install, another desktop reached
through its Remote access, or their OMB Cloud. Every destination goes through
the same code (`electron/cloud-move.mjs` on the desktop,
`server/cloud-move-http.ts` and `server/cloud-move.ts` on the receiving
server). The Cloud adds only what a plan has: an Admin that can sign the app in
without a session, and a disk that can grow (docs/cloud-pro.md, "Copy this
computer to your Cloud").

It is a copy; nothing on the computer changes. Chat history travels between
machines here, and only here, because the person asked for it. Secrets never
travel. Settings → Backups export and import stays, for disaster recovery and
for servers with no desktop app nearby.

The names still say "cloud" (`/api/cloud-move`, `.backups/cloud-move`,
`.backups/cloud-previous`, `cloud-move-restores.json`, the `cloudMove` bridge
and its `cloudMove.*` strings): Clouds already running answer on those routes
and keep their swap back in those folders.

## Where it is

- **Right after adding a server.** After **Connect** in Settings → Servers, the
  app opens the server's own page. If the server is empty (its starter bot at
  most, no rooms, nobody has chatted), this computer has work of its own, the
  copy fits, and nothing blocks it (below), the page shows a card: **Bring your
  bots and chats from this Mac** ("this computer" elsewhere), with **Copy** and
  **Not now**. Not now hides it for that server for good. A server added
  earlier shows it the next time it is opened, while it is still empty. On an
  OMB Cloud whose setup checklist is up, the same offer is the checklist's
  second step instead (docs/cloud-pro.md). **Copy** there switches the window
  to this computer, on Settings → Servers with that server's panel open, and
  the person starts the copy there (Security, below); on the person's own
  OMB Cloud, verified through the Admin, it starts the copy at once.
- **Settings → Servers → Copy this computer here**, on every saved server's
  row (not This computer), and **Settings → OpenMausBot Cloud** under My Cloud once
  it is Ready. Both open the same panel: the size and counts
  (`GET /api/cloud-move/estimate` on this computer's own server), that API keys
  and sign-ins stay on this computer, and **Copy to {server}**. When the server
  already has bots or chats, the button reads **Replace {server} with this
  computer's bots and chats**, and the panel says that what it holds is
  replaced, backed up on it first, and put back by **Swap {server} back**. When
  it already keeps a backup for Swap back (an earlier copy), the panel says
  that copying again backs up what it has now in that backup's place and
  deletes the one from {date}, and the button reads **Replace {server} and
  delete its {date} backup**. There is no confirmation dialog.
- **Settings → Backups → Import from this computer**, on a server open in the
  desktop app, beside importing a file. It is the same offer, the same states
  and messages as the card, and its **Copy** opens the same panel on this
  computer, whether the server is empty or not. It is hidden in a browser, on
  this computer's own server, and on a server shared with other people.

After a copy the app opens the server it went to, and its page says what came
and what does not run there yet (routines arrive paused; the phone stays
paired with this computer), until **Done**.

## Every state, one message

`moveView` (`src/components/CloudMove.tsx`) is the only mapping from a copy's
state to what the person sees: one sentence and one next step. A reason a copy
cannot start (`moveBlocked`, which the engine also applies before exporting)
and a copy that failed for that reason share one code, so they read and act
the same.

| State | Message | Next step |
|---|---|---|
| Ready | (size, what stays here) | Copy to {server} / Replace {server}… |
| Running | Uploading to {server}… and so on, with bytes | Stop the copy (until it starts replacing) |
| Done | Copied to {server}: N bots and M chats… | Done |
| Ready, on the server's own page | (what comes, its size, what stays here) | Copy: opens this computer's panel for it (the verified Cloud's starts the copy) |
| Not signed in as the owner (client-scope pairing) | This app isn't signed in to {server} as its owner. Pair it again with an owner code (`openmausbot pair`), then copy. | Open {server} |
| Shared with other people | {server} is shared with other people, so it can't receive this computer's bots and chats. Copy to a server only you use. | none |
| This computer's own server | {server} is this computer's own server. | none |
| Older than this computer (`outdated`) | {server} runs X; this computer runs Y. Update {server}, then copy again. | Check again |
| From before any server could receive one | Update OpenMausBot on {server}, then copy again. | Check again |
| Not answering | {server} didn't answer. Check that it's running, then try again. | Check again |
| A copy elsewhere is running | A copy to {other} is running. Wait for it to finish. | none |
| The Cloud has work, on its own page | My Cloud already has bots and chats of its own… open Settings → Servers in this computer's window… | none |
| A proxy refuses even 512 KB parts (`proxy_limit`) | A proxy in front of {server} refused a 512 KB upload. Raise its request size limit (nginx: client_max_body_size 64m), then copy again. | Continue the copy |
| Not back after the restart | {server} hasn't come back yet. If it doesn't start again on its own, start OpenMausBot there; it finishes installing the copy when it starts. | Open {server} |
| Other failures | what happened | Copy again / Continue the copy |

## What moves, and what stays

Exactly what a workspace backup carries (`server/workspace-backup.ts`,
`server/workspace-backup-policy.ts`). Never: API keys, provider and MCP
connections, engine sign-ins (`~/.claude`, `~/.codex`, the server's
`providers/`), saved credentials, pairing, paired devices and sessions (the
session registry's open marker included), the server's identity, caches,
downloaded tools and runtime files. Never this app's Cloud sign-in or what it
lends: both live in the desktop app's own storage. Unsent drafts and window
preferences stay on the computer.

The destination keeps its own: every connection section of its config (engine
and API keys, relays, sign-in allow-lists), its sessions and pairing, its engine
sign-ins, its computer-sharing switch, and its environment. As with any restore,
routines, webhooks and scheduled calls arrive paused and nothing queued runs. A
bot that used an engine or key the destination does not have asks for one
there; a bot pointed at a project folder outside the workspace keeps that path.

## How it copies

1. **Main proves the owner there**, with one `grant()` per destination, and
   opens a session of its own:
   - OMB Cloud: the Admin opens a single-use pairing window for the signed-in
     owner (`pairHome`), so this works before the Cloud was ever opened here.
   - Any other server: the window's own session there (the cookie its `/pair`
     page set, read through Chromium's cookie jar) must be a signed-in session
     with admin scope (`GET /api/auth/session`); it mints one single-use owner
     code (`POST /api/auth/pairing {scopes: ["admin", "client"]}` with the
     server's own Origin, `mintOwnerCode`).

   The grant must name the destination's own origin. Main redeems the code at
   `/api/auth/pair` for a bearer token held only in memory, labelled "Copy from
   desktop", and signs that session out when the copy ends. The window's cookie is
   never the copy's credential: signing that out would sign the window out.
2. **Refused before anything is exported**: a server that answers 404 (from
   before, `outdated`), a shared one (403 `shared_workspace`), and, by
   `moveBlocked` as Settings shows it, this computer's own server (the same
   `environmentId`) and a server older than this computer (`outdated`, by the
   `appVersion` rule staging uses: it would refuse a newer backup only after
   the whole upload); then a busy one, one without room, and, from the
   verified Cloud's own page, a Cloud that has work (`not_empty`).
3. The computer's server exports its encrypted backup with a random password,
   under the usual rule that bots finish their turns first, and main copies it
   to a private temporary file, hashing it.
4. `POST /api/cloud-move/upload {sha256, bytes, files}`: at most 10 GB of data
   or 100,000 files (`413`); room for the upload three times over (the upload,
   its decrypted copy, its staged files), plus twice the server's own workspace
   (the backup it takes first), plus 256 MB (`507` with `freeBytes` and
   `neededBytes` otherwise). A part stored by an earlier upload counts as free.
5. Parts of 16 MB (at most 64): `PUT /api/cloud-move/upload/<sha256>?offset=n`.
   A part already stored is accepted again without being written; any other
   offset answers `409` with `received`. Main retries with backoff and
   continues from where the server stands. The server never answers a part
   `413` (a part over its limit gets `411`), so a `413` is a proxy in front of
   it (nginx allows 1 MB by default): parts halve, down to 512 KB, and a proxy
   that refuses even that ends the copy with `proxy_limit`, naming the size
   and the setting to raise. A failed upload keeps its archive
   for 30 minutes, so copying again continues it; the server keeps a stored part
   for a day.
6. `POST /api/cloud-move/preview {sha256, password}`: the server checks the
   SHA-256 and stages it as an ordinary backup, which authenticates the whole
   file before parsing anything.
7. `POST /api/cloud-move/restore {id}`, inside the maintenance gate: the
   server's workspace is backed up first (Swap back), the restore is committed,
   and the server exits with code 75 (below). Startup installs the restore
   before anything else loads. Preview, restore and undo answer `202` and run as
   jobs the app follows in `GET /api/cloud-move`.
8. Main waits until the server reports that restore installed
   (`lastRestoreId`), signs its session out, and opens the server in the window.

Stopping before step 7, or any failure before it, asks the server to drop what
the copy staged (`POST /api/cloud-move/discard`). A stored upload part stays.

## Swap back

Before a copy replaces a server's workspace, that workspace is backed up to
`.backups/cloud-previous` on the server's own disk, which no backup includes
and no restore replaces; its random password is kept beside it. It is offered
as **Swap {server} back** in this computer's Settings unless it is a fresh
server's. Swapping back (`POST /api/cloud-move/undo`) is the same restore the
other way round: what the server has now becomes the one to swap back to, so a
swap back can itself be swapped back. Copying again replaces that archive
with a backup of what the server has then, so what it held before the earlier
copy is deleted; the panel says so, with the date, before the copy starts.
That archive is the one undo point kept:
startup on every server deletes a copy's safety copy and staged files once its
restore is installed (`tidyCloudMoveStorage`, which touches only restores a copy
recorded). A restore made from Settings → Backups keeps its safety copy.

## Restart, per launcher

`server/restart.ts` holds the one code, `RESTART_EXIT_CODE = 75` ("start me
again"), and the one rule every launcher asks, `restartPolicy().again(code,
stopping)`: start the server again on 75 only, at most 5 times in a row (a run
that stays up a minute resets the count).

| Launcher | On exit 75 |
|---|---|
| OMB Cloud (`server/cloud-home-start.ts`) | starts only the server again |
| The desktop app's own server (`electron/server-supervisor.mjs`) | starts it again after any exit |
| `openmausbot serve` / `npx openmausbot` in a terminal (`serveUntilStopped`, `server/cli.ts`) | runs `serve` again in the same process, without a new pairing code or browser tab; a tunnel, Tailscale or domain address stays the same |
| systemd `service install`, fleet, launchd | they run `openmausbot serve`, so the same loop |
| Docker (`Dockerfile`), Podman (`deploy/podman/Containerfile`) | `node dist-server/server-launcher.js` (`server/server-launcher.ts`) starts `index.js` again and passes SIGTERM on, so the container, and a Caddy sharing its network, never goes down |
| Anything else (`node dist-server/index.js` by hand, a custom manager) | stays down; the restore is committed and installs at the next start |

The app waits 10 minutes for the server to come back, then says so with
**Open {server}**.

## Security

Everything a self-hosted server says about itself is its own word: that this
app's session there is an owner's (`/api/auth/session`), the pairing code it
mints, that it is empty, its version and identity. A server someone else runs
(a colleague's, joined with a client code, or a modified one) could say all of
it. So that word decides only what the person is shown, never whether this
computer's work is sent:

- **Only this computer's own window starts a copy to a server.** This
  computer's page names a saved server by id (or "cloud") and starts it
  there. A server's own page names nothing and is answered about itself only,
  while it is the window's active server in the main window's main frame
  (`moveSenderDestination`); its **Copy** (only from the person's click,
  `navigator.userActivation`) makes main switch the window to this computer,
  on Settings → Servers with that server's panel open
  (`openWorkspaceSettings(id, "copy")`), and sends nothing. The person starts
  the copy there, with the server named, its size, and what it replaces. That
  is the app's own Settings, not an approval prompt. Apart from the verified
  Cloud (below), no page can start sending this computer's workspace. What is
  left: the person can still choose, in this computer's Settings, to copy to a
  server someone else controls; the panel names it, below its row and address.
- **The person's own OMB Cloud is the one exception.** This app verifies it
  through the Admin with the person's OMB Cloud sign-in, independently of the
  Cloud's word (`cloudPageSenderAllowed`: the Admin's origin, open as the
  window's active server), so its card and setup checklist start the copy at
  once, and only into an empty Cloud (`requireEmpty`, `not_empty` before
  exporting). Replace and Swap back stay in this computer's Settings.
- **Owner session there.** Main signs in to the destination with a code its
  owner session there mints (the Cloud's Admin, for the Cloud). Every
  receiving route needs a paired session with admin scope; a client-scope
  device and a bare loopback request are refused. This keeps other people on
  that server out; it does not vouch for the server.
- **What a server's page learns.** Asking about itself, a server's page gets
  this computer's counts and size (bots, rooms, chats, bytes, routines) to show
  on its card, never this computer's environment id or anything it holds.
- **Never a shared workspace.** A hosted organisation workspace, or a
  self-hosted server whose email sign-in lets someone besides its owner in (a
  member, a second admin address, or a whole `@domain`: `sharedSignIn`,
  `workspaceShared`), refuses every receiving route (403
  `shared_workspace`): a replace would wipe their work. The owner's own address
  alone (`openmausbot access add you@example.com`, to sign in from a browser)
  is not shared.
- The upload is bounded by its declared size, the per-part limit and the
  backup's own limits. The bundle is the workspace backup: credentials are left
  out by path and by a config allowlist, and checked again at staging.
  `server/cloud-move.e2e.test.ts` gives the desktop keys, a driver environment,
  workspace credentials and a provider login, copies it to a real Cloud and a
  real self-hosted server, and scans every file on their volumes.
- Nothing logs a request body, the password, a file name or bundle contents.

## Not covered yet

- The copy uses Node's `fetch` in main, not the window's session: a server
  behind a system proxy or an enterprise CA can work in the window but fail the
  copy with "could not reach".
- The version check refuses even a patch-newer desktop (staging's rule): update
  the server first.
- Not run by hand: the launchd throttle, Podman, Windows Task Scheduler.
- A proxy that drops the connection on a large part instead of answering 413
  looks like a dropped connection: the copy retries the part, then says the
  upload kept failing.
