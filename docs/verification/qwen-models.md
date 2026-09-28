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
but unchanged selection must not send a prompt.

The synthetic CLI also reproduces Qwen's live-session cache: `session/load`
acknowledges the request while retaining the original MCP credentials. The
fixture calls the real agents proxy's `list_bots` and `session_search` tools on
three turns, covering a new conversation and two resumed turns. OMB rotates
the agents bearer every turn, so Qwen must close the previous child and resume
the saved conversation in a fresh process before prompting. The pid changes
each turn; the aggregate RPC log contains three `initialize`, one `session/new`,
two `session/load`, and three `session/prompt` calls. Each process confirms the
selected endpoint before its prompt, and every completed turn's credentials
must return HTTP 401 afterward. The ACP unit checks separately retain process
reuse when Qwen's MCP configuration is unchanged and same-process reloads for
engines that support them. JSON includes resulting messages and the
launcher's persistent log path. The server and temporary home are cleaned up
on completion. This proves OMB's integration contract, not real provider auth
or a paid model response.

Last exercised: 2026-09-26, isolated macOS fixture. Before the fix, turn two
reused the first pid and its real agents proxy returned `unauthorized`. After
the fix, all three turns settled with six successful roster calls, three
history searches, three process ids, and six HTTP 401 checks against revoked
credentials. The alternate-provider, alternate-endpoint, and rejected-switch
checks also passed. No live provider or user workspace was used.

Route identity follows Qwen Code's
[ACP model utility](https://github.com/QwenLM/qwen-code/blob/main/packages/cli/src/utils/acpModelUtils.ts)
and [model registry](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/models/modelRegistry.ts).
Invalid or indistinguishable routes fail explicitly rather than using a saved
provider. Legacy bare model IDs resolve only when exactly one configured route
matches. Live local models replace only the matching endpoint, not cloud models
with the same name.
