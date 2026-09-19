# Qwen model selection

The Qwen picker reads configured chat routes from the server user's
`.qwen/settings.json`. It preserves protocol and endpoint identity; no endpoint,
credential, or environment-key name is exposed in the public model catalog.

OMB uses Qwen's native ACP model selector and requires the CLI to confirm the
selected route before sending the prompt. It does not pass a bare `-m` argument,
which would retain the saved provider. This requires a Qwen Code version that
supports `session/set_config_option` for `model`. Unsupported versions fail before
prompting; update Qwen Code using its official installer and refresh models.

Offline verification (no provider login or paid calls):

```sh
pnpm exec vitest run server/drivers/acp/qwen-catalog.test.ts server/drivers/local-inject.test.ts server/drivers/local-inject-matrix.test.ts server/drivers/acp/acp.test.ts server/drivers/acp/approval-matrix.test.ts server/drivers/acp/opencode-go.test.ts
node --experimental-strip-types scripts/verify-qwen-models.ts
```

The script owns a disposable server through the standard launcher, installs a
synthetic Qwen CLI only in that temporary home, selects another provider and
another endpoint, and verifies the ACP calls precede the prompt. An acknowledged
but unchanged selection must not send a prompt. A second turn on the same
thread must ride the same agent process — the synthetic CLI reports its pid and
RPC log, so the check pins one `initialize`, one `session/new`, one
`session/load` (the harness rotates the agents bearer token every turn, so the
second turn re-establishes the native session with fresh credentials on the
same process), and two `session/prompt` calls. When the pooled agent refuses
`session/load` of its own live session, OMB closes the child and pays the
handshake once on a fresh process, then loads the conversation there: the pid
must change, `initialize` is two, `session/new` stays at one (first turn only),
`session/load` is two (the refused call plus the successful replacement), and
`session/prompt` remains two. JSON includes resulting messages and the
launcher's persistent log path. The server and temporary home are cleaned up
on completion. This proves OMB's integration contract, not real provider auth
or a paid model response.

Route identity follows Qwen Code's
[ACP model utility](https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/utils/acpModelUtils.ts)
and [model registry](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/models/modelRegistry.ts).
Invalid or indistinguishable routes fail explicitly rather than using a saved
provider. Legacy bare model IDs resolve only when exactly one configured route
matches. Live local models replace only the matching endpoint, not cloud models
with the same name.
