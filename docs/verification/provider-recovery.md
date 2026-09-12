# Provider images, authentication and thread approvals

Every command below uses a disposable home. No real account, API key,
provider charge, deployment, or running OpenMausBot workspace is involved.

## Real CLI transport checks

Pass the path to an already installed CLI. These checks never update it.

```sh
node --experimental-strip-types scripts/verify-grok-images.ts /absolute/path/to/grok
node --experimental-strip-types scripts/verify-claude-auth-settings.ts /absolute/path/to/claude
node --experimental-strip-types scripts/verify-claude-auth-settings.ts /absolute/path/to/claude --api-key
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

These prove transport/auth integration, not hosted image interpretation,
subscription entitlement, Console-profile availability, or production API
uptime. If Claude still reports signed out, compare its `/status` Profile
and the account selected in OMB; never request the user's keys or tokens.

## Isolated server and real UI

```sh
pnpm exec electron scripts/smoke-approval-modes.cjs --ui
```

The real server runs under Electron's private utility-process channel with
fake Claude, Codex, Grok and Antigravity providers. Assertions cover:

- Changing a bot's default to Full leaves existing Ask threads unchanged.
- Explicitly applying that approved default changes only the selected thread.
- Direct HTTP elevation, unknown threads, unapproved defaults and threads
  using a different provider are rejected.
- The updated conversation uses the provider's native Full mode; unrelated
  conversations remain Ask. Delegation never borrows the sender's authority.
- Auto-accept edits works only for providers that implement that mode.
- The real composer opens a scoped warning with Cancel focused. Cancel does
  not send a grant; confirmation changes server state through the private
  channel and updates the composer through SSE. A subsequent message completes.
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
