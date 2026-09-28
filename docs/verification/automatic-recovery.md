# Automatic recovery

Settings → General → Automatic recovery is off by default. Choose one backup
engine/model and save. When an ACP engine fails during startup, before sending
the prompt or receiving any tool, permission, file or assistant activity, the
driver can report a recoverable failure **only after its process has stopped**.
OMB tries the backup once in the same thread with the canonical conversation.
The thread keeps the backup selection; bot defaults and sibling threads do not
change. A visible activity line explains the switch.

Direct bot threads, Chief and direct coordinated work use this path. Channels
and drivers without the startup-proof contract do not. Credential-card
continuations are excluded. This is not recovery from an accepted prompt that
has gone silent: even without output, the engine might have performed actions.
No automatic replay follows authentication, quota, invalid-model, safety or
approval failures, a failed backup, Stop, or newer queued input.

Existing approval, organisation-model and spend-limit gates run again. An
engine switch requiring a new Full/Custom grant is refused, not downgraded or
auto-approved. The backup must retain the source engine's tools/attachments
and use the same pinned working folder; legacy unpinned threads and remote
runner changes require a manual choice. Backup provider charges may apply.

## Repeatable checks

```sh
pnpm exec vitest run server/automatic-recovery.test.ts server/automatic-recovery.e2e.test.ts server/drivers/acp/acp.test.ts server/drivers/retry.test.ts server/turn-dispatch-guard.test.ts server/config.test.ts src/components/AutomaticRecoverySettings.test.ts src/state/store.test.ts
pnpm exec vitest run server/direct-coordination.e2e.test.ts server/guarded-messages-api.test.ts server/acp-recovery.e2e.test.ts --maxWorkers=2
pnpm typecheck
pnpm lint
pnpm i18n:check
```

The recovery integration suite launches `launchVerificationServer` in a
temporary home, then configures only fake ACP and Claude engines there. It
checks one backup dispatch, retained history, one user message, unchanged
permissions/defaults/siblings, bounded failure, no replay after prompt/output,
Stop/new-message precedence and settings validation. A coordinated specialist
recovers through the real agents proxy and returns one result and one final
Chief reply. Each fixture prints a
retained `.log.automatic-recovery.json` evidence path, then removes its own
temporary data and processes. No live app, provider account or user data is
used. Driver tests also cover failed cleanup and pre-prompt file/tool activity.

Settings tests cover the real component's controls, drafts, validation and
save errors. These are not an Electron visual walkthrough or proof of a real
provider's availability, model quality, or a general cure for idle timeouts.
