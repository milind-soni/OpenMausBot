# ChatGPT plan sign-in

The **ChatGPT plan** account in Settings → Engines is separate from the legacy
Codex login and Company models. Choose **Continue with ChatGPT**, authorize plan
usage, then select a model from that account's refreshed catalog. The model slug
is preserved exactly, including `gpt-6.1-sol` when OpenAI returns it. This does
not migrate existing bots or silently switch their billing. Add another named
ChatGPT account to use another identity; signing out retains its registration.

The desktop implements OpenAI's [local open-source flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in):
loopback callback, state, nonce, PKCE, verified ID-token signatures, issued client
IDs, explicit plan-usage consent, account-specific models, rotating refresh
tokens, and revocation. It reuses the documented
[Codex app-server bridge](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
Access tokens enter only the child environment, not command arguments; shell
tools exclude that variable. Every turn starts a new app-server with the current
access token, and resume reasserts the selected model/provider. Only a completed
native turn counts as success.

Credentials live in private `providers/chatgpt-plan/<account-hash>/` directories
under the app data directory, with atomic owner-only files. Portable backups and
Move to Cloud exclude these provider homes. No Codex credentials or personal
configuration are read or overwritten. A cross-process lock prevents concurrent
refresh-token reuse. If a process dies while holding that lock, the safe recovery
is to stop the old process, confirm it has exited, and remove only that account's
`.credentials.lock` before reconnecting. We do not guess that a live lock is stale.

## Hosted Pro boundary

The local callback is not a hosted OAuth redirect. Hosted Pro and managed company
workspaces explicitly report the integration unavailable; a proxied/remote request
cannot start a local flow. OpenAI's [hosted-app approval](https://openai.com/form/sign-in-with-chatgpt-interest/)
and issued client/callback contract are required before implementing and enabling
the hosted route. Do not use the dynamic local client in a paid hosted service,
copy a desktop token to Pro, or silently use API billing. Existing separately
configured providers remain unchanged.

## Verification

```sh
pnpm exec vitest run server/drivers/chatgpt-plan-auth.test.ts server/drivers/codex.test.ts server/chatgpt-plan-api.test.ts
pnpm exec vitest run src/components/ChatGptPlanSignIn.interaction.test.ts src/components/CodexDeviceSignIn.test.ts src/components/CodexAccountSettings.test.ts src/components/EngineSetup.test.ts src/components/ModelPicker.interaction.test.ts src/components/ChatView.controls.test.ts
pnpm typecheck
pnpm i18n:check
PROBE_CODEX=/path/to/codex node --experimental-strip-types scripts/verify-chatgpt-plan.mjs
```

All fixtures use temporary homes and synthetic identities/endpoints; none require
a real subscription or modify the user's running app. OAuth tests exercise a real
loopback listener and signed synthetic JWTs, rejection of invalid callbacks and
identities, denied consent, cancellation, replay, refresh rotation across separate
processes, and remote revocation. HTTP tests launch the real server with fake
engines and check named account creation, per-admin flow ownership, cancellation,
remote refusal, and absence of authorization URLs/tokens from public snapshots.

The native probe uses the installed Codex binary with a temporary home and a
loopback Responses endpoint. On Codex 0.159.0, fresh and resumed `gpt-6.1-sol`
turns completed with bearer authorization, `store:false`, `stream:true`, array
input, and no `tool_search`. These are transport/protocol checks, **not** evidence
that a real account has model entitlement or that hosted access is approved.

Before announcing production availability, complete one real desktop consent
flow with the account owner and a short model reply. No real sign-in or paid
inference was performed during this implementation.
