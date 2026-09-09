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
pnpm exec vitest run server/drivers/acp/qwen-catalog.test.ts server/drivers/local-inject.test.ts server/drivers/local-inject-matrix.test.ts server/drivers/acp/acp.test.ts
node --experimental-strip-types scripts/verify-qwen-models.ts
```

The script owns a disposable server through the standard launcher, installs a
synthetic Qwen CLI only in that temporary home, selects another provider and
another endpoint, and verifies the ACP calls precede the prompt. An acknowledged
but unchanged selection must not send a prompt. JSON includes resulting messages
and the launcher's persistent log path. The server and temporary home are cleaned
up on completion. This proves OMB's integration contract, not real provider auth
or a paid model response.

Route identity follows Qwen Code's
[ACP model utility](https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/utils/acpModelUtils.ts)
and [model registry](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/models/modelRegistry.ts).
Invalid or indistinguishable routes fail explicitly rather than using a saved
provider. Legacy bare model IDs resolve only when exactly one configured route
matches. Live local models replace only the matching endpoint, not cloud models
with the same name.
