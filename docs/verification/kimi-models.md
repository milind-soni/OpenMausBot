# Kimi model selection

Kimi Code 2.5.3 accepts a global `-m` argument, but its ACP `session/new`
can still select the CLI's configured default. OpenMausBot selects the
`model` session config option after creating or restoring a session and
requires the returned value to match before sending a prompt. A rejected
or unconfirmed switch fails the turn instead of using another provider.

This applies to subscription models, configured Platform API models and
local model aliases. It does not change the CLI's saved default or credentials.
The CLI must support the ACP `model` config option; an unsupported switch
fails before sending a prompt.

Run the offline checks:

```sh
pnpm exec vitest run server/drivers/acp/kimi-model-selection.test.ts server/drivers/acp/kimi-device-auth.test.ts server/drivers/local-inject.test.ts server/drivers/acp/approval-matrix.test.ts server/drivers/acp/acp.test.ts
node --experimental-strip-types scripts/verify-kimi-models.ts
pnpm exec tsc -p tsconfig.server.json --noEmit
```

The driver tests use disposable homes and the repository's fake ACP CLI.
They verify selection before a prompt for new and restored sessions, the
actual provider used at prompt time, and no prompt after a rejected or
unconfirmed selection. The verification script launches an isolated harness
server and sends a chat through the standard control surface, covering both
successful selection and a CLI that acknowledges but ignores the switch.
It prints the server log path and RPC order, then closes the fixture.

These checks do not call Moonshot, use real credentials, verify API billing,
or prove a packaged desktop build has loaded the change.
