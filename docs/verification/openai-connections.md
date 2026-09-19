# Independent OpenAI-compatible connections

Run the real connection manager against an isolated app server and a local fake
OpenAI-compatible provider. The fixture creates its own disposable home and a
hidden Electron renderer. It never uses the installed app, real credentials, or
paid provider calls.

```sh
node --experimental-strip-types scripts/verify-openai-connections.ts
```

The fixture verifies authenticated and keyless connection creation, separate
catalog/response checks, endpoint changes requiring a new key, rejected saves
preserving the draft, edits, choosing both keyless and authenticated connection models for the bot,
reload persistence, and deletion preserving the
other connection. It captures desktop (1280 px) and mobile (390 px) screenshots
and checks horizontal overflow.

Evidence is retained under `.omb-scratch/verify-evidence/openai-connections/`:
`ui-result.json`, screenshots, a redacted request list (no credential values),
and the isolated server log path. A successful catalog check does not prove
authentication or model response. The response test explicitly warns about
possible charges in the production UI.

For manual inspection, launch with `--interactive`, then open the printed
`previewUrl` and use the printed `providerBase`, `fixture/shared-model`, and any
synthetic key. Ctrl-C stops the owned fixture and removes its temporary home.
Set `OMB_VERIFY_ELECTRON` only to an existing Electron executable if the repo's
Electron binary is unavailable.

```sh
pnpm exec vitest run src/components/OpenAIConnections.test.ts src/components/ModelPicker.test.ts src/components/SettingsModal.i18n.test.ts
# Run the full Settings regression when a pinned agent-browser resolves.
pnpm exec vitest run scripts/testing/control-omb-ui.e2e.test.ts -t 'named connection'
pnpm i18n:check
pnpm build
```

This fixture validates browser HTTP persistence and the rendered workflow.
Desktop secret storage and two bots' actual model routing are covered by the
separate credential and server integration checks.

```sh
pnpm exec vitest run server/openai-connections-flow.test.ts server/openai-connections.test.ts server/openai-connections-config.test.ts server/openai-connection-secrets.test.ts electron/workspace-credentials.test.mjs
node --test electron/openai-connection-main.node-test.mjs
```

The server flow verifies two simultaneous bots using the same model ID at
different endpoints, rotating one key while the other request stays active,
busy edits and referenced deletions being rejected, and bot/thread selections
surviving an actual fixture restart. Credential tests verify encrypted-store
handoff with a fake store; they do not exercise the operating system keychain.
Each encrypted key is bound to its connection ID and normalized endpoint so a
partial write cannot combine a key with a different endpoint after restart.

Existing global settings continue to serve legacy instances. Editing the
original `openaiCompat` connection makes it explicit while keeping its ID and
bot references; its reserved entry remains available for compatibility. New
connections never inherit the global key, URL, model or upstream routing.
Browser/headless servers use their owner-only configuration file; the packaged
desktop uses its OS credential store. Moving an existing connection into that
store requires entering its key once. Backups continue excluding connections;
restored bots with missing instance IDs require an explicit connection choice.
