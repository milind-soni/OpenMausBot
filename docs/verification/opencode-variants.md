# OpenCode reasoning choices

The optional functional test launches the real OpenMausBot server, its OpenCode
ACP driver, an explicitly supplied OpenCode binary, and an owned loopback
Responses endpoint. All homes, configs, models, conversations and credentials
are disposable. The test never discovers a CLI from the user's PATH or sends a
prompt to a real model provider.

Supply an absolute path to an independently verified OpenCode 1.18.31 binary:

```sh
OMB_OPENCODE_E2E_CLI=/absolute/path/to/opencode pnpm exec vitest run server/opencode-variants.e2e.test.ts
```

Without `OMB_OPENCODE_E2E_CLI`, Vitest reports this test as skipped. A skip does
not verify the feature. The test performs no dependency installation or binary
download. OpenCode 1.18.31 is required because this recipe exercises its ACP
`default` effort option, which removes the explicit session variant override.
Model, agent or provider configuration can still supply an inherited reasoning
value. Omission at the HTTP boundary is proved here only for this synthetic
fixture, which has no inherited effort options.

The synthetic model advertises `minimal`, `low`, `medium`, `high` and `xhigh`.
The checks require OpenMausBot to retain this catalog metadata, advertise its
variant capability, save different choices for two conversations on one bot,
and forward each choice through its actual runtime and ACP driver. One
conversation uses `low`; its sibling explicitly uses `default`. In this fixture, captured HTTP
requests must contain `reasoning.effort: "low"` for the first and omit the
effort for the second. The provider encodes the received effort in its reply,
and the test checks the conversation's final answer so an auxiliary native
request cannot satisfy the main-turn assertion. Both conversations are sent again after restarting the
OpenMausBot server with the same disposable data directory.

Evidence is written alongside the retained server log as
`*.opencode-variants.json`. It records control actions, asserted selections,
and sanitized request receipts: synthetic marker, model, endpoint and effort.
It does not retain full provider request bodies, authorization headers or MCP
tokens. The fixture closes its own children and loopback server, then removes
its disposable home. The log and evidence paths are printed by the test.

This proves API persistence and actual OMB → ACP → OpenCode → SDK transport
against a simulated provider. It does not establish acceptance by any real
provider, an upstream gateway's routing, or the OpenMausBot GUI. The fixture
rejects `none` at its simulated provider as a guard; real model capabilities
must still govern whether `none` is a valid choice. Renderer accessibility,
profile and conversation selectors, stale response isolation, and the absence
of effects on sibling conversations must also be checked with the isolated
[chat UI workflow](chat-ui.md) before claiming the GUI is verified.

## OpenCode 2 and GitHub Copilot models

OpenCode 2 rejects `models --verbose`, so a model's effort levels reach the
catalog only from its ACP session: discovery selects each model once on a
throwaway session and keeps the `effort` choices OpenCode then names. This
optional test checks that path end to end with an explicitly supplied
OpenCode 2.1.4 binary (`@opencode/cli`) and a loopback stand-in for the Copilot
API:

```sh
OMB_OPENCODE2_E2E_CLI=/absolute/path/to/opencode pnpm exec vitest run server/opencode-copilot-efforts.e2e.test.ts
```

The test imports a synthetic Copilot credential whose `apiEndpoint` is the
loopback server, so no GitHub account is involved. The stand-in's `/models`
offers a Responses model with an effort list, a Messages model with adaptive
thinking, and a chat model with neither. The checks require `/api/instances`
to offer `low`…`xhigh` and `default` for the first, `low`…`high` and `default`
for the second and nothing for the third, then send four turns in one
conversation: `high`, then `low` (a switch mid-conversation), then the Messages
model at `medium`, then the plain model. The stand-in must receive
`reasoning.effort`, then `output_config.effort`, with each value, and no effort
for the last; each answer echoes the effort it received. Evidence is written
beside the server log as `*.opencode-copilot-efforts.json`.

This proves the catalog and the turn transport against OpenCode's own Copilot
code and a simulated API. It does not prove which efforts a real Copilot
account lists for each model; OpenCode reads those from Copilot's `/models`.

## An unavailable engine returns without variant support

```sh
pnpm exec vitest run server/model-variant-return.e2e.test.ts
```

This permanent, non-opt-in regression uses the shared fake-Claude launcher.
It saves a variant through the HTTP API while the selected instance is
unavailable, stops its owned server, adds a synthetic returning instance with
no variant support, and restarts the same disposable data directory.

The direct conversation must reject the next turn with HTTP 409. A group
selecting that bot must record an actionable failed activity. Neither path
may start the fake provider prompt. The retained
`*.model-variant-return.json` contains the refusal and group activity. This
checks the actual dispatch guards, not only the shared validation helper.

## Renderer verification

The real renderer was exercised against a disposable server and scripted ACP
engine. Selecting `minimal`, supported `none`, clearing the selection, and
selecting session-advertised `default` persisted only on the chosen thread.
A reload kept the saved `default` without falsely declaring it unavailable.
The profile control preserved the existing profile behavior: update the bot
default and selected idle thread, while leaving its sibling thread unchanged.
No browser console errors were observed.

The before screenshots use upstream `82d277ae`; all names and model data are
synthetic. These images establish renderer behavior, not provider acceptance.

| Control | Before | After |
| --- | --- | --- |
| Conversation | ![Conversation before](evidence/opencode-variants/conversation-before.png) | ![Conversation after](evidence/opencode-variants/conversation-after.png) |
| Profile | ![Profile before](evidence/opencode-variants/profile-before.png) | ![Profile after](evidence/opencode-variants/profile-after.png) |
