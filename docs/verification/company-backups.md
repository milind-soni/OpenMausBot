# Company cloud backups

## Execution status

2026-09-15: Company backups now generate a random key in Electron and store it
wrapped by Admin. Restore uses the owner-authenticated native response, without
a renderer password. Manual file export remains password-encrypted. Legacy
cloud archives without a stored key still request their original password.
The passwordless fixture also exercises opt-in daily backups and exact restart
recovery. Keys are excluded from renderer results, lists and progress events.
Passing receipt: `omb-company-backup-ui-9VYfby/receipt.json` in the system temp
directory. Screenshots of upload consent and narrow preview were reviewed;
the fixture cleaned up its temporary runtime and profile. Native regressions
passed 111 tests; the three Settings test files passed 63 tests. Cross-repo
real-Admin enrollment/upload/preview passed separately in
`/tmp/omb-desktop-integration-qiFHPi/receipt.json` using fake storage and inference.

The final real-Electron run, including the state/list-failure UI fix, has a passing
`receipt.json` in the printed evidence directory.
It transferred a 96,316-byte encrypted archive, made two create requests, one
confirmed cloud deletion, and one typed **REPLACE** request. The receipt records
the exact owned runtime restart, restored snapshot IDs, removal of a later
fixture bot, retained safety copy, existing draft recovery, and absence of the
company-backup preload bridge on a remote-origin page.

The run also checked native Escape dismissal, allowlisted client-state input,
absence of the password from local storage, and the recovery marker inside the
fixture IPC handler before committing replacement. The
`cleanup.json` in the printed evidence directory
confirms removal of the owned fixture and profile.

Screenshot review is complete: desktop upload confirmation, progress and list;
390px list, preview, typed **REPLACE** and restart guidance; and the recovered
view. The reviewed states have readable warnings and actions with no horizontal
clipping. This remains one small real archive part against synthetic loopback
storage, with the production-integration limits below.

## Run

From the repository with its dependencies, including Electron, installed:

```sh
node scripts/verify-company-backups.mjs
```

The script accepts no external URL. It creates its own loopback renderer,
fake-engine workspace, synthetic Admin and object-storage endpoints, temporary
home, and Electron profile. Linux requires a graphical session, or run the
command through `xvfb-run -a`.

Do not substitute the user's app, workspace, company account, saved connection,
browser profile, or storage bucket. All test messages, files, credentials, and
passwords must be synthetic. The only replacement and restart in this recipe
belong to the fixture's disposable workspace.

## What is real and what is substituted

The fixture uses real Electron, the production `electron/preload.cjs`, the
`CompanyBackupSettings` renderer, and the native `company-backups.mjs` transfer
module. It mounts the standalone backup panel, not the entire Settings shell.
Export, encrypted archive download, local upload, validated preview,
typed replacement, and restart use the real local workspace-backup service
running with the repository's fake engine.

The Admin API, multipart signing responses, and object storage are synthetic
loopback services, not Cloudflare R2. Loopback storage is enabled only through
the transfer module's explicit test option. Company connection state is held
in memory, and IPC handlers use substituted fixture-main wiring. They do not
run the full production Electron main-process enrollment, authorization, or
keychain path.
Loading the production preload does not by itself verify those substituted
handlers.

## Acceptance checks

Keep the action and resulting state for each check in the receipt:

- The real company-backup panel is absent without an eligible local company
  connection and its cloud-backup capability. Merely opening the panel does not
  upload anything. Remote surfaces must not obtain the local company-backup
  controls.
- **Back up this workspace** opens an explicit upload warning with no password
  input. Only allowlisted browser preferences accompany the real encrypted
  export; the automatically generated key never enters browser storage.
- The production native transfer uploads the encrypted archive to the
  synthetic multipart endpoint. Progress is visible, and a completed snapshot
  appears with its date and storage usage. Pending uploads are not offered as
  restorable snapshots.
- Passwordless restore never requests a password. Native regression tests cover
  legacy password archives and refusal of missing service-managed keys.
- Deletion requires exact **DELETE** for the displayed cloud snapshot. Only
  that archive is deleted; the current workspace is not a cloud-delete target.
- Restore first downloads and checks the encrypted archive, stages it locally,
  and shows the real validated summary. It must not replace anything during
  download, upload, or preview. Only exact **REPLACE** enables replacement.
- The initiating renderer saves the staged restore ID in its recovery marker
  before requesting replacement. Reopening the panel while replacement is
  staged shows restart instructions and does not offer another backup action.
- Restart the exact owned fixture server. The existing recovery flow restores
  allowlisted drafts for the matching marker and clears it after recovery;
  unrelated browser credentials and preferences are not imported from the
  archive. Confirm restored workspace content through the real local service.
- Retain screenshots of the relevant desktop and 390px-wide states, including
  confirmations, progress or the completed list, and restore preview/restart
  guidance. Inspect them for clipping and horizontal overflow; screenshots
  alone do not establish request ordering or data integrity.

## Evidence and cleanup

Keep the completed JSON receipt, the exact command, and the evidence directory
and log paths printed by the script. Receipts and screenshots remain after
cleanup. Report failures or missing checks explicitly; a process exit or a
green unit suite alone is not a complete desktop-workflow result.

The fixture must stop only the Electron/server processes it launched and
remove only its own `mkdtemp` home, profile, transfer cache, and workspace
directories. Interrupt this fixture, not a process selected by application
name. Never delete a broad temporary root or restart the user's server. The
retained evidence is separate from disposable workspace data.

## Additional regressions and limits

```sh
node --test electron/company-backups.node-test.mjs
pnpm exec vitest run src/components/CompanyBackupSettings.test.ts src/components/WorkspaceBackupSettings.test.ts src/components/OrganizationSettings.test.ts
```

The native unit fixtures additionally cover bounded responses, unsafe storage
URLs and redirects, checksum/size failures before local upload, cancellation,
disk-space reservations, private cleanup, and a streamed 64 MiB-plus-remainder
multipart transfer. Renderer unit fixtures cover stale responses, confirmation
guards, recovery markers, and native-dialog event callbacks. They are not
substitutes for the Electron receipt or a real focus/layout check.

See [full workspace backups](workspace-backups.md) for the separate two-server
archive, credential-exclusion, safety-copy, and restart verification.

This recipe does **not** prove a real company account, Admin authentication or
owner isolation, OS keychain persistence, full production main-process wiring,
live provider calls, public DNS/TLS, R2 signing/permissions/retention, or cloud
service availability. It does not exercise a 10 GiB archive or demonstrate
production-scale multipart throughput, memory use, or disk exhaustion. Do not
describe loopback object storage as an actual R2 upload or this in-memory
connection as a real company sign-in.
