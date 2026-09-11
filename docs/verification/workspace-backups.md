# Full workspace backups

## User path

Settings → Backups → **Export full backup** → password and confirmation →
encrypted `.ombbackup` download. Import uses a native file input, password,
validated preview and an explicit **REPLACE** confirmation. It is replacement,
not an additive team import. The desktop must fully quit and reopen; a hosted
server must restart. No restore writes into a running Store.

The previous workspace is retained under `.backups/safety-<restore-id>/data`.
Keep this copy until the restored workspace is checked. Do not publish it.
The downloaded archive is encrypted; private staging and safety directories
are not. They contain private workspace data and require normal host/disk
protection. The latest successful restore's staging is retained for recovery.

Saved account credentials and connections are not transferred. Reconnect on a
new machine; existing credentials and connections on the destination remain
unchanged. Conversations, drafts and user files are not automatically redacted
and may still contain pasted secrets, so the archive must remain private.

## Launch and drive

```sh
node --experimental-strip-types scripts/verify-workspace-backup.ts
```

This recipe accepts no live URL. It launches two owned fake-engine servers with
temporary data and homes, creates a real conversation, profile, memory, reviewed
skill and attachment, exports via the real HTTP route, uploads to the second
workspace, validates and confirms replacement, then restarts that exact fixture.
It compares original IDs, history, attachment bytes and app-managed paths, saved
non-secret settings, credential exclusion and destination preservation,
browser-state allowlisting, and the automatic safety copy. It sends a new turn
through the restored conversation. Wrong passwords, wrong confirmation,
non-admin access and post-confirmation writes are rejected.

Keep its JSON output and the reported persistent log/evidence paths. The
permanent version is:

```sh
pnpm exec vitest run server/workspace-backup-workflow.test.ts --silent=false
```

## Additional checks

```sh
pnpm exec vitest run server/workspace-backup.test.ts \
  server/workspace-backup-policy.test.ts \
  server/workspace-backup-http.test.ts \
  server/workspace-backup-maintenance.test.ts \
  server/webhook-ingress.test.ts server/request-auth.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/workspace-backup-ui.e2e.test.ts
```

The archive tests cover authenticated encryption, damaged/wrong-password files,
path traversal, links and duplicate entries, SQLite WAL rows, modified staging,
cross-directory path repair, interrupted replacement, credential exclusion,
destination credential preservation and recovery. The maintenance checks keep
ordinary requests, turns, schedulers and the separate webhook receiver from
writing during a snapshot.
Unknown external writers cannot be frozen: users must stop external editors and
managed desktops before exporting.

All tests use disposable workspaces and synthetic credential values, never the
user's keychain or live sign-ins. The renderer recipe drives the real Settings
screen in an isolated Chromium fixture with simulated backup endpoints; it checks the native
file input, password errors, preview and confirmation. Actual archive and restart
behavior is proved separately by the two-server recipe above.

## Limits and cleanup

Backups include this workspace's durable files and complete message records—not
saved account credentials/connections, remote VM disks, other workspaces, external
project files, external CLI/browser login homes, or live device sessions. The
10 GB and 100,000-entry limits fail visibly. Scheduled routines/webhooks are paused and
unfinished work is not replayed after restore. Known temporary sockets, leases,
tool downloads and caches are excluded; unknown special files are rejected.
If a configured provider login home is inside ordinary workspace files rather
than the excluded `providers/` directory, export and restore refuse to proceed
until that login storage is moved outside the backed-up files.

Both recipes stop only their owned processes and remove only their temporary
workspaces. Evidence logs remain. These tests do not prove real cloud accounts,
external providers, phone recovery or OS-specific file-picker appearance. Saved
credentials are deliberately not transferred. No live mutation is part of this
recipe.
