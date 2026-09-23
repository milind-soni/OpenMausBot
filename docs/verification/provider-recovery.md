# Provider images, authentication and thread approvals

Every command below uses a disposable home. No real account, API key,
provider charge, deployment, or running OpenMausBot workspace is involved.

## Real CLI transport checks

Pass the path to an already installed CLI. These checks never update it.

```sh
node --experimental-strip-types scripts/verify-grok-images.ts /absolute/path/to/grok
node --experimental-strip-types scripts/verify-claude-auth-settings.ts /absolute/path/to/claude
node --experimental-strip-types scripts/verify-claude-auth-settings.ts /absolute/path/to/claude --api-key
node --experimental-strip-types scripts/verify-opencode-permissions.ts /absolute/path/to/opencode
```

- Grok must deliver the **exact** synthetic PNG bytes to a loopback model.
  Grok 1.0.25 advertises `image:false` despite accepting native ACP image
  blocks. OMB enables that verified compatibility path only for official
  1.0.x runtimes from 1.0.25 onward; other runtimes must negotiate image
  input normally. The fixture uses a valid 32×32 PNG because Grok rejects
  images below 8 pixels per axis or 512 total pixels.
- Claude must complete **two** turns using the selected account's personal
  `apiKeyHelper`, and again with `settings.json`'s API key. All authenticated
  model requests go to the fake local Anthropic endpoint. An unrelated
  personal SessionStart hook must not run. OMB retains project settings but
  projects only account authentication from personal settings. Explicit OMB
  credentials/endpoints take precedence as a pair.
- OpenCode must actually read a synthetic file **outside** its workspace in
  Full mode without a permission request. The same native session resumes in
  Ask, where denying the request prevents the read, then resumes in Full and
  reads it again. Only the spawned turn receives the native permission
  override; personal/project configuration is not rewritten. Verified with
  OpenCode 1.18.27 on macOS; this does not prove Windows filesystem ACLs or
  third-party plugins and custom agent policies.
  The same fixture then returns one HTTP 400 from the local model endpoint.
  The failed turn must finish once, and an explicit next message must read the
  receipt successfully in the same native session. No failed prompt is
  automatically replayed.

These prove transport/auth integration, not hosted image interpretation,
subscription entitlement, Console-profile availability, or production API
uptime. If Claude still reports signed out, compare its `/status` Profile
and the account selected in OMB; never request the user's keys or tokens.

## ACP internal-error recovery

```sh
pnpm exec vitest run server/drivers/acp/acp.test.ts server/acp-recovery.e2e.test.ts server/resume-recovery.test.ts server/delta-context.test.ts server/incidents.e2e.test.ts server/room-coordination.e2e.test.ts
```

The ACP transport fixture injects an internal RPC error, including one after
partial output. The failed turn completes once without automatically resending
it. The failed process is retired; a subsequent explicit turn resumes the durable
session on a fresh process and can complete in the same OMB thread. Where a
native session can no longer be loaded, the replacement receives the canonical
conversation history rather than only the latest message.

The server-level fixture uses a disposable verification workspace and the fake
ACP executable. It checks that an RPC failure releases the busy state, preserves
the thread's transcript, and allows another message without deleting the bot or
thread. The incident and coordination fixtures separately check Chief retries
and failed peer completion.

These checks establish recovery behavior, not the cause of a particular user's
provider outage. OpenCode's generic `-32603` service error can cover directory,
configuration, session, or upstream API failures. Its presence alone does not
prove that a working-folder path is wrong, and restarting cannot repair a
persistently invalid account or provider configuration.

## Isolated server and real UI

```sh
pnpm exec electron scripts/smoke-approval-modes.cjs --ui
```

The real server runs under Electron's private utility-process channel with
fake Claude, Codex, Grok and Antigravity providers. Assertions cover:

- Changing a bot's default to Full leaves existing Ask threads unchanged.
- Explicitly applying that approved default changes only the selected thread.
- The composer also grants Full directly to an Ask thread without changing the
  bot default or visiting Settings. Its private request pins the thread and
  waits for an actual commit acknowledgment before a queued send can proceed.
- Custom is available for Codex threads, even when the bot default uses another
  provider. Returning to Ask uses the same private scoped path.
- Direct HTTP elevation and unknown threads are rejected. The legacy
  apply-bot-default operation still checks that default/provider; the composer
  checks the selected thread's own provider instead.
- The updated conversation uses the provider's native Full mode; unrelated
  conversations remain Ask. Delegation never borrows the sender's authority.
- Auto-accept edits works only for providers that implement that mode.
- The real composer approval menu exposes Full without a separate shortcut
  or settings link. It opens a scoped warning with Cancel focused. Cancel does
  not send a grant; confirmation changes server state through the private
  channel and updates the composer. The bot default remains Ask, and a
  subsequent message completes.
- At 390px the new control and confirmation remain usable. The provider
  safety error explains the restriction and does not offer Retry.

For a UI-only rerun use `--ui-only` instead of `--ui`. Screenshots are written
to `.omb-scratch/verify-evidence/provider-fixes/`. The fixture exits and removes
its own disposable server/browser data; the screenshots remain.

## Regression checks

```sh
pnpm exec vitest run server/drivers/acp/acp.test.ts server/drivers/claude.test.ts server/drivers/claude-auth.test.ts server/drivers/codex.test.ts server/drivers/retry.test.ts server/store.test.ts src/components/ChatView.controls.test.ts
node --test electron/approval-trusted-mode.node-test.mjs
pnpm typecheck
pnpm lint
```

The tests also cover image-byte redaction, unknown ACP runtimes, private
authentication-file permissions and cleanup, explicit credential precedence,
authentication rotation on retained sessions, crash recovery at every grant
phase, and safety failures delivered as RPC errors or completion events.

Codex safety monitoring is independent of tool approval settings. This change
preserves the actual provider error, prevents automatic replay, and explains
the distinction; it does **not** bypass provider safety or claim to fix an
unseen deployment refusal. See the [official Codex safety guidance](https://learn.chatgpt.com/docs/agent-approvals-security#safety-monitoring-and-paused-tasks).

Grok's upstream image ingestion is in [its ACP prompt builder](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/session/acp_session_impl/prompt_build.rs).
Claude's account settings are documented in [Claude Code settings](https://code.claude.com/docs/en/settings).
